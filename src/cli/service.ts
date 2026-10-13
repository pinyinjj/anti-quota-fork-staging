import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import * as accountService from '../services/accountService';
import * as antigravityService from '../services/antigravityService';
import * as oauthService from '../services/oauthService';
import { diagnoseGoogleNetwork } from '../services/networkService';
import { Account, ModelQuota } from '../types/account';
import { getManagedHostEnvironment, getWindowsServiceInstallation, runWindowsServiceInstaller } from './windowsService';

/** Captured at process startup so an in-place npm update cannot disguise an old service. */
export const SERVICE_VERSION: string = require('../../package.json').version;
/** Capability handshake used to reject services that predate authoritative Keyring switching. */
export const SERVICE_SWITCH_PROTOCOL = 'authoritative-keyring-v1';

export interface ServiceRequest {
    token: string;
    command: string;
    args?: Record<string, unknown>;
}

export interface ServiceResponse {
    ok: boolean;
    data?: unknown;
    error?: string;
}

export function getServicePingInfo(): { pid: number; version: string; switchProtocol: string } {
    return {
        pid: process.pid,
        version: SERVICE_VERSION,
        switchProtocol: SERVICE_SWITCH_PROTOCOL,
    };
}

export function shouldStopServiceInstance(expectedPid: unknown, currentPid: number = process.pid): boolean {
    if (expectedPid === undefined) return true;
    if (!Number.isSafeInteger(expectedPid) || Number(expectedPid) <= 0) {
        throw new Error('停止服务请求包含无效的目标 PID');
    }
    return expectedPid === currentPid;
}

const DATA_DIR = path.join(os.homedir(), '.anti-quota');
export const TOKEN_FILE = path.join(DATA_DIR, 'service-token');
export const PID_FILE = path.join(DATA_DIR, 'service.pid');
export const LOG_FILE = path.join(DATA_DIR, 'service.log');
export const AUTOSTART_FILE = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'anti-quota-service.vbs')
    : path.join(os.homedir(), '.config', 'autostart', 'anti-quota-service.desktop');
export const WINDOWS_COMMAND_ALIAS = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'anti.cmd')
    : '';

export interface ServiceEndpointRuntime {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
}

export function getEndpoint(runtime: ServiceEndpointRuntime = {}): string {
    const platform = runtime.platform || process.platform;
    if (platform === 'win32') {
        const env = runtime.env || process.env;
        const homedir = runtime.homedir || os.homedir;
        let rawUser = env.USERNAME || env.USER || '';
        if (!rawUser) {
            try {
                rawUser = path.basename(homedir());
            } catch {
                rawUser = 'user';
            }
        }
        const user = rawUser.replace(/[^a-zA-Z0-9_-]/g, '-') || 'user';
        return `\\\\.\\pipe\\anti-quota-${user}`;
    }
    return path.join(DATA_DIR, 'service.sock');
}

export function ensureServiceToken(): string {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TOKEN_FILE)) {
        fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(32).toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    }
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { }
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
}

export function publicAccount(account: Account, currentId?: string) {
    return {
        id: account.id,
        email: account.email,
        name: account.name,
        disabled: !!account.disabled,
        current: account.id === currentId,
        lastUsed: account.last_used,
        quota: account.quota ? {
            forbidden: !!account.quota.is_forbidden,
            updatedAt: account.quota.last_updated,
            models: account.quota.models.map(model => ({
                name: model.name,
                displayName: model.displayName,
                fiveHour: model.percentage,
                fiveHourReset: model.reset_time,
                weekly: model.weekly_percentage,
                weeklyReset: model.weekly_reset_time,
            })),
        } : undefined,
    };
}

export interface CurrentManagedAccountDependencies {
    listAccounts: () => Account[];
    getCurrentAgyCliRefreshTokenFingerprint: () => Promise<antigravityService.AgyCliAuthFingerprint | null>;
    reportProbeError: () => void;
}

