import * as crypto from 'crypto';
import { execFile as nodeExecFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadHttpsFile, requestHttps } from '../services/networkService';

export const RELEASE_API_URL = 'https://api.github.com/repos/pinyinjj/anti-quota-fork-staging/releases/latest';

const PACKAGE_NAME = 'anti-quota';
const RELEASE_REPOSITORY_PATH = '/pinyinjj/anti-quota-fork-staging/releases/download/';
const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024;
const MAX_TGZ_BYTES = 50 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 16 * 1024;
const UPDATE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const LOCK_STALE_MS = 30 * 60_000;
const SERVICE_START_GATE_DIRECTORY = 'service-start.lock';
const SERVICE_START_GATE_OWNER_FILE = 'owner.json';
const SERVICE_START_GATE_WAIT_MS = 15_000;
const SERVICE_START_GATE_RETRY_MS = 25;
const SERVICE_START_GATE_INVALID_STALE_MS = 2 * 60_000;
export const UNSAFE_INSTALL_MARKER_FILE = 'unsafe-install.json';
const CLI_ENTRY_PATH = path.join('out', 'cli', 'cli.js');
const REQUIRED_CLI_BINS = ['anti', 'anti-quota', 'aq'] as const;
const DOWNLOAD_HOSTS = [
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
];

interface DownloadOptions {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    allowedHosts: string[];
    headers?: Record<string, string>;
}

interface ExecResult {
    stdout: string;
    stderr: string;
}

type RequestHttps = typeof requestHttps;
type DownloadHttpsFile = (
    url: string,
    destination: string,
    options: DownloadOptions
) => Promise<unknown>;
type ExecFile = (
    executable: string,
    args: string[],
    options: { cwd: string; timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv }
) => Promise<ExecResult>;

/**
 * 可注入的副作用接口。生产调用通常无需传参；回归测试用它隔离网络和 npm。
 */
export interface UpdateRuntime {
    requestHttps?: RequestHttps;
    downloadHttpsFile?: DownloadHttpsFile;
    execFile?: ExecFile;
    packageRoot?: string;
    stateDirectory?: string;
    temporaryDirectory?: string;
    currentVersion?: string;
    platform?: NodeJS.Platform;
    now?: () => number;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
    npmCliPath?: string;
}

export interface ReleaseAsset {
    name: string;
    url: string;
    size: number;
}

export interface UpdateRelease {
    version: string;
    tagName: string;
    htmlUrl?: string;
    publishedAt?: string;
    tgz: ReleaseAsset;
    checksum: ReleaseAsset;
}

export interface UpdateCheckResult {
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    release: UpdateRelease;
}

export interface UpdateInstallResult extends UpdateCheckResult {
    installed: boolean;
}

export interface UpdateInstallOptions {
    /** 允许在 latest Release 与当前版本相同时重新安装；不会降级。 */
    force?: boolean;
    /** 由 withUpdateLock 提供，用于把服务停止/恢复纳入同一更新事务。 */
    lock?: UpdateLock;
    /**
     * 更新预检时已经观察到的最低安全版本。安装器会再次读取 latest Release，
     * 因此必须在任何下载或 npm 操作前防止 Release 漂移造成降级。
     */
    minimumVersion?: string;
}

/**
 * npm 已开始替换全局包后的安装失败。
 *
 * 上层必须在 serviceSafeToRestore=false 时保持后台服务停止，避免从一个未能完成
 * 回滚校验的安装目录启动进程。backupPath 只在自动回滚失败、备份被保留时提供。
 */
export class UpdateInstallError extends Error {
    readonly rollbackAttempted = true;

    constructor(
        message: string,
        readonly rollbackSucceeded: boolean,
        readonly serviceSafeToRestore: boolean,
        readonly backupPath?: string,
        readonly updateCause?: unknown,
        readonly rollbackCause?: unknown,
        /** 无法写入持久阻断标记时保留 update.lock，避免未验证服务被启动。 */
        readonly retainUpdateLock: boolean = false
    ) {
        super(message);
        this.name = 'UpdateInstallError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export interface UpdateLock {
    readonly stateDirectory: string;
}

const activeUpdateLocks = new WeakSet<UpdateLock>();

interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: Array<number | string>;
}

interface GitHubAsset {
    name?: unknown;
    browser_download_url?: unknown;
    size?: unknown;
}

interface GitHubRelease {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
}

function defaultPackageRoot(): string {
    // src/cli/update.ts 与编译后的 out/cli/update.js 距包根目录层级相同。
    return path.resolve(__dirname, '..', '..');
}

