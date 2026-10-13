#!/usr/bin/env node

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    AUTOSTART_FILE,
    ensureServiceToken,
    getEndpoint,
    installAutostart,
    PID_FILE,
    runService,
    SERVICE_SWITCH_PROTOCOL,
    ServiceRequest,
    ServiceResponse,
    startDetachedService,
    uninstallAutostart,
} from './service';
import {
    assertManagedVersionCompatible,
    getManagedHostEnvironment,
    getScmRestoreFile,
    getWindowsScmStatus,
    getWindowsServiceInstallation,
    startWindowsUserAgent,
    stopWindowsService,
    WindowsServiceInstallation,
    ManagedHostEnvironment,
} from './windowsService';
import {
    assertInstallationSafeToStart,
    assertNoUpdateInProgress,
    assertUpdatableInstallation,
    checkForUpdate,
    compareVersions,
    getCurrentVersion,
    installLatestUpdate,
    UpdateCheckResult,
    UpdateInstallOptions,
    UpdateInstallResult,
    UpdateInstallError,
    UpdateLock,
    UpdateRuntime,
    withServiceStartupGate,
    withUpdateLock,
} from './update';

const argv = process.argv.slice(2);
const UPDATE_RESTORE_CAPABILITY_ENV = 'ANTI_QUOTA_UPDATE_RESTORE_CAPABILITY';
const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    inverse: '\x1b[7m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

function hasFlag(flag: string): boolean {
    return argv.includes(flag);
}

function request(
    command: string,
    args: Record<string, unknown> = {},
    timeout = 120000,
    signal?: AbortSignal
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createCancellationError());
            return;
        }
        const socket = net.createConnection(getEndpoint());
        let output = '';
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancelRequest);
            callback();
        };
        const cancelRequest = () => {
            socket.destroy();
            finish(() => reject(createCancellationError()));
        };
        const timer = setTimeout(() => {
            socket.destroy();
            finish(() => reject(new Error('Anti Quota 服务响应超时')));
        }, timeout);
        signal?.addEventListener('abort', cancelRequest, { once: true });
        socket.setEncoding('utf-8');
        socket.on('connect', () => {
            const payload: ServiceRequest = { token: ensureServiceToken(), command, args };
            socket.write(`${JSON.stringify(payload)}\n`);
        });
        socket.on('data', chunk => output += chunk);
        socket.on('end', () => {
            try {
                const response = JSON.parse(output.trim()) as ServiceResponse;
                if (!response.ok) finish(() => reject(new Error(response.error || '服务请求失败')));
                else finish(() => resolve(response.data));
            } catch (error) {
                finish(() => reject(error));
            }
        });
        socket.on('error', error => {
            finish(() => reject(error));
        });
        socket.on('close', () => {
            finish(() => reject(new Error('Anti Quota 服务连接已关闭')));
        });
    });
}

function createCancellationError(): Error {
    const error = new Error('操作已取消');
    error.name = 'AbortError';
    return error;
}

const STOPPED_SERVICE_INFO: RunningServiceInfo = {
    running: false,
    version: null,
    pid: null,
    switchProtocol: null,
};

function endpointAcceptsConnections(timeoutMs: number = 500): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(getEndpoint());
        let settled = false;
        const finish = (connected: boolean, error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else resolve(connected);
        };
        const timer = setTimeout(() => finish(false, new Error('Anti Quota 服务端点探测超时')), timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('error', error => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ECONNREFUSED') {
                finish(false);
                return;
            }
            finish(false, new Error(
                `Anti Quota 服务端点状态无法安全确认: ${code || error.message}`
            ));
        });
    });
}

export interface UpdateServiceProbeDependencies {
    ping: () => Promise<void>;
    endpointConnects: () => Promise<boolean>;
    getLiveServicePid: () => number | null;
}