export interface CurrentManagedAccountOptions {
    failOnProbeError?: boolean;
}

const currentManagedAccountDependencies: CurrentManagedAccountDependencies = {
    listAccounts: () => accountService.listAccounts(),
    getCurrentAgyCliRefreshTokenFingerprint: () =>
        antigravityService.getCurrentAgyCliRefreshTokenFingerprint(),
    reportProbeError: () => {
        try {
            appendLog('agy 权威凭据探测失败；本次未标记当前账号');
        } catch { }
    },
};

export async function getCurrentManagedAccount(
    overrides: Partial<CurrentManagedAccountDependencies> = {},
    options: CurrentManagedAccountOptions = {}
): Promise<Account | null> {
    const dependencies = { ...currentManagedAccountDependencies, ...overrides };
    const accounts = dependencies.listAccounts();

    // Windows 上 Keyring 是 agy 的权威来源；底层只在 Keyring 明确不存在时回退到令牌文件。
    let agyFingerprint: antigravityService.AgyCliAuthFingerprint | null;
    try {
        agyFingerprint = await dependencies.getCurrentAgyCliRefreshTokenFingerprint();
    } catch {
        dependencies.reportProbeError();
        if (options.failOnProbeError) {
            throw new Error('无法读取 agy 权威凭据状态，已取消切换');
        }
        return null;
    }
    if (agyFingerprint) {
        return accounts.find(account =>
            antigravityService.fingerprintRefreshToken(account.token.refresh_token) === agyFingerprint.fingerprint
        ) || null;
    }
    return null;
}

function resolveAccount(selector: string): Account {
    const accounts = accountService.listAccounts();
    const normalized = selector.trim().toLowerCase();
    const index = Number.parseInt(normalized, 10);
    const byIndex = /^\d+$/.test(normalized) && index >= 1 ? accounts[index - 1] : undefined;
    const exact = accounts.find(account =>
        account.id.toLowerCase() === normalized
        || account.email.toLowerCase() === normalized
        || account.email.replace(/@gmail\.com$/i, '').toLowerCase() === normalized
    );
    const prefixMatches = accounts.filter(account =>
        account.id.toLowerCase().startsWith(normalized)
        || account.email.toLowerCase().startsWith(normalized)
    );
    const match = byIndex || exact || (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
    if (!match) {
        throw new Error(prefixMatches.length > 1 ? `账号“${selector}”匹配到多个结果` : `未找到账号“${selector}”`);
    }
    return match;
}

function usableModel(account: Account, modelName?: string): ModelQuota | undefined {
    const models = account.quota?.models || [];
    if (modelName && modelName !== 'gemini') {
        return models.find(model => model.name === modelName && model.percentage > 0);
    }
    return models
        .filter(model => model.name === 'gemini-pro' || model.name === 'gemini-flash')
        .filter(model => model.percentage > 0)
        .sort((a, b) => b.percentage - a.percentage)[0];
}

function recommendAccount(modelName = 'gemini', excludeId?: string): Account {
    const candidates = accountService.listAccounts().filter(account =>
        account.id !== excludeId
        && !account.disabled
        && !account.quota?.is_forbidden
        && (!modelName.startsWith('gemini') || (accountService.getGeminiWeeklyQuota(account) ?? -1) >= 1)
        && !!usableModel(account, modelName)
    );

    candidates.sort((a, b) => {
        if (modelName.startsWith('gemini')) {
            const weeklyDifference = (accountService.getGeminiWeeklyQuota(b) ?? -1) - (accountService.getGeminiWeeklyQuota(a) ?? -1);
            if (weeklyDifference !== 0) return weeklyDifference;
        }
        const aQuota = usableModel(a, modelName)?.percentage ?? -1;
        const bQuota = usableModel(b, modelName)?.percentage ?? -1;
        if (bQuota !== aQuota) return bQuota - aQuota;
        return (b.last_used || 0) - (a.last_used || 0);
    });

    if (!candidates[0]) throw new Error(`没有可用的 ${modelName} 账号，请先刷新配额`);
    return candidates[0];
}

export interface SwitchAgyAccountDependencies {
    isAgyProcessRunning: () => Promise<boolean>;
    refreshAccessToken: typeof oauthService.refreshAccessToken;
    writeAgyCliAuth: typeof antigravityService.writeAgyCliAuth;
    updateAccount: typeof accountService.updateAccount;
    reportMetadataError: () => void;
    now: () => number;
}

let switchTransactionTail: Promise<void> = Promise.resolve();

export function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('账号切换已取消');
    error.name = 'AbortError';
    throw error;
}