function parseVersion(value: string): ParsedVersion {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
    if (!match) throw new Error(`版本号格式无效: ${value}`);

    const parseNumericIdentifier = (identifier: string): number => {
        const parsed = Number(identifier);
        if (!Number.isSafeInteger(parsed)) {
            throw new Error(`版本号格式无效: ${value}`);
        }
        return parsed;
    };
    const prerelease = match[4]
        ? match[4].split('.').map(identifier => {
            if (/^\d+$/.test(identifier)) {
                if (identifier.length > 1 && identifier.startsWith('0')) {
                    throw new Error(`版本号格式无效: ${value}`);
                }
                return parseNumericIdentifier(identifier);
            }
            return identifier;
        })
        : [];
    return {
        major: parseNumericIdentifier(match[1]),
        minor: parseNumericIdentifier(match[2]),
        patch: parseNumericIdentifier(match[3]),
        prerelease,
    };
}

/** 按 SemVer 2.0.0 优先级比较版本；返回 -1、0 或 1。 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (a[key] < b[key]) return -1;
        if (a[key] > b[key]) return 1;
    }

    if (!a.prerelease.length && !b.prerelease.length) return 0;
    if (!a.prerelease.length) return 1;
    if (!b.prerelease.length) return -1;
    const count = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < count; index++) {
        const aPart = a.prerelease[index];
        const bPart = b.prerelease[index];
        if (aPart === undefined) return -1;
        if (bPart === undefined) return 1;
        if (aPart === bPart) continue;
        if (typeof aPart === 'number' && typeof bPart === 'string') return -1;
        if (typeof aPart === 'string' && typeof bPart === 'number') return 1;
        return aPart < bPart ? -1 : 1;
    }
    return 0;
}

/** 读取当前 CLI 包版本。 */
export function getCurrentVersion(runtime: UpdateRuntime = {}): string {
    if (runtime.currentVersion !== undefined) {
        parseVersion(runtime.currentVersion);
        return runtime.currentVersion.replace(/^v/, '');
    }
    const packageFile = path.join(runtime.packageRoot || defaultPackageRoot(), 'package.json');
    let parsed: { name?: unknown; version?: unknown };
    try {
        parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { name?: unknown; version?: unknown };
    } catch (error) {
        throw new Error(`无法读取 Anti Quota 版本信息: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.name !== PACKAGE_NAME || typeof parsed.version !== 'string') {
        throw new Error('当前目录不是有效的 Anti Quota CLI 安装');
    }
    parseVersion(parsed.version);
    return parsed.version.replace(/^v/, '');
}

function validateAssetUrl(value: string): void {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('Release 资产下载地址无效');
    }
    if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(parsed.hostname.toLowerCase())) {
        throw new Error(`Release 资产使用了不受信任的下载地址: ${parsed.hostname || parsed.protocol}`);
    }
    if (parsed.hostname.toLowerCase() === 'github.com'
        && !parsed.pathname.toLowerCase().startsWith(RELEASE_REPOSITORY_PATH)) {
        throw new Error('Release 资产不属于预期的 GitHub 仓库');
    }
}

function strictAsset(asset: GitHubAsset, expectedName: string, maxBytes: number): ReleaseAsset {
    if (asset.name !== expectedName || typeof asset.browser_download_url !== 'string') {
        throw new Error(`Release 资产 ${expectedName} 的元数据无效`);
    }
    if (!Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || (asset.size as number) > maxBytes) {
        throw new Error(`Release 资产 ${expectedName} 的大小无效`);
    }
    validateAssetUrl(asset.browser_download_url);
    return { name: expectedName, url: asset.browser_download_url, size: asset.size as number };
}

function parseRelease(value: unknown): UpdateRelease {
    if (!value || typeof value !== 'object') throw new Error('GitHub Release 响应格式无效');
    const release = value as GitHubRelease;
    if (release.draft !== false || release.prerelease !== false) {
        throw new Error('拒绝安装草稿或预发布版本');
    }
    if (typeof release.tag_name !== 'string') throw new Error('GitHub Release 缺少版本标签');
    const parsedTag = parseVersion(release.tag_name);
    if (parsedTag.prerelease.length) throw new Error('拒绝安装预发布版本');
    const version = release.tag_name.trim().replace(/^v/, '');
    if (!Array.isArray(release.assets)) throw new Error('GitHub Release 缺少资产列表');

    const tgzName = `${PACKAGE_NAME}-${version}.tgz`;
    const checksumName = `${tgzName}.sha256`;
    const tgzMatches = (release.assets as GitHubAsset[]).filter(asset => asset?.name === tgzName);
    const checksumMatches = (release.assets as GitHubAsset[]).filter(asset => asset?.name === checksumName);
    if (tgzMatches.length !== 1 || checksumMatches.length !== 1) {
        throw new Error(`Release 必须且只能包含一组 ${tgzName} 与 ${checksumName}`);
    }

    return {
        version,
        tagName: release.tag_name,
        htmlUrl: typeof release.html_url === 'string' ? release.html_url : undefined,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
        tgz: strictAsset(tgzMatches[0], tgzName, MAX_TGZ_BYTES),
        checksum: strictAsset(checksumMatches[0], checksumName, MAX_CHECKSUM_BYTES),
    };
}

/** 查询公开 GitHub 仓库的 latest Release，不下载或安装任何文件。 */
export async function checkForUpdate(runtime: UpdateRuntime = {}): Promise<UpdateCheckResult> {
    const currentVersion = getCurrentVersion(runtime);
    const requester = runtime.requestHttps || requestHttps;
    const response = await requester(RELEASE_API_URL, {
        method: 'GET',
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `anti-quota/${currentVersion}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    }, undefined, UPDATE_TIMEOUT_MS, MAX_RELEASE_RESPONSE_BYTES);
    if (response.status !== 200) {
        throw new Error(`检查更新失败：GitHub API 返回 HTTP ${response.status}`);
    }
    if (Buffer.byteLength(response.body, 'utf8') > MAX_RELEASE_RESPONSE_BYTES) {
        throw new Error('检查更新失败：GitHub Release 响应过大');
    }
    let metadata: unknown;
    try {
        metadata = JSON.parse(response.body);
    } catch {
        throw new Error('检查更新失败：GitHub Release 响应不是有效 JSON');
    }
    const release = parseRelease(metadata);
    return {
        currentVersion,
        latestVersion: release.version,
        updateAvailable: compareVersions(currentVersion, release.version) < 0,
        release,
    };
}