export function getLiveServicePid(
    pidFile: string = PID_FILE,
    processAlive: (pid: number) => boolean = isProcessAlive
): number | null {
    let raw: string;
    try {
        raw = fs.readFileSync(pidFile, 'utf8').trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(
            `无法读取 Anti Quota 服务 PID 文件，已拒绝继续: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error('Anti Quota 服务 PID 文件损坏，已拒绝继续');
    }
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('Anti Quota 服务 PID 文件损坏，已拒绝继续');
    }
    return processAlive(pid) ? pid : null;
}

/** 更新前严格探测服务；端点可连接时不能把认证或协议错误当作服务不存在。 */
export async function probeRunningServiceForUpdate(
    overrides: Partial<UpdateServiceProbeDependencies> = {}
): Promise<boolean> {
    const dependencies: UpdateServiceProbeDependencies = {
        ping: async () => { await request('ping', {}, 1500); },
        endpointConnects: () => endpointAcceptsConnections(),
        getLiveServicePid,
        ...overrides,
    };
    try {
        await dependencies.ping();
        return true;
    } catch (error) {
        let endpointConnected: boolean;
        try {
            endpointConnected = await dependencies.endpointConnects();
        } catch (endpointError) {
            const reason = endpointError instanceof Error ? endpointError.message : String(endpointError);
            throw new Error(`Anti Quota 服务端点状态无法安全确认，已取消更新。${reason}`);
        }
        if (!endpointConnected) {
            const livePid = dependencies.getLiveServicePid();
            if (livePid !== null) {
                throw new Error(`Anti Quota 服务 PID ${livePid} 仍在运行，但端点不可达，已拒绝继续`);
            }
            return false;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            'Anti Quota 服务端点仍可连接，但 ping 认证或协议校验失败，已取消更新。'
            + '这通常表示旧服务仍在运行或 service-token 不一致；请先结束旧 Anti Quota 服务进程，'
            + `再运行 anti-quota service start 后重试。原始错误: ${reason}`
        );
    }
}

export interface RunningServiceInfo {
    running: boolean;
    version: string | null;
    pid: number | null;
    switchProtocol: string | null;
}

function parseRunningServiceInfo(value: unknown): RunningServiceInfo {
    const payload = value as {
        version?: unknown;
        pid?: unknown;
        switchProtocol?: unknown;
    } | null;
    return {
        running: true,
        version: typeof payload?.version === 'string' ? payload.version : null,
        pid: typeof payload?.pid === 'number' ? payload.pid : null,
        switchProtocol: typeof payload?.switchProtocol === 'string' ? payload.switchProtocol : null,
    };
}

async function requestRunningServiceInfo(timeoutMs: number): Promise<RunningServiceInfo> {
    return parseRunningServiceInfo(await request('ping', {}, timeoutMs));
}

async function getRunningServiceInfo(timeoutMs: number = 1500): Promise<RunningServiceInfo> {
    try {
        return await requestRunningServiceInfo(timeoutMs);
    } catch {
        return { ...STOPPED_SERVICE_INFO };
    }
}

export interface StrictServiceInfoDependencies {
    requestInfo: (timeoutMs: number) => Promise<RunningServiceInfo>;
    endpointConnects: (timeoutMs: number) => Promise<boolean>;
    getLiveServicePid: () => number | null;
    now: () => number;
}

/**
 * Read service identity without collapsing an occupied-but-unresponsive endpoint into "stopped".
 * The timeout is a wall-clock budget shared by ping and the endpoint fallback.
 */
export async function getRunningServiceInfoStrict(
    timeoutMs: number = 1500,
    overrides: Partial<StrictServiceInfoDependencies> = {}
): Promise<RunningServiceInfo> {
    const dependencies: StrictServiceInfoDependencies = {
        requestInfo: requestRunningServiceInfo,
        endpointConnects: endpointAcceptsConnections,
        getLiveServicePid,
        now: () => Date.now(),
        ...overrides,
    };
    const budget = Math.max(1, timeoutMs);
    const deadline = dependencies.now() + budget;
    let pingError: unknown;
    try {
        const remaining = Math.max(1, deadline - dependencies.now());
        return await dependencies.requestInfo(Math.min(remaining, 250));
    } catch (error) {
        pingError = error;
    }

    const remaining = deadline - dependencies.now();
    if (remaining > 0) {
        try {
            if (!await dependencies.endpointConnects(Math.min(remaining, 250))) {
                const livePid = dependencies.getLiveServicePid();
                if (livePid !== null) {
                    throw new Error(
                        `Anti Quota 服务 PID ${livePid} 仍在运行，但端点不可达，已拒绝继续`
                    );
                }
                return { ...STOPPED_SERVICE_INFO };
            }
        } catch (endpointError) {
            const reason = endpointError instanceof Error ? endpointError.message : String(endpointError);
            throw new Error(`Anti Quota 服务端点状态无法安全确认。${reason}`);
        }
    }
    const reason = pingError instanceof Error ? pingError.message : String(pingError);
    throw new Error(
        'Anti Quota 服务端点仍被占用或状态无法安全确认，但 ping 认证或协议校验失败。'
        + '请先结束旧 Anti Quota 服务进程，再运行 anti-quota service start 后重试。'
        + `原始错误: ${reason}`
    );
}

export interface ServiceMutationOptions {
    /** 更新事务持有的能力对象；仅供同一事务内停止或恢复服务。 */
    updateLock?: UpdateLock;
}

export interface EnsureRunningDependencies {
    assertMutationAllowed: (options: ServiceMutationOptions) => void;
    assertInstallationSafe: (stateDirectory?: string) => void;
    assertManagedVersionCompatible: (expectedVersion: string) => void;
    getExpectedVersion: () => string;
    getServiceInfo: (timeoutMs?: number) => Promise<RunningServiceInfo>;
    compareVersions: (left: string, right: string) => -1 | 0 | 1;
    stopService: (
        options: ServiceMutationOptions,
        expectedService: RunningServiceInfo
    ) => Promise<boolean | void>;
    startService: (options: ServiceMutationOptions) => void;
    delay: (milliseconds: number) => Promise<void>;
    now: () => number;
    startupTimeoutMs: number;
}

export function isServiceVersionCompatible(
    service: RunningServiceInfo,
    expectedVersion: string,
    compare: (left: string, right: string) => -1 | 0 | 1 = compareVersions
): boolean {
    return service.running
        && typeof service.version === 'string'
        && isServiceSwitchProtocolCompatible(service.switchProtocol)
        && compare(service.version.replace(/^v/, ''), expectedVersion.replace(/^v/, '')) === 0;
}

export function isServiceSwitchProtocolCompatible(protocol: string | null): boolean {
    const expected = /^authoritative-keyring-v(\d+)$/.exec(SERVICE_SWITCH_PROTOCOL);
    const actual = typeof protocol === 'string'
        ? /^authoritative-keyring-v(\d+)$/.exec(protocol)
        : null;
    if (!expected || !actual) return false;
    return Number(actual[1]) >= Number(expected[1]);
}

function assertServiceCanBeStopped(service: RunningServiceInfo): asserts service is RunningServiceInfo & { pid: number } {
    if (!Number.isSafeInteger(service.pid) || Number(service.pid) <= 0) {
        throw new Error('后台服务未报告可信 PID，已拒绝自动停止；请手动结束旧服务后重试');
    }
}

function assertServiceVersionKnown(service: RunningServiceInfo): asserts service is RunningServiceInfo & { version: string } {
    if (typeof service.version !== 'string' || !service.version.trim()) {
        throw new Error('后台服务未报告可信版本，已拒绝自动停止；请手动结束旧服务后重试');
    }
}

interface UpdateLockPayload {
    pid: number;
    token: string;
}

interface UpdateRestoreCapability extends UpdateLockPayload {
    stateDirectory: string;
}

interface ServiceRunGuardRuntime {
    restoreCapability?: string;
    parentPid?: number;
    stateDirectory?: string;
    assertInstallationSafe?: () => void;
    assertNoUpdate?: () => void;
    getManagedHostEnvironment?: () => ManagedHostEnvironment | null;
    scmRestoreFile?: string;
    isProcessAlive?: (pid: number) => boolean;
}

function defaultUpdateStateDirectory(): string {
    return path.resolve(path.join(os.homedir(), '.anti-quota'));
}

function readUpdateLockPayload(stateDirectory: string): UpdateLockPayload {
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'update.lock'), 'utf8'));
    } catch {
        throw new Error('更新事务服务恢复凭证无效或已经释放');
    }
    const payload = value as Partial<UpdateLockPayload> | null;
    if (!payload || !Number.isSafeInteger(payload.pid) || Number(payload.pid) <= 0
        || typeof payload.token !== 'string' || !/^[a-f0-9]{32}$/i.test(payload.token)) {
        throw new Error('更新事务服务恢复凭证无效或已经释放');
    }
    return { pid: Number(payload.pid), token: payload.token };
}

/** 为更新事务派生出的服务进程创建与当前 update.lock 绑定的短期能力。 */
export function createUpdateRestoreCapability(updateLock: UpdateLock): string {
    const stateDirectory = path.resolve(updateLock.stateDirectory);
    const payload = readUpdateLockPayload(stateDirectory);
    if (payload.pid !== process.pid) {
        throw new Error('更新事务服务恢复凭证不属于当前进程');
    }
    return JSON.stringify({ ...payload, stateDirectory } satisfies UpdateRestoreCapability);
}

/**
 * service run（包括登录自启入口）必须在载入服务前检查更新锁。
 * 唯一例外是更新锁持有进程直接派生、且能力与锁文件完全匹配的恢复进程。
 */
export function assertServiceRunAllowed(runtime: ServiceRunGuardRuntime = {}): void {
    const stateDirectory = path.resolve(runtime.stateDirectory || defaultUpdateStateDirectory());
    (runtime.assertInstallationSafe
        || (() => assertInstallationSafeToStart({ stateDirectory })))();
    let inheritedCapability = runtime.restoreCapability === undefined
        ? process.env[UPDATE_RESTORE_CAPABILITY_ENV]
        : runtime.restoreCapability;
    if (runtime.restoreCapability === undefined) {
        // 服务进程不应在整个生命周期保留更新锁令牌。
        delete process.env[UPDATE_RESTORE_CAPABILITY_ENV];
    }
    const managed = (runtime.getManagedHostEnvironment || getManagedHostEnvironment)();
    let consumedMarker: string | undefined;
    if (managed) {
        const markerFile = runtime.scmRestoreFile || getScmRestoreFile();
        let rawMarker: string | undefined;
        try {
            rawMarker = fs.readFileSync(markerFile, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error('Windows 服务更新恢复凭证无法读取，已拒绝启动');
            }
        }
        if (rawMarker !== undefined) {
            let marker: { capability?: unknown; serviceName?: unknown; version?: unknown };
            try {
                marker = JSON.parse(rawMarker);
            } catch {
                throw new Error('Windows 服务更新恢复凭证无效，已拒绝启动');
            }
            if (!marker || marker.serviceName !== managed.installation.serviceName
                || marker.version !== managed.installation.version
                || typeof marker.capability !== 'string') {
                throw new Error('Windows 服务更新恢复凭证与受保护安装不匹配，已拒绝启动');
            }
            inheritedCapability = marker.capability;
            consumedMarker = markerFile;
        }
    }
    if (!inheritedCapability) {
        (runtime.assertNoUpdate || (() => assertNoUpdateInProgress({ stateDirectory })))();
        return;
    }

    let capability: Partial<UpdateRestoreCapability> | null;
    try {
        capability = JSON.parse(inheritedCapability) as Partial<UpdateRestoreCapability>;
    } catch {
        throw new Error('更新事务服务恢复凭证无效或已经释放');
    }
    if (!capability || typeof capability !== 'object') {
        throw new Error('更新事务服务恢复凭证无效或已经释放');
    }
    const capabilityDirectory = typeof capability.stateDirectory === 'string'
        ? path.resolve(capability.stateDirectory)
        : '';
    const parentPid = runtime.parentPid ?? process.ppid;
    if (capabilityDirectory !== stateDirectory
        || !Number.isSafeInteger(capability.pid)
        || (!consumedMarker && capability.pid !== parentPid)
        || typeof capability.token !== 'string') {
        throw new Error('更新事务服务恢复凭证无效或已经释放');
    }
    const payload = readUpdateLockPayload(stateDirectory);
    if (payload.pid !== capability.pid || payload.token !== capability.token) {
        throw new Error('更新事务服务恢复凭证无效或已经释放');
    }
    if (consumedMarker) {
        if (!(runtime.isProcessAlive || isProcessAlive)(payload.pid)) {
            throw new Error('Windows 服务更新事务已退出，恢复凭证失效');
        }
        // Only a verified native-host child can consume this one-shot marker.
        // It does not grant arbitrary processes permission to bypass update.lock.
        fs.unlinkSync(consumedMarker);
    }
}

export function assertServiceMutationAllowed(
    options: ServiceMutationOptions = {},
    assertNoUpdate: () => void = assertNoUpdateInProgress
): void {
    if (!options.updateLock) assertNoUpdate();
}

export interface ServiceStartDependencies {
    getManagedInstallation: () => WindowsServiceInstallation | null;
    startManagedAgent: (restoreCapability?: string) => void;
    startDetached: () => void;
}

/** SCM owns managed Windows agents; manual installs retain a temporary fallback. */
export function startServiceForCurrentInstallation(
    options: ServiceMutationOptions = {},
    overrides: Partial<ServiceStartDependencies> = {}
): void {
    const dependencies: ServiceStartDependencies = {
        getManagedInstallation: getWindowsServiceInstallation,
        startManagedAgent: startWindowsUserAgent,
        startDetached: () => startDetachedService(__filename),
        ...overrides,
    };
    if (dependencies.getManagedInstallation()) {
        dependencies.startManagedAgent(options.updateLock
            ? createUpdateRestoreCapability(options.updateLock)
            : undefined);
        return;
    }
    dependencies.startDetached();
}

export async function ensureRunning(
    options: ServiceMutationOptions = {},
    overrides: Partial<EnsureRunningDependencies> = {}
): Promise<void> {
    const dependencies: EnsureRunningDependencies = {
        assertMutationAllowed: value => assertServiceMutationAllowed(value),
        assertInstallationSafe: stateDirectory => assertInstallationSafeToStart({ stateDirectory }),
        assertManagedVersionCompatible,
        getExpectedVersion: getCurrentVersion,
        getServiceInfo: timeoutMs => getRunningServiceInfoStrict(timeoutMs),
        compareVersions,
        stopService: (value, expectedService) => {
            assertServiceCanBeStopped(expectedService);
            return stopRunningService(value, {}, expectedService.pid);
        },
        startService: options => startServiceForCurrentInstallation(options),
        delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
        now: () => Date.now(),
        startupTimeoutMs: 18_000,
        ...overrides,
    };
    dependencies.assertMutationAllowed(options);
    dependencies.assertInstallationSafe(options.updateLock?.stateDirectory);
    const expectedVersion = dependencies.getExpectedVersion();
    // Protected SCM runtime must be upgraded explicitly. Never silently bypass it
    // by spawning a different npm copy in parallel.
    dependencies.assertManagedVersionCompatible(expectedVersion);
    let runningService = await dependencies.getServiceInfo();
    let replacementAttempts = 0;
    while (runningService.running) {
        replacementAttempts += 1;
        if (replacementAttempts > 30) {
            throw new Error('后台服务实例持续变化，已取消自动替换');
        }
        if (isServiceVersionCompatible(runningService, expectedVersion, dependencies.compareVersions)) return;
        assertServiceVersionKnown(runningService);
        if (dependencies.compareVersions(runningService.version, expectedVersion) > 0) {
            throw new Error(
                `后台服务版本 ${runningService.version} 高于当前 CLI ${expectedVersion}；`
                + '请更新 CLI，已保留较新的后台服务'
            );
        }
        assertServiceCanBeStopped(runningService);
        const stopped = await dependencies.stopService(options, runningService);
        if (stopped !== false) break;
        await dependencies.delay(100);
        runningService = await dependencies.getServiceInfo();
    }

    const startCurrentService = () => dependencies.startService(options);
    if (options.updateLock) {
        const previousCapability = process.env[UPDATE_RESTORE_CAPABILITY_ENV];
        process.env[UPDATE_RESTORE_CAPABILITY_ENV] = createUpdateRestoreCapability(options.updateLock);
        try {
            startCurrentService();
        } finally {
            if (previousCapability === undefined) delete process.env[UPDATE_RESTORE_CAPABILITY_ENV];
            else process.env[UPDATE_RESTORE_CAPABILITY_ENV] = previousCapability;
        }
    } else {
        startCurrentService();
    }
    // The child may wait up to 15 seconds for the cross-process startup gate. Keep the
    // entire wait within one wall-clock deadline even when individual pings time out.
    const startupDeadline = dependencies.now() + dependencies.startupTimeoutMs;
    while (dependencies.now() < startupDeadline) {
        const beforeDelay = startupDeadline - dependencies.now();
        await dependencies.delay(Math.min(100, Math.max(1, beforeDelay)));
        const remaining = startupDeadline - dependencies.now();
        if (remaining <= 0) break;
        const startedService = await dependencies.getServiceInfo(Math.min(remaining, 250));
        if (!startedService.running) continue;
        if (isServiceVersionCompatible(startedService, expectedVersion, dependencies.compareVersions)) return;
        assertServiceVersionKnown(startedService);
        if (dependencies.compareVersions(startedService.version, expectedVersion) > 0) {
            throw new Error(
                `后台服务版本 ${startedService.version} 高于当前 CLI ${expectedVersion}；`
                + '请更新 CLI，已保留较新的后台服务'
            );
        }
        assertServiceCanBeStopped(startedService);
        const stopped = await dependencies.stopService(options, startedService);
        if (stopped === false) continue;
        throw new Error(
            `Anti Quota 后台服务版本或切换协议与当前 CLI ${expectedVersion} 不兼容，已停止旧服务`
        );
    }
    throw new Error('无法启动 Anti Quota 本地服务，请运行 anti-quota service logs 查看日志');
}

export interface ServiceRunCommandDependencies {
    withStartupGate: <T>(action: () => Promise<T>) => Promise<T>;
    assertAllowed: () => void;
    getServiceInfo: () => Promise<RunningServiceInfo>;
    runService: () => Promise<void>;
    isManagedAgent: () => boolean;
}

/** service run 的真实命令分支；门禁覆盖安全检查、服务探测和 listen 完成。 */
export async function runServiceCommand(
    overrides: Partial<ServiceRunCommandDependencies> = {}
): Promise<void> {
    const dependencies: ServiceRunCommandDependencies = {
        withStartupGate: action => withServiceStartupGate({}, action),
        assertAllowed: assertServiceRunAllowed,
        getServiceInfo: () => getRunningServiceInfoStrict(),
        runService,
        isManagedAgent: () => getManagedHostEnvironment() !== null,
        ...overrides,
    };
    await dependencies.withStartupGate(async () => {
        dependencies.assertAllowed();
        if ((await dependencies.getServiceInfo()).running) {
            // After host recovery an orphan may still be draining. Non-zero exit
            // asks the new supervisor to retry; exit 0 would permanently pause it.
            if (dependencies.isManagedAgent()) throw new Error('旧用户代理尚未退出，Windows 服务将稍后重试');
            return;
        }
        await dependencies.runService();
    });
}

export interface StopRunningServiceDependencies {
    probe: (pingTimeoutMs: number) => Promise<boolean>;
    getServiceInfo: (pingTimeoutMs: number) => Promise<RunningServiceInfo>;
    requestStop: (expectedPid?: number) => Promise<unknown>;
    delay: (milliseconds: number) => Promise<void>;
    isProcessAlive: (pid: number) => boolean;
    now: () => number;
    stopTimeoutMs: number;
}

export function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

/** 更新期间严格停止旧服务；端点仍可连接时绝不能继续替换全局安装。 */
export async function stopRunningService(
    options: ServiceMutationOptions = {},
    overrides: Partial<StopRunningServiceDependencies> = {},
    expectedPid?: number
): Promise<boolean> {
    assertServiceMutationAllowed(options);
    const dependencies: StopRunningServiceDependencies = {
        probe: timeoutMs => probeRunningServiceForUpdate({
            ping: async () => { await request('ping', {}, timeoutMs); },
            endpointConnects: () => endpointAcceptsConnections(timeoutMs),
            // stopRunningService owns the expected PID and waits for that exact process
            // below; the generic PID-file guard would otherwise abort normal draining.
            getLiveServicePid: () => null,
        }),
        getServiceInfo: timeoutMs => getRunningServiceInfo(timeoutMs),
        requestStop: pid => request('stop', pid ? { expectedPid: pid } : {}, 5000),
        delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
        isProcessAlive,
        now: () => Date.now(),
        // OAuth may legitimately remain active for five minutes. Credential writes must
        // finish atomically before an update is allowed to replace this process.
        stopTimeoutMs: 5 * 60_000 + 30_000,
        ...overrides,
    };
    const initiallyReachable = await dependencies.probe(500);
    if (!initiallyReachable) {
        if (!expectedPid || !dependencies.isProcessAlive(expectedPid)) return true;
    } else {
        try {
            const result = await dependencies.requestStop(expectedPid) as { stopping?: unknown } | undefined;
            if (result?.stopping === false) return false;
        } catch (error) {
            // stop 响应与进程退出可能同时发生。绑定 PID 的自动操作还必须
            // 等目标进程真正退出，不能只凭端点消失宣告成功。
            if (await dependencies.probe(250)) throw error;
            if (!expectedPid || !dependencies.isProcessAlive(expectedPid)) return true;
        }
    }
    const deadline = dependencies.now() + dependencies.stopTimeoutMs;
    while (dependencies.now() < deadline) {
        const beforeDelay = deadline - dependencies.now();
        await dependencies.delay(Math.min(100, Math.max(1, beforeDelay)));
        const remaining = deadline - dependencies.now();
        if (remaining <= 0) break;
        const probeTimeout = Math.min(remaining, 250);
        if (expectedPid) {
            const current = await dependencies.getServiceInfo(probeTimeout);
            if (!current.running) {
                // A failed/slow authenticated ping is not proof of process exit. The strict
                // endpoint probe either confirms disappearance or fails closed.
                if (!await dependencies.probe(probeTimeout)
                    && !dependencies.isProcessAlive(expectedPid)) return true;
                continue;
            }
            if (current.pid !== expectedPid) return false;
            continue;
        }
        if (!await dependencies.probe(probeTimeout)) return true;
    }
    throw new Error('等待旧版 Anti Quota 服务退出超时，已取消更新');
}

function formatAccount(account: any, index?: number): string {
    const prefix = typeof index === 'number' ? `${index + 1}. ` : '';
    const current = account.current ? ' *' : '';
    const disabled = account.disabled ? ' [禁用]' : '';
    const lines = [`${prefix}${String(account.email).replace(/@gmail\.com$/i, '')}${current}${disabled}`];
    for (const model of account.quota?.models || []) {
        const weekly = typeof model.weekly === 'number' && model.name.startsWith('gemini') ? ` / 周 ${model.weekly}%` : '';
        lines.push(`   ${model.displayName}: 5小时 ${model.fiveHour}%${weekly}`);
    }
    return lines.join('\n');
}

function shortEmail(email: unknown): string {
    return String(email || '').replace(/@gmail\.com$/i, '');
}

function quotaColor(percentage: number): string {
    if (percentage < 10) return ANSI.red;
    if (percentage < 50) return ANSI.yellow;
    return ANSI.green;
}

export function getAccountApplyBlockReason(account: any): 'missing' | 'disabled' | null {
    if (!account) return 'missing';
    if (account.disabled) return 'disabled';
    return null;
}

export function assertSwitchConfirmed(account: any, expectedAccountId?: string): void {
    if (!account || account.current !== true) {
        throw new Error('后台服务未确认 agy 当前账号，已拒绝显示切换成功');
    }
    if (expectedAccountId && account.id !== expectedAccountId) {
        throw new Error('后台服务确认的 agy 当前账号与所选目标不一致，已拒绝显示切换成功');
    }
}

export function assertUniqueCurrentAccount(accounts: any[], expectedAccountId: string): any {
    const currentAccounts = Array.isArray(accounts)
        ? accounts.filter(account => account?.current === true)
        : [];
    if (currentAccounts.length === 0) {
        throw new Error('刷新后未检测到 agy 当前账号，已拒绝显示切换成功');
    }
    if (currentAccounts.length > 1) {
        throw new Error('刷新后检测到多个 agy 当前账号，已拒绝显示切换成功');
    }
    assertSwitchConfirmed(currentAccounts[0], expectedAccountId);
    return currentAccounts[0];
}

function formatResetTime(isoTime?: string): string {
    if (!isoTime) return '';
    const diff = new Date(isoTime).getTime() - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return '';
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function padDisplayWidth(value: string, targetWidth: number): string {
    const width = Array.from(value).reduce((total, char) => total + (char.charCodeAt(0) > 0x7f ? 2 : 1), 0);
    return value + ' '.repeat(Math.max(1, targetWidth - width));
}

function formatQuotaLine(label: string, percentage: number, resetTime?: string): string {
    const reset = formatResetTime(resetTime);
    return `     ${padDisplayWidth(label, 26)}${quotaColor(percentage)}${String(percentage).padStart(3)}%${ANSI.reset}${reset ? `  ${ANSI.dim}R: ${reset}${ANSI.reset}` : ''}`;
}

function renderMenu(accounts: any[], selectedIndex: number, message = ''): void {
    const current = accounts.find(account => account.current);
    const width = Math.max(54, Math.min(process.stdout.columns || 80, 96));
    const divider = '─'.repeat(width);
    const lines: string[] = [
        `${ANSI.bold}${ANSI.cyan}Anti Quota${ANSI.reset}  ${ANSI.dim}agy 账号快速切换${ANSI.reset}`,
        `当前 agy：${current ? `${ANSI.green}${shortEmail(current.email)}${ANSI.reset}` : `${ANSI.yellow}未识别${ANSI.reset}`}    已绑定：${accounts.length} 个账号`,
        divider,
    ];

    if (accounts.length === 0) {
        lines.push('', `${ANSI.yellow}暂无账号，请按 B 绑定 Google 账号，或按 I 导入当前 agy 账号。${ANSI.reset}`, '');
    } else {
        // 每个完整账号卡片最多约 6 行，只渲染终端高度能容纳的范围并随选择滚动。
        const maxVisible = Math.max(1, Math.floor(((process.stdout.rows || 30) - 7) / 6));
        const startIndex = Math.min(
            Math.max(0, selectedIndex - Math.floor(maxVisible / 2)),
            Math.max(0, accounts.length - maxVisible)
        );
        const visibleAccounts = accounts.slice(startIndex, startIndex + maxVisible);
        if (accounts.length > visibleAccounts.length) {
            lines.push(`${ANSI.dim}账号 ${startIndex + 1}-${startIndex + visibleAccounts.length} / ${accounts.length}${ANSI.reset}`);
        }
        visibleAccounts.forEach((account, visibleIndex) => {
            const index = startIndex + visibleIndex;
            const selected = index === selectedIndex;
            const marker = selected ? '›' : ' ';
            const currentBadge = account.current ? ` ${ANSI.green}[当前]${ANSI.reset}` : '';
            const disabledBadge = account.disabled ? ` ${ANSI.yellow}[禁用]${ANSI.reset}` : '';
            const title = `${marker} ${index + 1}. ${shortEmail(account.email)}${currentBadge}${disabledBadge}`;
            lines.push(selected ? `${ANSI.inverse}${title}${ANSI.reset}` : title);

            const models = account.quota?.models || [];
            if (!models.length) {
                lines.push(`     ${ANSI.dim}${account.quota?.forbidden ? '无权限（403）' : '尚未获取配额，按 R 刷新'}${ANSI.reset}`);
            } else {
                for (const model of models) {
                    lines.push(formatQuotaLine(`${model.displayName} 5小时`, model.fiveHour, model.fiveHourReset));
                }
                const gemini = models.find((model: any) => model.name === 'gemini-pro' || model.name === 'gemini-flash');
                if (typeof gemini?.weekly === 'number') {
                    lines.push(formatQuotaLine('Gemini 周额度', gemini.weekly, gemini.weeklyReset));
                }
            }
            lines.push('');
        });
    }

    lines.push(divider);
    lines.push(`${ANSI.bold}↑/↓${ANSI.reset} 选择  ${ANSI.bold}Enter${ANSI.reset} 切换  ${ANSI.bold}R${ANSI.reset} 刷新  ${ANSI.bold}G${ANSI.reset} 推荐  ${ANSI.bold}B${ANSI.reset} 绑定  ${ANSI.bold}I${ANSI.reset} 导入  ${ANSI.bold}Q${ANSI.reset} 退出`);
    if (message) lines.push(`${ANSI.cyan}${message}${ANSI.reset}`);

    process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}`);
}

function readKey(): Promise<string> {
    return new Promise(resolve => process.stdin.once('data', data => resolve(data.toString('utf-8'))));
}

/** 在菜单的长操作期间继续响应 Esc/Ctrl+C，避免终端看起来卡死。 */
async function requestWithMenuCancellation(
    command: string,
    args: Record<string, unknown>,
    timeout: number
): Promise<unknown> {
    const controller = new AbortController();
    const onKey = (data: Buffer | string) => {
        const key = data.toString();
        if (key === '\u0003' || key === '\u001b') controller.abort();
    };
    process.stdin.on('data', onKey);
    try {
        return await request(command, args, timeout, controller.signal);
    } finally {
        process.stdin.off('data', onKey);
    }
}

async function runInteractiveMenu(): Promise<void> {
    await ensureRunning();

    // 管道或重定向环境不支持方向键，退化为普通列表输出。
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
        const accounts = await request('list') as any[];
        console.log(accounts.length ? accounts.map(formatAccount).join('\n') : '暂无账号，请运行 anti bind');
        return;
    }

    let accounts = await request('list') as any[];
    let selectedIndex = Math.max(0, accounts.findIndex(account => account.current));
    let message = '';
    let restored = false;
    const restoreTerminal = () => {
        if (restored) return;
        restored = true;
        try { process.stdin.setRawMode(false); } catch { }
        process.stdin.pause();
        process.stdout.write('\x1b[?25h\x1b[?1049l');
    };

    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.stdin.setRawMode(true);
    process.stdin.resume();

    try {
        while (true) {
            if (selectedIndex >= accounts.length) selectedIndex = Math.max(0, accounts.length - 1);
            renderMenu(accounts, selectedIndex, message);
            const key = await readKey();

            if (key === '\u0003' || key === '\u001b' || key.toLowerCase() === 'q') break;
            if (key === '\x1b[A' || key.toLowerCase() === 'k') {
                selectedIndex = accounts.length ? (selectedIndex - 1 + accounts.length) % accounts.length : 0;
                message = '';
                continue;
            }
            if (key === '\x1b[B' || key.toLowerCase() === 'j') {
                selectedIndex = accounts.length ? (selectedIndex + 1) % accounts.length : 0;
                message = '';
                continue;
            }
            if (key.toLowerCase() === 'r') {
                renderMenu(accounts, selectedIndex, '正在刷新所有账号配额… 按 Esc 或 Ctrl+C 返回菜单');
                try {
                    accounts = await requestWithMenuCancellation('list', { refresh: true }, 10 * 60 * 1000) as any[];
                    message = '配额刷新完成';
                } catch (error) {
                    message = error instanceof Error && error.name === 'AbortError'
                        ? '已返回菜单；后台可能仍在完成本次配额刷新'
                        : `刷新失败：${error instanceof Error ? error.message : String(error)}`;
                }
                continue;
            }
            if (key.toLowerCase() === 'g') {
                try {
                    const recommended = await request('recommend', { model: 'gemini' }) as any;
                    const index = accounts.findIndex(account => account.id === recommended.id);
                    if (index >= 0) selectedIndex = index;
                    message = `${shortEmail(recommended.email)} 是当前 Gemini 周额度最高的可用账号，按 Enter 切换`;
                } catch (error) {
                    message = `无法推荐：${error instanceof Error ? error.message : String(error)}`;
                }
                continue;
            }
            if (key.toLowerCase() === 'b') {
                renderMenu(accounts, selectedIndex, '已打开 Google 授权页面，正在等待登录… 按 Esc 或 Ctrl+C 取消');
                try {
                    const account = await requestWithMenuCancellation('bind', {}, 6 * 60 * 1000) as any;
                    accounts = await request('list') as any[];
                    selectedIndex = Math.max(0, accounts.findIndex(item => item.id === account.id));
                    message = `绑定成功：${shortEmail(account.email)}`;
                } catch (error) {
                    message = error instanceof Error && error.name === 'AbortError'
                        ? '已取消 Google 授权，可随时按 B 重新绑定'
                        : `绑定失败：${error instanceof Error ? error.message : String(error)}`;
                }
                continue;
            }
            if (key.toLowerCase() === 'i') {
                renderMenu(accounts, selectedIndex, '正在导入当前 Antigravity/agy 账号… 按 Esc 或 Ctrl+C 取消等待');
                try {
                    const account = await requestWithMenuCancellation('import', {}, 120000) as any;
                    accounts = await request('list') as any[];
                    selectedIndex = Math.max(0, accounts.findIndex(item => item.id === account.id));
                    message = `导入成功：${shortEmail(account.email)}`;
                } catch (error) {
                    message = error instanceof Error && error.name === 'AbortError'
                        ? '已取消等待并返回菜单'
                        : `导入失败：${error instanceof Error ? error.message : String(error)}`;
                }
                continue;
            }
            if (key === '\r' || key === '\n') {
                const selected = accounts[selectedIndex];
                const blockReason = getAccountApplyBlockReason(selected);
                if (blockReason === 'missing') {
                    message = '暂无可切换账号，请先绑定或导入账号';
                } else if (blockReason === 'disabled') {
                    message = `${shortEmail(selected.email)} 已被禁用，不能切换`;
                } else {
                    const reapplying = !!selected.current;
                    renderMenu(accounts, selectedIndex, `正在切换到 ${shortEmail(selected.email)}… 按 Esc 或 Ctrl+C 取消等待`);
                    try {
                        const switched = await requestWithMenuCancellation('switch', { selector: selected.id }, 120000) as any;
                        assertSwitchConfirmed(switched, selected.id);
                        accounts = await request('list') as any[];
                        const confirmedCurrent = assertUniqueCurrentAccount(accounts, selected.id);
                        selectedIndex = Math.max(0, accounts.findIndex(account => account.id === confirmedCurrent.id));
                        message = `${reapplying ? '已重新应用' : '已切换到'} ${shortEmail(selected.email)}；新启动的 agy 会话将使用此账号`;
                    } catch (error) {
                        message = error instanceof Error && error.name === 'AbortError'
                            ? '已取消等待；切换若已写入可能仍然生效，请按 R 确认状态'
                            : `切换失败：${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }
        }
    } finally {
        restoreTerminal();
    }
}

function printResult(value: unknown, text: string): void {
    console.log(hasFlag('--json') ? JSON.stringify(value, null, 2) : text);
}

function validateCommandFlags(args: string[], allowed: string[]): void {
    const unknown = args.filter(value => !allowed.includes(value));
    if (unknown.length) throw new Error(`未知参数: ${unknown.join(', ')}`);
}

export interface VersionCommandDependencies {
    getCurrentVersion: () => string;
    getServiceInfo: () => Promise<RunningServiceInfo>;
    writeLine: (value: string) => void;
}

/** 显示 CLI 与已运行服务的版本；此命令不会启动后台服务。 */
export async function runVersionCommand(
    args: string[],
    overrides: Partial<VersionCommandDependencies> = {}
): Promise<void> {
    validateCommandFlags(args, ['--json']);
    const dependencies: VersionCommandDependencies = {
        getCurrentVersion,
        getServiceInfo: () => getRunningServiceInfoStrict(),
        writeLine: value => console.log(value),
        ...overrides,
    };
    const cliVersion = dependencies.getCurrentVersion();
    const service = await dependencies.getServiceInfo();
    const versionMismatch = service.running && service.version !== null
        ? service.version.replace(/^v/, '') !== cliVersion.replace(/^v/, '')
        : null;
    const protocolCompatible = service.running
        ? isServiceSwitchProtocolCompatible(service.switchProtocol)
        : null;
    const result = {
        cliVersion,
        serviceRunning: service.running,
        serviceVersion: service.version,
        serviceSwitchProtocol: service.switchProtocol,
        versionMismatch,
        protocolCompatible,
    };

    if (args.includes('--json')) {
        dependencies.writeLine(JSON.stringify(result, null, 2));
        return;
    }
    dependencies.writeLine(`Anti Quota CLI: ${cliVersion}`);
    dependencies.writeLine(service.running
        ? `后台服务: ${service.version || '版本未知'}（运行中）`
        : '后台服务: 未运行');
    if (versionMismatch || protocolCompatible === false) {
        dependencies.writeLine('警告：CLI 与后台服务不兼容；下次业务命令会自动替换旧服务。');
    }
}

export interface UpdateCommandDependencies {
    checkForUpdate: (runtime?: UpdateRuntime) => Promise<UpdateCheckResult>;
    installLatestUpdate: (
        runtime?: UpdateRuntime,
        options?: UpdateInstallOptions
    ) => Promise<UpdateInstallResult>;
    assertUpdatableInstallation: (runtime?: UpdateRuntime) => void;
    compareVersions: (left: string, right: string) => -1 | 0 | 1;
    withUpdateLock: (action: (lock: UpdateLock) => Promise<void>) => Promise<void>;
    getServiceInfoForUpdate: () => Promise<RunningServiceInfo>;
    stopRunningService: (
        options?: ServiceMutationOptions,
        expectedPid?: number
    ) => Promise<boolean | void>;
    ensureRunning: (options?: ServiceMutationOptions) => Promise<void>;
    getServiceInfo: () => Promise<RunningServiceInfo>;
    getManagedInstallation: () => WindowsServiceInstallation | null;
    stopManagedHost: () => void;
    autostartExists: () => boolean;
    assertInstallationSafe: () => void;
    disableAutostart: () => void;
    reinstallAutostart: () => void;
    writeLine: (value: string) => void;
}

async function restoreServiceState(
    wasRunning: boolean,
    hadAutostart: boolean,
    dependencies: UpdateCommandDependencies,
    lock: UpdateLock,
    expectedServiceVersion?: string
): Promise<string[]> {
    const errors: string[] = [];
    if (hadAutostart) {
        try {
            dependencies.reinstallAutostart();
        } catch (error) {
            errors.push(`恢复用户登录自启失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (wasRunning) {
        let serviceRestored = false;
        try {
            await dependencies.ensureRunning({ updateLock: lock });
            serviceRestored = true;
        } catch (error) {
            errors.push(`恢复后台服务运行失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (serviceRestored && expectedServiceVersion) {
            try {
                const service = await dependencies.getServiceInfo();
                if (!isServiceVersionCompatible(service, expectedServiceVersion, dependencies.compareVersions)) {
                    throw new Error(
                        `服务版本或切换协议与已安装版本 ${expectedServiceVersion} 不兼容`
                    );
                }
            } catch (error) {
                errors.push(`校验恢复后的后台服务版本失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return errors;
}

/** 检查或安装 CLI 更新。更新器只处理 CLI/后台服务，不安装 VSIX。 */
export async function runUpdateCommand(
    args: string[],
    overrides: Partial<UpdateCommandDependencies> = {}
): Promise<void> {
    validateCommandFlags(args, ['--check', '--force', '--json']);
    const checkOnly = args.includes('--check');
    const force = args.includes('--force');
    const json = args.includes('--json');
    if (checkOnly && force) throw new Error('--check 与 --force 不能同时使用');

    const dependencies: UpdateCommandDependencies = {
        checkForUpdate,
        installLatestUpdate,
        assertUpdatableInstallation,
        compareVersions,
        withUpdateLock: action => withUpdateLock({}, action),
        getServiceInfoForUpdate: () => getRunningServiceInfoStrict(),
        stopRunningService: (options, expectedPid) => stopRunningService(options, {}, expectedPid),
        ensureRunning,
        getServiceInfo: () => getRunningServiceInfoStrict(),
        getManagedInstallation: getWindowsServiceInstallation,
        stopManagedHost: stopWindowsService,
        autostartExists: () => fs.existsSync(AUTOSTART_FILE),
        assertInstallationSafe: assertInstallationSafeToStart,
        disableAutostart: uninstallAutostart,
        reinstallAutostart: () => { installAutostart(__filename); },
        writeLine: value => console.log(value),
        ...overrides,
    };

    if (checkOnly) {
        const check = await dependencies.checkForUpdate();
        if (json) {
            dependencies.writeLine(JSON.stringify(check, null, 2));
        } else if (check.updateAvailable) {
            dependencies.writeLine(`发现新版本: ${check.currentVersion} -> ${check.latestVersion}`);
            dependencies.writeLine('运行 anti update 安装。');
        } else {
            dependencies.writeLine(`当前已是最新版: ${check.currentVersion}`);
        }
        return;
    }

    let successOutput: string[] = [];
    await dependencies.withUpdateLock(async lock => {
        const check = await dependencies.checkForUpdate();
        const comparison = dependencies.compareVersions(check.currentVersion, check.latestVersion);
        if (comparison > 0) {
            throw new Error(`当前版本 ${check.currentVersion} 高于公开最新版 ${check.latestVersion}，已拒绝自动降级`);
        }
        if (!check.updateAvailable && !force) {
            dependencies.assertInstallationSafe();
            successOutput = [json
                ? JSON.stringify({ ...check, installed: false }, null, 2)
                : `当前已是最新版: ${check.currentVersion}`];
            return;
        }

        // 在停止服务前先拒绝 Git checkout/npm link，避免可预见的失败造成无谓中断。
        dependencies.assertUpdatableInstallation();
        let installationWasUnsafe = false;
        try {
            dependencies.assertInstallationSafe();
        } catch (error) {
            if (!force) throw error;
            installationWasUnsafe = true;
        }
        const serviceBeforeUpdate = await dependencies.getServiceInfoForUpdate();
        const managedInstallation = dependencies.getManagedInstallation();
        const wasRunning = serviceBeforeUpdate.running;
        let minimumVersion = check.currentVersion;
        if (managedInstallation) {
            if (dependencies.compareVersions(managedInstallation.version, check.latestVersion) > 0) {
                throw new Error(`Windows 服务版本 ${managedInstallation.version} 高于待安装版本 ${check.latestVersion}；`
                    + '已拒绝自动降级并保留较新的 Windows 服务');
            }
            if (dependencies.compareVersions(managedInstallation.version, check.currentVersion) > 0) {
                throw new Error(`Windows 服务版本 ${managedInstallation.version} 高于当前 CLI ${check.currentVersion}；`
                    + '请先使用匹配版本的 CLI，避免更新失败时无法安全恢复');
            }
        }
        if (wasRunning) {
            assertServiceVersionKnown(serviceBeforeUpdate);
            assertServiceCanBeStopped(serviceBeforeUpdate);
            if (dependencies.compareVersions(serviceBeforeUpdate.version, check.latestVersion) > 0) {
                throw new Error(
                    `后台服务版本 ${serviceBeforeUpdate.version} 高于待安装版本 ${check.latestVersion}；`
                    + '已拒绝自动降级并保留较新的后台服务'
                );
            }
            if (dependencies.compareVersions(serviceBeforeUpdate.version, check.currentVersion) > 0) {
                throw new Error(
                    `后台服务版本 ${serviceBeforeUpdate.version} 高于当前 CLI ${check.currentVersion}；`
                    + '当前 CLI 无法在更新失败时安全恢复该服务，请先使用匹配版本的 CLI'
                );
            }
            if (dependencies.compareVersions(serviceBeforeUpdate.version, minimumVersion) > 0) {
                minimumVersion = serviceBeforeUpdate.version;
            }
        }
        const hadAutostart = dependencies.autostartExists() || managedInstallation !== null;

        if (wasRunning) {
            const stopped = await dependencies.stopRunningService(
                { updateLock: lock },
                serviceBeforeUpdate.pid as number
            );
            if (stopped === false) {
                throw new Error('后台服务实例已变化，已取消更新；请重试');
            }
        }
        // The host can be running without an agent (logged out or intentionally
        // paused). It still owns protected binaries and must stop before install.
        if (managedInstallation) dependencies.stopManagedHost();

        let result: UpdateInstallResult;
        try {
            result = await dependencies.installLatestUpdate({}, { force, lock, minimumVersion });
        } catch (error) {
            if (installationWasUnsafe
                || (error instanceof UpdateInstallError && !error.serviceSafeToRestore)) {
                const containmentErrors: string[] = [];
                if (hadAutostart) {
                    try {
                        dependencies.disableAutostart();
                    } catch (disableError) {
                        containmentErrors.push(
                            `停用用户登录自启失败: ${disableError instanceof Error
                                ? disableError.message
                                : String(disableError)}`
                        );
                    }
                }
                const containedError = error instanceof Error ? error : new Error(String(error));
                const original = containedError.message;
                containedError.message = containmentErrors.length
                    ? `${original}；为避免启动未验证安装，后台服务未恢复；${containmentErrors.join('；')}`
                    : `${original}；为避免启动未验证安装，后台服务和登录自启均未恢复`;
                throw containedError;
            }

            const recoveryErrors = await restoreServiceState(
                wasRunning,
                hadAutostart,
                dependencies,
                lock,
                check.currentVersion
            );
            if (recoveryErrors.length) {
                const original = error instanceof Error ? error.message : String(error);
                throw new Error(`${original}；${recoveryErrors.join('；')}`);
            }
            throw error;
        }

        const recoveryErrors = await restoreServiceState(
            wasRunning,
            hadAutostart,
            dependencies,
            lock,
            result.installed ? result.latestVersion : result.currentVersion
        );
        if (recoveryErrors.length) {
            throw new Error(`CLI ${result.installed ? '已安装' : '未变更'}，但服务状态恢复不完整：${recoveryErrors.join('；')}`);
        }

        if (json) {
            successOutput = [JSON.stringify(result, null, 2)];
        } else if (result.installed) {
            const action = result.currentVersion === result.latestVersion ? '已重新安装' : '已更新';
            successOutput = [
                `Anti Quota CLI ${action}: ${result.currentVersion} -> ${result.latestVersion}`,
                'VS Code 扩展未更新；如需同步扩展，请单独安装对应版本的 VSIX。',
            ];
        } else {
            successOutput = [`当前已是最新版: ${result.currentVersion}`];
        }
    });
    for (const line of successOutput) dependencies.writeLine(line);
}

export interface ServiceManagementDependencies {
    assertMutationAllowed: () => void;
    assertInstallationSafe: () => void;
    getCurrentVersion: () => string;
    compareVersions: (left: string, right: string) => -1 | 0 | 1;
    getServiceInfo: () => Promise<RunningServiceInfo>;
    getManagedInstallation: () => WindowsServiceInstallation | null;
    getManagedStatus: (installation: WindowsServiceInstallation) => string;
    stopRunningService: (expectedPid: number) => Promise<boolean>;
    stopManagedHost: () => void;
    ensureRunning: () => Promise<void>;
    install: () => string;
    uninstall: () => void;
    run: () => Promise<void>;
    logPath: () => string;
    writeLine: (line: string) => void;
}

/** CLI management shares the same guarded IPC shutdown and SCM lifecycle as updates. */
export async function runServiceManagementCommand(
    args: string[],
    overrides: Partial<ServiceManagementDependencies> = {}
): Promise<void> {
    const action = args[0] || 'status';
    if (args.length > 1) throw new Error(`未知 service 参数: ${args.slice(1).join(' ')}`);
    const dependencies: ServiceManagementDependencies = {
        assertMutationAllowed: assertNoUpdateInProgress,
        assertInstallationSafe: assertInstallationSafeToStart,
        getCurrentVersion,
        compareVersions,
        getServiceInfo: () => getRunningServiceInfoStrict(),
        getManagedInstallation: getWindowsServiceInstallation,
        getManagedStatus: getWindowsScmStatus,
        stopRunningService: pid => stopRunningService({}, {}, pid),
        stopManagedHost: stopWindowsService,
        ensureRunning,
        install: () => installAutostart(__filename),
        uninstall: uninstallAutostart,
        run: runServiceCommand,
        logPath: () => path.join(os.homedir(), '.anti-quota', 'service.log'),
        writeLine: line => console.log(line),
        ...overrides,
    };
    if (action === 'run' || action === 'managed-agent') {
        if (action === 'managed-agent' && !getManagedHostEnvironment()) {
            throw new Error('managed-agent 只能由已安装的 Windows 服务启动');
        }
        await dependencies.run();
        return;
    }
    if (action === 'status') {
        const installation = dependencies.getManagedInstallation();
        if (installation) {
            dependencies.writeLine(`Windows 服务: ${installation.serviceName} (${dependencies.getManagedStatus(installation)})`);
            dependencies.writeLine(`Windows 服务版本: ${installation.version}`);
        }
        const service = await dependencies.getServiceInfo();
        dependencies.writeLine(service.running ? 'Anti Quota 用户代理正在运行' : 'Anti Quota 用户代理未运行');
        if (!installation) dependencies.writeLine('尚未注册系统自启动服务；运行 anti service install 安装。');
        return;
    }
    if (action === 'logs') {
        dependencies.writeLine(dependencies.logPath());
        return;
    }
    if (!['start', 'stop', 'install', 'uninstall'].includes(action)) {
        throw new Error(`未知 service 操作: ${action}`);
    }
    dependencies.assertMutationAllowed();
    if (action === 'start') {
        await dependencies.ensureRunning();
        dependencies.writeLine('Anti Quota 服务已启动');
        return;
    }
    if (action === 'install') dependencies.assertInstallationSafe();

    // Stop the detached legacy agent before migrating to SCM. The installer must
    // not race a pre-existing process writing the same user credential store.
    const service = await dependencies.getServiceInfo();
    if (service.running) {
        if (action === 'install') {
            assertServiceVersionKnown(service);
            if (dependencies.compareVersions(service.version, dependencies.getCurrentVersion()) > 0) {
                throw new Error('后台服务版本高于当前 CLI；请更新 CLI，已拒绝安装或降级服务');
            }
        }
        assertServiceCanBeStopped(service);
        if (!await dependencies.stopRunningService(service.pid)) {
            throw new Error('后台服务实例已变化，已取消操作；请重试');
        }
    }
    if (action === 'stop') {
        dependencies.stopManagedHost();
        dependencies.writeLine('Anti Quota 服务已停止');
        return;
    }
    if (action === 'uninstall') {
        dependencies.uninstall();
        dependencies.writeLine('已移除 Anti Quota 自启动服务；绑定账号与凭证已保留');
        return;
    }
    const target = dependencies.install();
    await dependencies.ensureRunning();
    dependencies.writeLine(`已安装 Anti Quota 自启动服务: ${target}`);
}

function printHelp(): void {
    console.log(`Anti Quota CLI

用法:
  anti-quota list [--refresh] [--json]         列出账号与配额
  anti-quota current                           查看 agy 当前账号
  anti-quota bind                              打开 Google 授权并绑定账号
  anti-quota import                            导入当前 Antigravity/agy 账号
  anti-quota refresh [all|账号]                刷新配额
  anti-quota switch <序号|邮箱|ID>             快速切换 agy 账号
  anti-quota recommend [模型] [--refresh]      推荐最佳账号
  anti-quota recommend [模型] --switch         推荐并立即切换
  anti-quota network                           检查 Google 网络与代理路由
  anti-quota version [--json]                  查看 CLI 与后台服务版本
  anti-quota update --check                    检查 CLI 更新
  anti-quota update [--force]                  下载、校验并安装 CLI 更新
  anti-quota service start|stop|status         管理后台服务
  anti-quota service install|uninstall         安装/移除系统自启动服务
  anti-quota service logs                      显示服务日志位置

模型: gemini（默认）、claude、gemini-pro、gemini-flash
交互菜单: anti（也可直接运行 anti-quota 或 aq）`);
}

export async function main(): Promise<void> {
    const command = argv[0] || 'menu';
    if (command === 'help' || command === '--help' || command === '-h') {
        printHelp();
        return;
    }

    if (command === 'version' || command === '--version' || command === '-V') {
        await runVersionCommand(argv.slice(1));
        return;
    }

    if (command === 'update') {
        await runUpdateCommand(argv.slice(1));
        return;
    }

    if (command === 'service') {
        await runServiceManagementCommand(argv.slice(1));
        return;
    }

    if (command === 'menu' || command === 'ui') {
        await runInteractiveMenu();
        return;
    }

    await ensureRunning();
    if (command === 'list' || command === 'ls') {
        const accounts = await request('list', { refresh: hasFlag('--refresh') }) as any[];
        if (!accounts.length) printResult(accounts, '暂无账号，请运行 anti-quota bind');
        else printResult(accounts, accounts.map(formatAccount).join('\n'));
        return;
    }
    if (command === 'current') {
        const account = await request('current') as any;
        printResult(account, account ? formatAccount(account) : '未检测到当前账号');
        return;
    }
    if (command === 'bind' || command === 'login') {
        console.log('正在打开 Google 授权页面，请在浏览器完成登录；按 Ctrl+C 可取消...');
        const account = await request('bind', {}, 6 * 60 * 1000) as any;
        console.log(`绑定成功: ${account.email}`);
        return;
    }
    if (command === 'import') {
        const account = await request('import') as any;
        console.log(`导入成功: ${account.email}`);
        return;
    }
    if (command === 'refresh') {
        const selector = argv[1];
        const result = await request('refresh', { all: !selector || selector === 'all', selector }, 10 * 60 * 1000) as any;
        if (result && typeof result.success === 'number') printResult(result, `刷新完成: ${result.success} 成功, ${result.failed} 失败`);
        else printResult(result, formatAccount(result));
        return;
    }
    if (command === 'switch' || command === 'use') {
        const selector = argv[1];
        if (!selector) throw new Error('请提供账号序号、邮箱或 ID');
        const account = await request('switch', { selector }) as any;
        assertSwitchConfirmed(account);
        printResult(account, `已切换 agy 账号: ${account.email}\n新启动的 agy 会话将使用此账号；已有会话不会改变。`);
        return;
    }
    if (command === 'recommend' || command === 'best') {
        const model = argv.slice(1).find(value => !value.startsWith('--')) || 'gemini';
        const account = await request('recommend', {
            model,
            refresh: hasFlag('--refresh'),
            switch: hasFlag('--switch'),
        }, 10 * 60 * 1000) as any;
        if (hasFlag('--switch')) assertSwitchConfirmed(account);
        const suffix = hasFlag('--switch') ? '\n新启动的 agy 会话将使用此账号；已有会话不会改变。' : '';
        printResult(account, `${hasFlag('--switch') ? '已切换到' : '推荐账号'}: ${formatAccount(account)}${suffix}`);
        return;
    }
    if (command === 'network' || command === 'doctor') {
        const diagnostics = await request('network', {}, 60_000) as any[];
        if (hasFlag('--json')) {
            console.log(JSON.stringify(diagnostics, null, 2));
        } else {
            for (const item of diagnostics) {
                const route = item.proxy ? `${item.source}: ${item.proxy}` : 'direct';
                const result = item.reachable ? `可访问 (HTTP ${item.status})` : `失败: ${item.error}`;
                console.log(`${item.name} [${route}] ${result}`);
            }
        }
        return;
    }
    throw new Error(`未知命令: ${command}。运行 anti-quota --help 查看帮助。`);
}

if (require.main === module) {
    main().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (argv.includes('--json')) {
            console.log(JSON.stringify({ ok: false, error: message }));
        } else {
            console.error(`错误: ${message}`);
        }
        process.exitCode = 1;
    });
}