/** Serialize the complete read/refresh/write/confirm flow in request arrival order. */
export async function runSerializedSwitchTransaction<T>(
    action: () => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const previous = switchTransactionTail;
    let release!: () => void;
    switchTransactionTail = new Promise<void>(resolve => { release = resolve; });

    await previous;
    try {
        throwIfAborted(signal);
        return await action();
    } finally {
        release();
    }
}

export function tasklistContainsAgy(output: string): boolean {
    return output.split(/\r?\n/).some(line => /^"agy\.exe",/i.test(line.trim()));
}

export function processListContainsAgy(output: string): boolean {
    return output.split(/\r?\n/).some(line => path.basename(line.trim()) === 'agy');
}

export async function isAgyProcessRunning(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const command = process.platform === 'win32' ? 'tasklist.exe' : 'ps';
        const args = process.platform === 'win32'
            ? ['/FI', 'IMAGENAME eq agy.exe', '/NH', '/FO', 'CSV']
            : ['-A', '-o', 'comm='];
        execFile(command, args, {
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: true,
        }, (error, stdout) => {
            if (error) {
                reject(new Error('无法确认 agy 进程状态，已取消切换'));
                return;
            }
            resolve(process.platform === 'win32'
                ? tasklistContainsAgy(stdout)
                : processListContainsAgy(stdout));
        });
    });
}

const switchAgyAccountDependencies: SwitchAgyAccountDependencies = {
    isAgyProcessRunning,
    refreshAccessToken: refreshToken => oauthService.refreshAccessToken(refreshToken),
    writeAgyCliAuth: (accessToken, refreshToken, expiry, runtime) =>
        antigravityService.writeAgyCliAuth(accessToken, refreshToken, expiry, runtime),
    updateAccount: (accountId, updates) => accountService.updateAccount(accountId, updates),
    reportMetadataError: () => {
        try {
            appendLog('agy 凭据已切换，但账号 last_used/Token 元数据保存失败');
        } catch { }
    },
    now: () => Math.floor(Date.now() / 1000),
};

export async function switchAgyAccount(
    account: Account,
    overrides: Partial<SwitchAgyAccountDependencies> = {},
    signal?: AbortSignal
): Promise<Account> {
    const dependencies = { ...switchAgyAccountDependencies, ...overrides };
    throwIfAborted(signal);
    if (account.disabled) throw new Error('目标账号已禁用');
    if (await dependencies.isAgyProcessRunning()) {
        throw new Error('检测到正在运行的 agy.exe；请先退出所有 agy 会话，再重新切换账号');
    }
    throwIfAborted(signal);
    const tokenResponse = await dependencies.refreshAccessToken(account.token.refresh_token);
    throwIfAborted(signal);
    const now = dependencies.now();
    const token = {
        ...account.token,
        access_token: tokenResponse.access_token,
        expires_in: tokenResponse.expires_in,
        expiry_timestamp: now + tokenResponse.expires_in,
        token_type: tokenResponse.token_type || 'Bearer',
    };
    if (await dependencies.isAgyProcessRunning()) {
        throw new Error('刷新 Token 期间检测到 agy.exe 已启动；请先退出所有 agy 会话，再重新切换账号');
    }
    throwIfAborted(signal);
    await dependencies.writeAgyCliAuth(token.access_token, token.refresh_token, token.expiry_timestamp, {
        beforeWrite: async () => {
            throwIfAborted(signal);
            if (await dependencies.isAgyProcessRunning()) {
                throw new Error('取得凭据锁后检测到 agy.exe 已启动；请先退出所有 agy 会话，再重新切换账号');
            }
            throwIfAborted(signal);
        },
    });
    try {
        if (await dependencies.isAgyProcessRunning()) {
            throw new Error(
                'agy 凭据已更新，但切换提交期间检测到 agy.exe 已启动；'
                + '当前进程可能仍使用旧凭据。请退出并重启所有 agy 会话后再确认账号'
            );
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('agy 凭据已更新')) throw error;
        throw new Error(
            'agy 凭据已更新，但无法确认切换提交期间的进程状态；'
            + '当前进程可能仍使用旧凭据。请退出并重启所有 agy 会话后再确认账号'
        );
    }
    let persistedLastUsed = account.last_used;
    try {
        dependencies.updateAccount(account.id, { token, last_used: now });
        persistedLastUsed = now;
    } catch {
        // 凭据层已经回读确认；元数据失败不能把实际成功的账号切换伪装成失败。
        dependencies.reportMetadataError();
    }
    return { ...account, token, last_used: persistedLastUsed };
}