export type InstallationKind = 'package' | 'development-checkout' | 'npm-link';

/** 识别会被自更新破坏或产生歧义的开发安装。 */
export function detectInstallationKind(runtime: UpdateRuntime = {}): InstallationKind {
    const packageRoot = path.resolve(runtime.packageRoot || defaultPackageRoot());
    try {
        if (fs.lstatSync(packageRoot).isSymbolicLink()) return 'npm-link';
        const realRoot = fs.realpathSync(packageRoot);
        const normalizeForComparison = (value: string) => {
            const resolved = path.resolve(value);
            return (runtime.platform || process.platform) === 'win32' ? resolved.toLowerCase() : resolved;
        };
        if (normalizeForComparison(realRoot) !== normalizeForComparison(packageRoot)) return 'npm-link';
    } catch (error) {
        throw new Error(`无法检查 CLI 安装位置: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (fs.existsSync(path.join(packageRoot, '.git'))) return 'development-checkout';
    return 'package';
}

export function assertUpdatableInstallation(runtime: UpdateRuntime = {}): void {
    const kind = detectInstallationKind(runtime);
    if (kind === 'development-checkout') {
        throw new Error('当前 CLI 来自 Git 开发工作区，已拒绝自动覆盖；请先提交代码，再使用正式 TGZ 安装');
    }
    if (kind === 'npm-link') {
        throw new Error('当前 CLI 通过 npm link 链接到开发目录，已拒绝自动覆盖；请先运行 npm unlink -g anti-quota 并安装正式 TGZ');
    }
}

function defaultIsProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function resolveUpdateStateDirectory(runtime: UpdateRuntime): string {
    return path.resolve(runtime.stateDirectory || path.join(os.homedir(), '.anti-quota'));
}

function resolveUpdateLockPath(runtime: UpdateRuntime): string {
    return path.join(resolveUpdateStateDirectory(runtime), 'update.lock');
}

function resolveServiceStartGatePath(runtime: UpdateRuntime): string {
    return path.join(resolveUpdateStateDirectory(runtime), SERVICE_START_GATE_DIRECTORY);
}

function resolveUnsafeInstallMarkerPath(runtime: UpdateRuntime): string {
    return path.join(resolveUpdateStateDirectory(runtime), UNSAFE_INSTALL_MARKER_FILE);
}

/** 未验证安装存在时，所有可能启动服务的入口都必须失败关闭。 */
export function assertInstallationSafeToStart(runtime: UpdateRuntime = {}): void {
    const markerPath = resolveUnsafeInstallMarkerPath(runtime);
    if (fs.existsSync(markerPath)) {
        throw new Error(
            `检测到未完成恢复的 Anti Quota 安装，已拒绝启动服务。`
            + `请查看 ${markerPath}，按其中 backupPath 手动恢复后运行 anti update --force`
        );
    }
}

async function persistUnsafeInstallMarker(
    runtime: UpdateRuntime,
    details: Record<string, unknown>
): Promise<boolean> {
    const markerPath = resolveUnsafeInstallMarkerPath(runtime);
    let handle: fs.promises.FileHandle | undefined;
    try {
        await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
        handle = await fs.promises.open(markerPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(details, null, 2)}\n`, 'utf8');
        await handle.sync();
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' || fs.existsSync(markerPath)) {
            return true;
        }
        return false;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function clearUnsafeInstallMarker(runtime: UpdateRuntime): Promise<void> {
    try {
        await fs.promises.unlink(resolveUnsafeInstallMarkerPath(runtime));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

/** 拒绝在另一个更新事务持有进程间锁时执行会与更新冲突的 CLI 操作。 */
export function assertNoUpdateInProgress(runtime: UpdateRuntime = {}): void {
    if (fs.existsSync(resolveUpdateLockPath(runtime))) {
        throw new Error('已有 Anti Quota 更新正在进行，请稍后重试');
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function reclaimStaleServiceStartGate(
    runtime: UpdateRuntime,
    gatePath: string
): Promise<boolean> {
    const now = runtime.now || Date.now;
    const isProcessAlive = runtime.isProcessAlive || defaultIsProcessAlive;
    let stale = false;
    try {
        const [contents, stats] = await Promise.all([
            fs.promises.readFile(path.join(gatePath, SERVICE_START_GATE_OWNER_FILE), 'utf8'),
            fs.promises.stat(gatePath),
        ]);
        const owner = JSON.parse(contents) as { pid?: unknown; createdAt?: unknown };
        const ownerPid = typeof owner.pid === 'number' ? owner.pid : 0;
        const createdAt = typeof owner.createdAt === 'number' ? owner.createdAt : stats.mtimeMs;
        stale = Number.isSafeInteger(ownerPid) && ownerPid > 0
            ? !isProcessAlive(ownerPid)
            : now() - createdAt > SERVICE_START_GATE_INVALID_STALE_MS;
    } catch {
        const stats = await fs.promises.stat(gatePath).catch(() => undefined);
        stale = !!stats && now() - stats.mtimeMs > SERVICE_START_GATE_INVALID_STALE_MS;
    }
    if (!stale) return false;

    // 先用原子 rename 独占这一个陈旧实例，再清理隔离目录。这样多个清理者不会
    // 在 unlink/rmdir 与下一位持有者创建门禁之间误删新门禁。
    const quarantine = `${gatePath}.stale-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
        await fs.promises.rename(gatePath, quarantine);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
    }
    await fs.promises.rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
    return true;
}

async function acquireServiceStartGate(
    runtime: UpdateRuntime
): Promise<() => Promise<void>> {
    const stateDirectory = resolveUpdateStateDirectory(runtime);
    const gatePath = resolveServiceStartGatePath(runtime);
    const now = runtime.now || Date.now;
    const pid = runtime.pid ?? process.pid;
    const token = crypto.randomBytes(16).toString('hex');
    const payload = JSON.stringify({ pid, createdAt: now(), token });
    const deadline = Date.now() + SERVICE_START_GATE_WAIT_MS;
    await fs.promises.mkdir(stateDirectory, { recursive: true });

    while (true) {
        try {
            await fs.promises.mkdir(gatePath, { mode: 0o700 });
            let ownerHandle: fs.promises.FileHandle | undefined;
            try {
                ownerHandle = await fs.promises.open(
                    path.join(gatePath, SERVICE_START_GATE_OWNER_FILE),
                    'wx',
                    0o600
                );
                await ownerHandle.writeFile(payload, 'utf8');
                await ownerHandle.sync();
                await ownerHandle.close();
                ownerHandle = undefined;
            } catch (error) {
                await ownerHandle?.close().catch(() => undefined);
                await fs.promises.rm(gatePath, { recursive: true, force: true }).catch(() => undefined);
                throw error;
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await reclaimStaleServiceStartGate(runtime, gatePath)) continue;
            if (Date.now() >= deadline) {
                throw new Error('等待 Anti Quota 服务启动/更新门禁超时，请稍后重试');
            }
            await delay(SERVICE_START_GATE_RETRY_MS);
        }
    }

    return async () => {
        let current: string;
        try {
            current = await fs.promises.readFile(
                path.join(gatePath, SERVICE_START_GATE_OWNER_FILE),
                'utf8'
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error('Anti Quota 服务启动/更新门禁在持有期间丢失');
            }
            throw error;
        }
        if (current !== payload) {
            throw new Error('Anti Quota 服务启动/更新门禁所有权已改变');
        }

        const quarantine = `${gatePath}.release-${pid}-${token}`;
        try {
            await fs.promises.rename(gatePath, quarantine);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error('Anti Quota 服务启动/更新门禁在持有期间丢失');
            }
            throw error;
        }
        // rename 已经原子释放真实门禁；隔离目录清理失败不应重新阻塞启动或更新。
        await fs.promises.rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
    };
}

/**
 * 串行化服务启动的“安全检查 -> listen”与更新锁创建。
 * 门禁只覆盖短暂交接区间，绝不在服务整个生命周期或完整更新事务中持有。
 */
export async function withServiceStartupGate<T>(
    runtime: UpdateRuntime,
    action: () => Promise<T>
): Promise<T> {
    const release = await acquireServiceStartGate(runtime);
    try {
        return await action();
    } finally {
        await release();
    }
}

async function acquireUpdateLock(runtime: UpdateRuntime): Promise<(retain?: boolean) => Promise<void>> {
    const stateDirectory = resolveUpdateStateDirectory(runtime);
    const lockPath = resolveUpdateLockPath(runtime);
    const now = runtime.now || Date.now;
    const pid = runtime.pid ?? process.pid;
    const isProcessAlive = runtime.isProcessAlive || defaultIsProcessAlive;
    await fs.promises.mkdir(stateDirectory, { recursive: true });

    const token = crypto.randomBytes(16).toString('hex');
    const payload = JSON.stringify({ pid, createdAt: now(), token });
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(lockPath, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        let stale = false;
        try {
            const [contents, stats] = await Promise.all([
                fs.promises.readFile(lockPath, 'utf8'),
                fs.promises.stat(lockPath),
            ]);
            const existing = JSON.parse(contents) as { pid?: unknown; createdAt?: unknown };
            const existingPid = typeof existing.pid === 'number' ? existing.pid : 0;
            const createdAt = typeof existing.createdAt === 'number' ? existing.createdAt : stats.mtimeMs;
            stale = now() - createdAt > LOCK_STALE_MS && !isProcessAlive(existingPid);
        } catch {
            const stats = await fs.promises.stat(lockPath).catch(() => undefined);
            stale = !!stats && now() - stats.mtimeMs > LOCK_STALE_MS;
        }

        if (stale) {
            throw new Error(
                `检测到可能由异常退出遗留的更新锁: ${lockPath}；`
                + '确认没有 Anti Quota 更新进程后，请手动删除该文件再重试'
            );
        }
        throw new Error('已有 Anti Quota 更新正在进行，请稍后重试');
    }

    try {
        await handle.writeFile(payload, 'utf8');
    } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.unlink(lockPath).catch(() => undefined);
        throw error;
    }

    return async (retain = false) => {
        await handle?.close().catch(() => undefined);
        let current: string;
        try {
            current = await fs.promises.readFile(lockPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error('更新事务锁在释放前丢失，无法确认更新期间的服务启动隔离');
            }
            throw error;
        }
        if (current !== payload) {
            throw new Error('更新事务锁所有权已变化，无法确认更新期间的服务启动隔离');
        }
        if (!retain) {
            try {
                await fs.promises.unlink(lockPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    throw new Error('更新事务锁在释放时丢失，无法确认更新期间的服务启动隔离');
                }
                throw error;
            }
        }
    };
}

/** 在同一把进程间锁内执行完整更新事务。 */
export async function withUpdateLock<T>(
    runtime: UpdateRuntime,
    action: (lock: UpdateLock) => Promise<T>
): Promise<T> {
    // 必须先取得与服务启动共享的门禁，再原子发布 update.lock。服务要么已经
    // 完成 listen（随后会被更新器探测并停止），要么会在门禁内看到此锁并拒绝启动。
    const release = await withServiceStartupGate(runtime, () => acquireUpdateLock(runtime));
    const lock = Object.freeze({
        stateDirectory: resolveUpdateStateDirectory(runtime),
    });
    activeUpdateLocks.add(lock);
    let retainLock = false;
    try {
        return await action(lock);
    } catch (error) {
        retainLock = error instanceof UpdateInstallError && error.retainUpdateLock;
        throw error;
    } finally {
        activeUpdateLocks.delete(lock);
        await release(retainLock);
    }
}

function parseExpectedChecksum(contents: string, expectedFileName: string): string {
    const value = contents.trim();
    if (/^[a-fA-F0-9]{64}$/.test(value)) return value.toLowerCase();
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(value);
    if (!match || match[2].trim() !== expectedFileName) {
        throw new Error('SHA256 文件格式无效或与 TGZ 文件名不匹配');
    }
    return match[1].toLowerCase();
}

async function sha256(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

function defaultExecFile(
    executable: string,
    args: string[],
    options: { cwd: string; timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv }
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        nodeExecFile(executable, args, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

export interface NpmInvocation {
    executable: string;
    argsPrefix: string[];
}

/**
 * Windows 不能用 execFile 直接执行 npm.cmd（Node 会抛 spawn EINVAL），因此优先让
 * 当前 node.exe 运行 npm-cli.js。非 Windows 在找不到 JS 入口时才回退到 PATH 中的 npm。
 */
export function resolveNpmInvocation(runtime: UpdateRuntime = {}): NpmInvocation {
    const explicit = runtime.npmCliPath;
    const candidates = explicit ? [explicit] : [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter((value): value is string => !!value);

    for (const candidate of candidates) {
        if (!/^npm-cli\.(?:js|cjs)$/i.test(path.basename(candidate))) {
            if (explicit) throw new Error(`指定的 npm CLI 不是 npm-cli.js: ${candidate}`);
            continue;
        }
        try {
            if (fs.statSync(candidate).isFile()) {
                return { executable: process.execPath, argsPrefix: [candidate] };
            }
        } catch {
            // 继续检查下一个标准安装位置。
        }
    }

    if (explicit) throw new Error(`找不到指定的 npm CLI: ${explicit}`);
    if ((runtime.platform || process.platform) === 'win32') {
        throw new Error('找不到 npm-cli.js；请修复 Node.js/npm 安装后重试');
    }
    return { executable: 'npm', argsPrefix: [] };
}

function parseInspectedPackage(stdout: string, expectedVersion: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new Error('npm 无法读取下载的 TGZ 元数据');
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error('下载的 TGZ 必须只包含一个 npm 包');
    }
    const manifest = parsed[0] as { name?: unknown; version?: unknown };
    if (manifest.name !== PACKAGE_NAME || manifest.version !== expectedVersion) {
        throw new Error(
            `下载的 TGZ 包标识不匹配：期望 ${PACKAGE_NAME}@${expectedVersion}`
        );
    }
}

function normalizePathForComparison(value: string, platform: NodeJS.Platform): string {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseGlobalNpmRoot(stdout: string): string {
    const npmRoot = stdout.trim();
    if (!npmRoot || /[\r\n]/.test(npmRoot) || !path.isAbsolute(npmRoot)) {
        throw new Error('npm root --global 未返回有效的全局包目录，已取消安装');
    }
    return path.resolve(npmRoot);
}

function assertMatchingGlobalPackageRoot(
    npmRoot: string,
    packageRoot: string,
    platform: NodeJS.Platform
): void {
    const expectedPackageRoot = path.join(npmRoot, PACKAGE_NAME);
    if (normalizePathForComparison(expectedPackageRoot, platform)
        !== normalizePathForComparison(packageRoot, platform)) {
        throw new Error(
            `npm 全局包目录与当前 CLI 安装位置不一致，已取消安装：`
            + `npm 将更新 ${expectedPackageRoot}，当前 CLI 位于 ${path.resolve(packageRoot)}`
        );
    }
}

function validateInstalledPackage(packageRoot: string, expectedVersion: string): string {
    const packageFile = path.join(packageRoot, 'package.json');
    let manifest: { name?: unknown; version?: unknown; bin?: unknown };
    try {
        manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
            name?: unknown;
            version?: unknown;
            bin?: unknown;
        };
    } catch (error) {
        throw new Error(
            `npm 已返回成功，但无法读取新安装的 package.json: `
            + `${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (manifest.name !== PACKAGE_NAME || manifest.version !== expectedVersion
        || !manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) {
        throw new Error(`npm 已返回成功，但新安装包不是有效的 ${PACKAGE_NAME}@${expectedVersion}`);
    }

    const expectedEntry = path.resolve(packageRoot, CLI_ENTRY_PATH);
    const bins = manifest.bin as Record<string, unknown>;
    for (const command of REQUIRED_CLI_BINS) {
        const configuredEntry = bins[command];
        if (typeof configuredEntry !== 'string'
            || path.resolve(packageRoot, configuredEntry) !== expectedEntry) {
            throw new Error(
                `npm 已返回成功，但新安装包的 bin.${command} 未指向 out/cli/cli.js`
            );
        }
    }

    try {
        if (!fs.statSync(expectedEntry).isFile()) throw new Error('入口不是文件');
    } catch (error) {
        throw new Error(
            `npm 已返回成功，但新安装的 CLI 入口不存在: ${expectedEntry}`
            + `${error instanceof Error ? ` (${error.message})` : ''}`
        );
    }
    return expectedEntry;
}

function validateVersionSmoke(stdout: string, expectedVersion: string): void {
    let result: unknown;
    try {
        result = JSON.parse(stdout);
    } catch {
        throw new Error('新安装的 CLI version --json 未返回有效 JSON');
    }
    if (!result || typeof result !== 'object'
        || (result as { cliVersion?: unknown }).cliVersion !== expectedVersion) {
        throw new Error(`新安装的 CLI 自检版本不匹配，期望 ${expectedVersion}`);
    }
}

interface NpmPackFile {
    path?: unknown;
}

interface NpmPackResult {
    name?: unknown;
    version?: unknown;
    filename?: unknown;
    files?: unknown;
}

function parseRollbackBackup(
    stdout: string,
    expectedVersion: string,
    backupDirectory: string
): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new Error('npm 未返回有效的回滚备份元数据');
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error('npm 必须只生成一个回滚备份包');
    }

    const result = parsed[0] as NpmPackResult;
    if (result.name !== PACKAGE_NAME || result.version !== expectedVersion) {
        throw new Error(`回滚备份包标识不匹配：期望 ${PACKAGE_NAME}@${expectedVersion}`);
    }
    if (typeof result.filename !== 'string' || !result.filename.trim()) {
        throw new Error('npm 回滚备份缺少文件名');
    }

    const backupRoot = path.resolve(backupDirectory);
    const backupPath = path.resolve(backupRoot, result.filename);
    const relative = path.relative(backupRoot, backupPath);
    if (!relative || path.isAbsolute(relative) || relative === '..'
        || relative.startsWith(`..${path.sep}`)) {
        throw new Error('npm 回滚备份文件名超出临时备份目录');
    }

    const files = Array.isArray(result.files) ? result.files as NpmPackFile[] : [];
    const hasCliEntry = files.some(file => typeof file?.path === 'string'
        && file.path.replace(/\\/g, '/').replace(/^\.?\//, '') === CLI_ENTRY_PATH.replace(/\\/g, '/'));
    if (!hasCliEntry) {
        throw new Error(`回滚备份不包含 ${CLI_ENTRY_PATH.replace(/\\/g, '/')}`);
    }

    try {
        const stats = fs.statSync(backupPath);
        if (!stats.isFile() || stats.size <= 0) throw new Error('备份不是非空文件');
    } catch (error) {
        throw new Error(
            `npm 未生成可用的回滚备份: `
            + `${error instanceof Error ? error.message : String(error)}`
        );
    }
    return backupPath;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 下载、校验并通过 npm 全局安装最新版 CLI。此流程不会下载或安装 VSIX。
 */
export async function installLatestUpdate(
    runtime: UpdateRuntime = {},
    options: UpdateInstallOptions = {}
): Promise<UpdateInstallResult> {
    assertUpdatableInstallation(runtime);
    if (!options.lock) {
        return withUpdateLock(runtime, lock => installLatestUpdate(runtime, { ...options, lock }));
    }
    const expectedStateDirectory = resolveUpdateStateDirectory(runtime);
    if (!activeUpdateLocks.has(options.lock)
        || options.lock.stateDirectory !== expectedStateDirectory) {
        throw new Error('更新事务锁无效或已经释放');
    }
    const unsafeMarkerExistedBeforeUpdate = fs.existsSync(resolveUnsafeInstallMarkerPath(runtime));

    let temporaryDirectory: string | undefined;
    let preserveTemporaryDirectory = false;
    try {
        const check = await checkForUpdate(runtime);
        if (options.minimumVersion
            && compareVersions(check.latestVersion, options.minimumVersion) < 0) {
            throw new Error(
                `公开最新版 ${check.latestVersion} 低于本次更新允许的最低版本 ${options.minimumVersion}，`
                + '已拒绝自动降级'
            );
        }
        const comparison = compareVersions(check.currentVersion, check.latestVersion);
        if (comparison > 0) {
            throw new Error(`当前版本 ${check.currentVersion} 高于公开最新版 ${check.latestVersion}，已拒绝自动降级`);
        }
        const sameVersion = comparison === 0;
        if (!check.updateAvailable && !(options.force && sameVersion)) {
            return { ...check, installed: false };
        }

        const temporaryRoot = runtime.temporaryDirectory || os.tmpdir();
        await fs.promises.mkdir(temporaryRoot, { recursive: true });
        temporaryDirectory = await fs.promises.mkdtemp(path.join(temporaryRoot, 'anti-quota-update-'));
        const tgzPath = path.join(temporaryDirectory, check.release.tgz.name);
        const checksumPath = path.join(temporaryDirectory, check.release.checksum.name);
        const downloader = runtime.downloadHttpsFile || downloadHttpsFile;
        const commonOptions = {
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            maxRedirects: 5,
            allowedHosts: [...DOWNLOAD_HOSTS],
            headers: { 'User-Agent': `anti-quota/${check.currentVersion}` },
        };
        await downloader(check.release.checksum.url, checksumPath, {
            ...commonOptions,
            maxBytes: MAX_CHECKSUM_BYTES,
        });
        await downloader(check.release.tgz.url, tgzPath, {
            ...commonOptions,
            maxBytes: MAX_TGZ_BYTES,
        });

        const [checksumStats, tgzStats] = await Promise.all([
            fs.promises.stat(checksumPath),
            fs.promises.stat(tgzPath),
        ]);
        if (!checksumStats.isFile() || checksumStats.size !== check.release.checksum.size) {
            throw new Error('SHA256 文件大小与 GitHub Release 元数据不一致');
        }
        if (!tgzStats.isFile() || tgzStats.size !== check.release.tgz.size) {
            throw new Error('TGZ 文件大小与 GitHub Release 元数据不一致');
        }
        const checksumContents = await fs.promises.readFile(checksumPath, 'utf8');
        const expected = parseExpectedChecksum(checksumContents, check.release.tgz.name);
        const actual = await sha256(tgzPath);
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
            throw new Error('TGZ 的 SHA256 校验失败，已取消安装');
        }

        const npmInvocation = resolveNpmInvocation(runtime);
        const executor = runtime.execFile || defaultExecFile;
        const commandOptions = {
            cwd: temporaryDirectory,
            timeout: NPM_TIMEOUT_MS,
            windowsHide: true,
            env: {
                ...process.env,
                npm_config_update_notifier: 'false',
            },
        };
        const inspection = await executor(npmInvocation.executable, [
            ...npmInvocation.argsPrefix,
            'pack',
            '--dry-run',
            '--json',
            '--ignore-scripts',
            tgzPath,
            '--cache',
            path.join(temporaryDirectory, 'npm-cache'),
            '--no-audit',
            '--no-fund',
        ], commandOptions);
        parseInspectedPackage(inspection.stdout, check.latestVersion);

        const npmRootResult = await executor(npmInvocation.executable, [
            ...npmInvocation.argsPrefix,
            'root',
            '--global',
        ], commandOptions);
        const npmRoot = parseGlobalNpmRoot(npmRootResult.stdout);
        const packageRoot = path.resolve(runtime.packageRoot || defaultPackageRoot());
        assertMatchingGlobalPackageRoot(
            npmRoot,
            packageRoot,
            runtime.platform || process.platform
        );

        // 在 npm 可能开始替换全局包前，先验证当前正式安装并把它打成独立 TGZ。
        // 不能直接从备份目录安装，否则 npm 会创建指向即将清理的临时目录的链接。
        validateInstalledPackage(packageRoot, check.currentVersion);
        const backupDirectory = path.join(temporaryDirectory, 'rollback');
        await fs.promises.mkdir(backupDirectory, { recursive: true });
        const packed = await executor(npmInvocation.executable, [
            ...npmInvocation.argsPrefix,
            'pack',
            '--json',
            '--ignore-scripts',
            packageRoot,
            '--pack-destination',
            backupDirectory,
            '--cache',
            path.join(temporaryDirectory, 'npm-cache'),
            '--no-audit',
            '--no-fund',
        ], commandOptions);
        const backupPath = parseRollbackBackup(
            packed.stdout,
            check.currentVersion,
            backupDirectory
        );

        try {
            // installationStarted 以调用 npm 前为边界：npm 抛错也可能已经部分替换目录。
            await executor(npmInvocation.executable, [
                ...npmInvocation.argsPrefix,
                'install',
                '--global',
                tgzPath,
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
            ], commandOptions);

            const installedEntry = validateInstalledPackage(packageRoot, check.latestVersion);
            const smoke = await executor(process.execPath, [
                installedEntry,
                'version',
                '--json',
            ], { ...commandOptions, cwd: packageRoot, timeout: UPDATE_TIMEOUT_MS });
            validateVersionSmoke(smoke.stdout, check.latestVersion);
            await clearUnsafeInstallMarker(runtime);
            return { ...check, installed: true };
        } catch (updateError) {
            try {
                await executor(npmInvocation.executable, [
                    ...npmInvocation.argsPrefix,
                    'install',
                    '--global',
                    backupPath,
                    '--ignore-scripts',
                    '--no-audit',
                    '--no-fund',
                ], commandOptions);
                const restoredEntry = validateInstalledPackage(packageRoot, check.currentVersion);
                const restoredSmoke = await executor(process.execPath, [
                    restoredEntry,
                    'version',
                    '--json',
                ], { ...commandOptions, cwd: packageRoot, timeout: UPDATE_TIMEOUT_MS });
                validateVersionSmoke(restoredSmoke.stdout, check.currentVersion);
            } catch (rollbackError) {
                // 自动回滚失败时保留备份，既不能把临时目录清掉，也不能让上层启动服务。
                preserveTemporaryDirectory = true;
                const markerWritten = await persistUnsafeInstallMarker(runtime, {
                    createdAt: new Date().toISOString(),
                    previousVersion: check.currentVersion,
                    targetVersion: check.latestVersion,
                    backupPath,
                    updateError: errorMessage(updateError),
                    rollbackError: errorMessage(rollbackError),
                });
                throw new UpdateInstallError(
                    `CLI 更新失败，且自动回滚旧版本 ${check.currentVersion} 失败。`
                    + `更新错误: ${errorMessage(updateError)}；`
                    + `回滚错误: ${errorMessage(rollbackError)}；`
                    + `可恢复备份已保留在 ${backupPath}；`
                    + (markerWritten
                        ? `服务启动阻断标记已写入 ${resolveUnsafeInstallMarkerPath(runtime)}`
                        : '无法写入服务启动阻断标记，update.lock 将保留，请勿手动删除直至完成恢复'),
                    false,
                    false,
                    backupPath,
                    updateError,
                    rollbackError,
                    !markerWritten
                );
            }
            throw new UpdateInstallError(
                `CLI 更新失败，已恢复并验证旧版本 ${check.currentVersion}: ${errorMessage(updateError)}`
                + (unsafeMarkerExistedBeforeUpdate
                    ? '；更新前已有未完成恢复标记，已保留该标记且不会恢复服务'
                    : ''),
                true,
                !unsafeMarkerExistedBeforeUpdate,
                undefined,
                updateError
            );
        }
    } finally {
        if (temporaryDirectory && !preserveTemporaryDirectory) {
            await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