export async function confirmSwitchedAccount(
    account: Account,
    readCurrent: () => Promise<Account | null> = () =>
        getCurrentManagedAccount({}, { failOnProbeError: true })
) {
    const current = await readCurrent();
    if (!current || current.id !== account.id) {
        throw new Error('切换后 agy 权威凭据未指向目标账号，已拒绝显示切换成功');
    }
    return publicAccount(account, current.id);
}

function openBrowser(url: string): void {
    let command: string;
    let args: string[];
    if (process.platform === 'win32') {
        command = 'rundll32.exe';
        args = ['url.dll,FileProtocolHandler', url];
    } else if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
    } else {
        command = 'xdg-open';
        args = [url];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
}

async function handleRequest(request: ServiceRequest, signal?: AbortSignal): Promise<unknown> {
    const args = request.args || {};
    switch (request.command) {
        case 'ping':
            return getServicePingInfo();
        case 'list': {
            if (args.refresh) await accountService.refreshAllQuotas(signal);
            const current = await getCurrentManagedAccount();
            return accountService.listAccounts().map(account => publicAccount(account, current?.id));
        }
        case 'current': {
            const current = await getCurrentManagedAccount();
            return current ? publicAccount(current, current.id) : null;
        }
        case 'refresh': {
            if (args.all || !args.selector) {
                return accountService.refreshAllQuotas(signal);
            }
            const account = resolveAccount(String(args.selector));
            await accountService.fetchAccountQuota(account.id);
            accountService.invalidateCache();
            return publicAccount(resolveAccount(account.id));
        }
        case 'import': {
            const account = await accountService.autoImportFromEditor();
            if (!account) throw new Error('未从 Antigravity 或 agy 中检测到可导入账号');
            return publicAccount(account);
        }
        case 'bind': {
            const account = await accountService.startOAuthFlow(
                () => openBrowser(accountService.getOAuthUrl()),
                signal
            );
            return publicAccount(account);
        }
        case 'switch': {
            return runSerializedSwitchTransaction(async () => {
                const account = resolveAccount(String(args.selector || ''));
                const observed = await switchAgyAccount(account, {}, signal);
                return confirmSwitchedAccount(observed);
            }, signal);
        }
        case 'recommend': {
            if (!args.switch) {
                if (args.refresh) await accountService.refreshAllQuotas(signal);
                const current = await getCurrentManagedAccount();
                const account = recommendAccount(String(args.model || 'gemini'));
                return publicAccount(account, current?.id);
            }
            return runSerializedSwitchTransaction(async () => {
                if (args.refresh) await accountService.refreshAllQuotas(signal);
                throwIfAborted(signal);
                const current = await getCurrentManagedAccount({}, { failOnProbeError: true });
                // 推荐与写入必须属于同一个串行事务，避免并发请求基于过期当前账号选择。
                const account = recommendAccount(String(args.model || 'gemini'), current?.id);
                const observed = await switchAgyAccount(account, {}, signal);
                return confirmSwitchedAccount(observed);
            }, signal);
        }
        case 'network':
            return diagnoseGoogleNetwork();
        case 'stop':
            throw new Error('停止命令必须由服务传输层处理');
        default:
            throw new Error(`未知服务命令: ${request.command}`);
    }
}

function appendLog(message: string): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf-8');
}

/**
 * 仅清理仍由当前服务实例拥有的 PID 文件。
 *
 * 旧服务的 close 事件可能晚于新服务写入 PID 文件；无条件 unlink 会把新实例的
 * 所有权标记误删，令后续诊断看到一个仍在运行但没有 PID 文件的服务。
 */
export function removeOwnedPidFile(
    pidFile: string = PID_FILE,
    expectedPid: number = process.pid
): boolean {
    try {
        if (fs.readFileSync(pidFile, 'utf-8').trim() !== String(expectedPid)) return false;
        fs.unlinkSync(pidFile);
        return true;
    } catch {
        return false;
    }
}

export interface EndpointFileIdentity {
    dev: bigint;
    ino: bigint;
}

export function readEndpointFileIdentity(endpoint: string): EndpointFileIdentity {
    const stats = fs.statSync(endpoint, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
}

/** Best-effort cleanup for the Unix endpoint owned by this service instance. */
export function removeOwnedEndpointFile(
    endpoint: string,
    expected: EndpointFileIdentity
): boolean {
    try {
        const current = readEndpointFileIdentity(endpoint);
        if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
        fs.unlinkSync(endpoint);
        return true;
    } catch {
        return false;
    }
}

export class ServiceRequestDrain {
    private activeRequests = 0;
    private shuttingDown = false;
    private drained = false;

    constructor(private readonly onDrained: () => void) { }

    beginRequest(): () => void {
        if (this.shuttingDown) {
            throw new Error('Anti Quota 服务正在停止，请稍后重试');
        }
        this.activeRequests += 1;
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            this.activeRequests -= 1;
            this.notifyIfDrained();
        };
    }

    beginShutdown(): void {
        this.shuttingDown = true;
        this.notifyIfDrained();
    }

    isShuttingDown(): boolean {
        return this.shuttingDown;
    }

    private notifyIfDrained(): void {
        if (!this.shuttingDown || this.activeRequests !== 0 || this.drained) return;
        this.drained = true;
        this.onDrained();
    }
}

export type ServiceShutdownReason = 'user' | 'host' | 'signal';

/** First reason wins: a late logoff marker must not turn manual stop into resume. */
export class ServiceShutdownCoordinator {
    private reason?: ServiceShutdownReason;
    private readonly requests = new Set<AbortController>();

    constructor(private readonly onShutdown: () => void) { }

    register(controller: AbortController): () => void {
        if (this.reason) controller.abort();
        this.requests.add(controller);
        return () => { this.requests.delete(controller); };
    }

    begin(reason: ServiceShutdownReason): void {
        if (this.reason) return;
        this.reason = reason;
        // OAuth and queued switches cancel immediately; committed credential writes
        // deliberately ignore cancellation until their atomic write/readback finishes.
        for (const controller of this.requests) controller.abort();
        this.onShutdown();
    }

    getReason(): ServiceShutdownReason | undefined { return this.reason; }
}

export class ManagedAgentStopMonitor {
    private stopped = false;

    constructor(private readonly runtime: {
        stopFileExists: () => boolean;
        hostIsAlive: () => boolean;
        shutdown: () => void;
    }) { }

    poll(): void {
        if (this.stopped) return;
        let stop: boolean;
        try {
            stop = this.runtime.stopFileExists() || !this.runtime.hostIsAlive();
        } catch {
            // An unverifiable host/control path cannot safely supervise this agent.
            stop = true;
        }
        if (!stop) return;
        this.stopped = true;
        this.runtime.shutdown();
    }
}

export async function runService(): Promise<void> {
    const managedHost = getManagedHostEnvironment();
    const serviceToken = ensureServiceToken();
    const endpoint = getEndpoint();
    if (process.platform !== 'win32' && fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
    let ownedEndpoint: EndpointFileIdentity | undefined;

    let server!: net.Server;
    // server.close() 不会主动关闭已经建立但尚未发送请求的连接。若不跟踪这些
    // socket，一个空闲本地客户端就能让旧服务永远无法退出，同时端点已经拒绝
    // 新连接，CLI 会误判停机完成。
    const idleSockets = new Set<net.Socket>();
    let monitorTimer: NodeJS.Timeout | undefined;
    const requestDrain = new ServiceRequestDrain(() => {
        for (const idleSocket of idleSockets) idleSocket.destroy();
        idleSockets.clear();
        server.close();
    });
    const shutdown = new ServiceShutdownCoordinator(() => {
        if (monitorTimer) clearInterval(monitorTimer);
        requestDrain.beginShutdown();
    });
    const signalShutdown = () => shutdown.begin('signal');
    server = net.createServer(socket => {
        idleSockets.add(socket);
        socket.setEncoding('utf-8');
        let input = '';
        let requestStarted = false;
        let responseFinished = false;
        const requestAbort = new AbortController();

        // 客户端取消或超时后，后续 socket.end() 可能触发 EPIPE/ECONNRESET。
        // 必须消费连接级错误，否则单个本地客户端就能终止整个后台服务进程。
        socket.on('error', () => {
            if (requestStarted && !responseFinished) requestAbort.abort();
        });
        // CLI 在授权期间退出或按下取消键时，连接会关闭；立即释放 OAuth 端口，
        // 而不是继续等待五分钟。其他普通操作目前会自行完成并安全落盘。
        socket.on('close', () => {
            idleSockets.delete(socket);
            if (requestStarted && !responseFinished) requestAbort.abort();
        });
        socket.on('data', chunk => {
            input += chunk;
            const newline = input.indexOf('\n');
            if (newline < 0 || requestStarted) return;
            requestStarted = true;
            idleSockets.delete(socket);
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            void (async () => {
                let response: ServiceResponse;
                let finishActiveRequest: (() => void) | undefined;
                let unregisterAbort: (() => void) | undefined;
                try {
                    const request = JSON.parse(line) as ServiceRequest;
                    if (!request.token || !crypto.timingSafeEqual(Buffer.from(request.token), Buffer.from(serviceToken))) {
                        throw new Error('本地服务认证失败');
                    }
                    if (request.command === 'stop') {
                        const expectedPid = request.args?.expectedPid;
                        if (!shouldStopServiceInstance(expectedPid)) {
                            response = {
                                ok: true,
                                data: { stopping: false, reason: 'service-instance-changed', pid: process.pid },
                            };
                        } else {
                            response = { ok: true, data: { stopping: true, pid: process.pid } };
                            shutdown.begin('user');
                        }
                    } else if (request.command === 'ping') {
                        // Stop polling must remain available while active writes drain.
                        response = { ok: true, data: getServicePingInfo() };
                    } else {
                        finishActiveRequest = requestDrain.beginRequest();
                        unregisterAbort = shutdown.register(requestAbort);
                        response = { ok: true, data: await handleRequest(request, requestAbort.signal) };
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (!requestAbort.signal.aborted) appendLog(`请求失败: ${message}`);
                    response = { ok: false, error: message };
                } finally {
                    unregisterAbort?.();
                    finishActiveRequest?.();
                }
                responseFinished = true;
                if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
            })();
        });
    });

    server.on('error', error => {
        // 日志目录本身不可写时也必须让启动阶段的 once('error') 继续收到原始错误，
        // 否则服务会永远占着启动门禁。
        try {
            appendLog(`服务错误: ${error instanceof Error ? error.message : String(error)}`);
        } catch { }
        process.exitCode = 1;
    });
    server.on('close', () => {
        if (monitorTimer) clearInterval(monitorTimer);
        process.off('SIGTERM', signalShutdown);
        process.off('SIGINT', signalShutdown);
        if (shutdown.getReason() === 'host' && !process.exitCode) process.exitCode = 64;
        removeOwnedPidFile();
        if (ownedEndpoint) removeOwnedEndpointFile(endpoint, ownedEndpoint);
    });
    process.on('SIGTERM', signalShutdown);
    process.on('SIGINT', signalShutdown);

    fs.mkdirSync(DATA_DIR, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const onStartupError = (error: Error) => reject(error);
        server.once('error', onStartupError);
        server.listen(endpoint, () => {
            server.off('error', onStartupError);
            try {
                if (process.platform !== 'win32') {
                    ownedEndpoint = readEndpointFileIdentity(endpoint);
                }
                fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
                appendLog(`服务已启动 pid=${process.pid}`);
                resolve();
            } catch (error) {
                server.close();
                reject(error);
            }
        });
    });
    if (managedHost) {
        const monitor = new ManagedAgentStopMonitor({
            stopFileExists: () => {
                try { fs.statSync(managedHost.stopFile); return true; }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                    throw error;
                }
            },
            hostIsAlive: () => {
                try { process.kill(managedHost.hostPid, 0); return true; }
                catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
            },
            shutdown: () => shutdown.begin('host'),
        });
        monitorTimer = setInterval(() => monitor.poll(), 500);
        monitor.poll();
    }
}

export function startDetachedService(cliPath: string): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const child = spawn(process.execPath, [cliPath, 'service', 'run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.once('error', error => {
        try {
            appendLog(`后台服务进程启动失败: ${error instanceof Error ? error.message : String(error)}`);
        } catch { }
    });
    child.unref();
}

export function installAutostart(cliPath: string): string {
    if (process.platform === 'win32') {
        runWindowsServiceInstaller('Install', cliPath);
        if (fs.existsSync(AUTOSTART_FILE)) fs.unlinkSync(AUTOSTART_FILE);
        const legacyCmd = path.join(path.dirname(AUTOSTART_FILE), 'anti-quota-service.cmd');
        if (fs.existsSync(legacyCmd)) fs.unlinkSync(legacyCmd);

        // npm 的用户 bin 目录在部分旧 CMD 会话中不可见。agy 的 bin 目录已经在
        // Antigravity 用户 PATH 中，额外放置一个独立启动器可让 `anti` 立即可用。
        fs.mkdirSync(path.dirname(WINDOWS_COMMAND_ALIAS), { recursive: true });
        const aliasContent = `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`;
        fs.writeFileSync(WINDOWS_COMMAND_ALIAS, aliasContent, 'utf-8');
    } else {
        fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
        const content = `[Desktop Entry]\nType=Application\nName=Anti Quota Service\nExec=${process.execPath} ${cliPath} service run\nX-GNOME-Autostart-enabled=true\n`;
        fs.writeFileSync(AUTOSTART_FILE, content, { encoding: 'utf-8', mode: 0o755 });
    }
    return process.platform === 'win32' ? getWindowsServiceInstallation()!.serviceName : AUTOSTART_FILE;
}

export function uninstallAutostart(): void {
    if (process.platform === 'win32' && getWindowsServiceInstallation()) {
        runWindowsServiceInstaller('Uninstall', __filename);
    }
    if (fs.existsSync(AUTOSTART_FILE)) fs.unlinkSync(AUTOSTART_FILE);
    if (process.platform === 'win32') {
        const legacyCmd = path.join(path.dirname(AUTOSTART_FILE), 'anti-quota-service.cmd');
        if (fs.existsSync(legacyCmd)) fs.unlinkSync(legacyCmd);
    }
}
