/**
 * Antigravity IDE 服务 (v12.0 - 精简版)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';
import { execSync, spawn } from 'child_process';

// ============ 路径配置 ============

export function getDbPath(): string {
    const platform = os.platform();
    const homeDir = os.homedir();
    if (platform === 'darwin') {
        return path.join(homeDir, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
    } else if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData/Roaming');
        return path.join(appData, 'Antigravity/User/globalStorage/state.vscdb');
    } else {
        return path.join(homeDir, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

/** Antigravity CLI (agy) 的官方 OAuth 文件路径。 */
export function getAgyCliTokenPath(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

/** 判断当前机器是否安装/初始化了新版 agy CLI。 */
export function isAgyCliAvailable(): boolean {
    const homeDir = os.homedir();
    const cliDataDir = path.dirname(getAgyCliTokenPath());

    if (fs.existsSync(cliDataDir)) {
        return true;
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData/Local');
        return fs.existsSync(path.join(localAppData, 'agy', 'bin', 'agy.exe'));
    }

    return fs.existsSync(path.join(homeDir, '.local', 'bin', 'agy'));
}

/**
 * 将 Anti Quota 中的账号写入新版 agy CLI 的官方令牌文件。
 * agy 会在下次启动时加载它；已运行的 agy 会话仍需重启。
 */
export function writeAgyCliToken(
    accessToken: string,
    refreshToken: string,
    expiry: number
): void {
    if (!accessToken || !refreshToken) {
        throw new Error('agy CLI Token 不完整');
    }

    const expirySeconds = Number(expiry);
    if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) {
        throw new Error('agy CLI Token 过期时间无效');
    }

    const tokenPath = getAgyCliTokenPath();
    const tokenDir = path.dirname(tokenPath);
    const tempPath = `${tokenPath}.tmp-${process.pid}-${Date.now()}`;
    const payload = {
        auth_method: 'consumer',
        token: {
            access_token: accessToken,
            token_type: 'Bearer',
            refresh_token: refreshToken,
            expiry: new Date(Math.floor(expirySeconds) * 1000).toISOString(),
        },
    };

    fs.mkdirSync(tokenDir, { recursive: true });
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
            encoding: 'utf-8',
            mode: 0o600,
        });
        fs.renameSync(tempPath, tokenPath);
        try {
            fs.chmodSync(tokenPath, 0o600);
        } catch {
            // Windows 使用用户目录继承的 ACL；chmod 语义与 Unix 不同。
        }
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch { }
        throw error;
    }

    console.log('[Antigravity] Updated agy CLI token profile');
}

/** 构造 agy CLI 与 Keyring 共用的 OAuth JSON。 */
function createAgyCliTokenPayload(
    accessToken: string,
    refreshToken: string,
    expiry: number
): string {
    const expirySeconds = Number(expiry);
    if (!accessToken || !refreshToken) {
        throw new Error('agy CLI Token 不完整');
    }
    if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) {
        throw new Error('agy CLI Token 过期时间无效');
    }

    return JSON.stringify({
        auth_method: 'consumer',
        token: {
            access_token: accessToken,
            token_type: 'Bearer',
            refresh_token: refreshToken,
            expiry: new Date(Math.floor(expirySeconds) * 1000).toISOString(),
        },
    });
}

export interface AgyCliAuthFingerprint {
    fingerprint: string;
    payloadFingerprint?: string;
    source: 'windows-keyring' | 'token-file';
}

export type WindowsKeyringFingerprintProbe =
    | { status: 'found'; fingerprint: string; payloadFingerprint?: string }
    | { status: 'not_found' };

export interface AgyCliFingerprintRuntime {
    platform?: NodeJS.Platform;
    probeWindowsKeyring?: () => Promise<WindowsKeyringFingerprintProbe>;
    readTokenFile?: () => { refreshToken: string; accessToken: string } | null;
}

export interface AgyCliAuthWriteRuntime {
    platform?: NodeJS.Platform;
    withAuthWriteLock?: <T>(action: () => Promise<T>) => Promise<T>;
    beforeWrite?: () => Promise<void>;
    captureTokenFile?: () => Buffer | null;
    restoreTokenFile?: (snapshot: Buffer | null) => void;
    writeTokenFile?: (accessToken: string, refreshToken: string, expiry: number) => void;
    readTokenFileFingerprint?: () => string | null;
    writeWindowsKeyring?: (payload: string) => Promise<void>;
    readCurrentFingerprint?: () => Promise<AgyCliAuthFingerprint | null>;
}

const AGY_AUTH_LOCK_TIMEOUT_MS = 35_000;
const AGY_AUTH_LOCK_RETRY_MS = 25;

interface AgyAuthFileWriteLock {
    kind: 'file';
    fd: number;
    token: string;
    path: string;
}

interface AgyAuthPipeWriteLock {
    kind: 'pipe';
    server: net.Server;
}

type AgyAuthWriteLock = AgyAuthFileWriteLock | AgyAuthPipeWriteLock;

/** 仅比较不可逆指纹；不得把原始 Token 写入日志或服务响应。 */
export function fingerprintRefreshToken(refreshToken: string): string {
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        throw new Error('refresh token 不能为空');
    }
    return crypto.createHash('sha256').update(refreshToken, 'utf-8').digest('hex');
}

/** 写后核验完整 OAuth 载荷，避免 refresh token 相同但 access token 仍过期。 */
export function fingerprintCredentialPayload(payload: string): string {
    if (typeof payload !== 'string' || payload.length === 0) {
        throw new Error('credential payload 不能为空');
    }
    return crypto.createHash('sha256').update(payload, 'utf-8').digest('hex');
}

function getWindowsKeyringScriptPath(): string {
    return path.join(__dirname, '../../scripts/update_windows_keyring.ps1');
}

function getAgyAuthWriteLockPath(): string {
    const dataDirectory = process.env.ANTI_QUOTA_DATA_DIR || path.join(os.homedir(), '.anti-quota');
    return path.join(dataDirectory, '.agy-auth.lock');
}

function getAgyAuthPipeName(): string {
    // os.userInfo() can fail in restricted Windows sessions. The normalized home
    // directory is stable per profile, while hashing keeps user details out of IPC names.
    const homeIdentity = path.resolve(os.homedir()).replace(/\\/g, '/').toLowerCase();
    const userHash = crypto.createHash('sha256').update(homeIdentity, 'utf-8').digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\anti-quota-agy-auth-${userHash}`;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquireWindowsAgyAuthWriteLock(): Promise<AgyAuthPipeWriteLock> {
    const pipeName = getAgyAuthPipeName();
    const deadline = Date.now() + AGY_AUTH_LOCK_TIMEOUT_MS;

    while (true) {
        const server = net.createServer(socket => socket.destroy());
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: NodeJS.ErrnoException) => reject(error);
                server.once('error', onError);
                server.listen(pipeName, () => {
                    server.off('error', onError);
                    resolve();
                });
            });
            server.unref();
            return { kind: 'pipe', server };
        } catch (error) {
            try { server.close(); } catch { }
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
            if (Date.now() >= deadline) {
                throw new Error('等待 agy 凭据切换锁超时，请稍后重试');
            }
            await delay(AGY_AUTH_LOCK_RETRY_MS);
        }
    }
}

async function acquireFileAgyAuthWriteLock(): Promise<AgyAuthFileWriteLock> {
    const lockPath = getAgyAuthWriteLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + AGY_AUTH_LOCK_TIMEOUT_MS;

    while (true) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            try {
                fs.writeFileSync(fd, token, 'utf-8');
                fs.fsyncSync(fd);
            } catch (error) {
                try { fs.closeSync(fd); } catch { }
                try { fs.unlinkSync(lockPath); } catch { }
                throw error;
            }
            return { kind: 'file', fd, token, path: lockPath };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) {
                throw new Error(`等待 agy 凭据切换锁超时；若持有进程已异常退出，请删除 ${lockPath} 后重试`);
            }
            await delay(AGY_AUTH_LOCK_RETRY_MS);
        }
    }
}

async function acquireAgyAuthWriteLock(): Promise<AgyAuthWriteLock> {
    return process.platform === 'win32'
        ? acquireWindowsAgyAuthWriteLock()
        : acquireFileAgyAuthWriteLock();
}

async function releaseAgyAuthWriteLock(lock: AgyAuthWriteLock): Promise<void> {
    if (lock.kind === 'pipe') {
        await new Promise<void>(resolve => {
            lock.server.close(error => {
                if (error) console.error('[Antigravity] Failed to release agy auth pipe lock');
                resolve();
            });
        });
        return;
    }

    try {
        fs.closeSync(lock.fd);
    } catch {
        console.error('[Antigravity] Failed to close agy auth lock');
    }
    try {
        if (fs.readFileSync(lock.path, 'utf-8') === lock.token) {
            fs.unlinkSync(lock.path);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[Antigravity] Failed to release agy auth lock');
        }
    }
}

async function withAgyAuthWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const lock = await acquireAgyAuthWriteLock();
    try {
        return await action();
    } finally {
        await releaseAgyAuthWriteLock(lock);
    }
}

async function runWindowsKeyringScript(
    mode: 'Write' | 'Fingerprint',
    payload?: string
): Promise<string> {
    const scriptPath = getWindowsKeyringScriptPath();
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`缺少 agy Keyring 更新脚本: ${scriptPath}`);
    }

    return new Promise<string>((resolve, reject) => {
        const child = spawn('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-Mode', mode,
        ], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const finish = (error?: Error, output = '') => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(output);
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 10000);

        child.stdout.on('data', (chunk: Buffer) => {
            if (stdout.length < 4096) stdout += chunk.toString('utf-8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < 4096) stderr += chunk.toString('utf-8');
        });
        child.stdin.on('error', () => {
            // 子进程提前退出时可能产生 EPIPE；最终以退出码和 stderr 为准。
        });
        child.on('error', (error) => finish(error));
        child.on('close', (code) => {
            if (timedOut) {
                finish(new Error(`${mode === 'Write' ? '更新' : '读取'} Windows Keyring 超时`));
                return;
            }
            if (code === 0) {
                finish(undefined, stdout.trim());
                return;
            }
            const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
            finish(new Error(
                `Windows Keyring ${mode === 'Write' ? '更新' : '读取'}失败 (code=${code})${detail ? `: ${detail}` : ''}`
            ));
        });

        child.stdin.end(payload || '', 'utf-8');
    });
}

async function probeWindowsKeyringFingerprint(): Promise<WindowsKeyringFingerprintProbe> {
    const output = await runWindowsKeyringScript('Fingerprint');
    if (output === 'NOT_FOUND') {
        return { status: 'not_found' };
    }

    const match = /^FOUND:([a-f0-9]{64})(?::([a-f0-9]{64}))?$/.exec(output);
    if (!match) {
        throw new Error('Windows Keyring 指纹脚本返回了无效结果');
    }
    return {
        status: 'found',
        fingerprint: match[1],
        payloadFingerprint: match[2],
    };
}

/**
 * 获取 agy 实际优先使用的 refresh token 指纹。
 * Windows 上只有 Keyring 明确不存在时才读取文件；探测错误必须向上传递。
 */
export async function getCurrentAgyCliRefreshTokenFingerprint(
    runtime: AgyCliFingerprintRuntime = {}
): Promise<AgyCliAuthFingerprint | null> {
    const platform = runtime.platform || process.platform;
    if (platform === 'win32') {
        const probe = await (runtime.probeWindowsKeyring || probeWindowsKeyringFingerprint)();
        if (probe.status === 'found') {
            return {
                fingerprint: probe.fingerprint,
                ...(probe.payloadFingerprint
                    ? { payloadFingerprint: probe.payloadFingerprint }
                    : {}),
                source: 'windows-keyring',
            };
        }
    }

    const tokens = (runtime.readTokenFile || readTokensFromAgyCli)();
    if (!tokens?.refreshToken) {
        return null;
    }
    return {
        fingerprint: fingerprintRefreshToken(tokens.refreshToken),
        source: 'token-file',
    };
}

/**
 * Windows 版 agy 优先读取 Credential Manager。
 * 通过 stdin 传入凭据，避免 Token 出现在命令行和进程列表中。
 */
async function writeAgyWindowsKeyring(payload: string): Promise<void> {
    if (process.platform !== 'win32') {
        return;
    }
    await runWindowsKeyringScript('Write', payload);
    console.log('[Antigravity] Updated Windows keyring credential');
}

function captureAgyCliTokenFile(): Buffer | null {
    const tokenPath = getAgyCliTokenPath();
    try {
        return fs.readFileSync(tokenPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function fingerprintTokenFileSnapshot(snapshot: Buffer | null): string | null {
    if (!snapshot) return null;
    try {
        const payload = JSON.parse(snapshot.toString('utf-8'));
        const refreshToken = payload?.token?.refresh_token;
        return typeof refreshToken === 'string' && refreshToken.length > 0
            ? fingerprintRefreshToken(refreshToken)
            : null;
    } catch {
        return null;
    }
}

function readAgyCliTokenFileFingerprint(): string | null {
    const tokens = readTokensFromAgyCli();
    return tokens?.refreshToken ? fingerprintRefreshToken(tokens.refreshToken) : null;
}

function restoreAgyCliTokenFile(snapshot: Buffer | null): void {
    const tokenPath = getAgyCliTokenPath();
    if (snapshot === null) {
        try {
            fs.unlinkSync(tokenPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return;
    }

    const tokenDir = path.dirname(tokenPath);
    const tempPath = `${tokenPath}.tmp-${process.pid}-${Date.now()}-rollback`;
    fs.mkdirSync(tokenDir, { recursive: true });
    try {
        fs.writeFileSync(tempPath, snapshot, { mode: 0o600 });
        fs.renameSync(tempPath, tokenPath);
        try {
            fs.chmodSync(tokenPath, 0o600);
        } catch { }
    } catch (error) {
        try {
            fs.unlinkSync(tempPath);
        } catch { }
        throw error;
    }
}

/** 同时更新 agy 的文件回退配置和 Windows Keyring，并核验实际生效凭据。 */
export async function writeAgyCliAuth(
    accessToken: string,
    refreshToken: string,
    expiry: number,
    runtime: AgyCliAuthWriteRuntime = {}
): Promise<void> {
    const payload = createAgyCliTokenPayload(accessToken, refreshToken, expiry);
    const platform = runtime.platform || process.platform;
    const withAuthWriteLock = runtime.withAuthWriteLock || withAgyAuthWriteLock;
    const writeTokenFile = runtime.writeTokenFile || writeAgyCliToken;
    const readTokenFileFingerprint = runtime.readTokenFileFingerprint || readAgyCliTokenFileFingerprint;
    const writeWindowsKeyring = runtime.writeWindowsKeyring || writeAgyWindowsKeyring;
    const captureTokenFile = runtime.captureTokenFile || captureAgyCliTokenFile;
    const restoreTokenFile = runtime.restoreTokenFile || restoreAgyCliTokenFile;
    const readCurrentFingerprint = runtime.readCurrentFingerprint
        ? runtime.readCurrentFingerprint
        : () => getCurrentAgyCliRefreshTokenFingerprint({ platform });

    await withAuthWriteLock(async () => {
        if (runtime.beforeWrite) await runtime.beforeWrite();
        // On Windows this distinguishes a failed/no-op write from an unrelated
        // process changing Keyring while this transaction is in progress.
        let previousCurrent: AgyCliAuthFingerprint | null = null;
        if (platform === 'win32') {
            try {
                previousCurrent = await readCurrentFingerprint();
            } catch {
                // The existing Keyring entry may be missing or malformed. This probe is
                // diagnostic only; the post-write authoritative readback decides success.
            }
        }
        const tokenFileSnapshot = captureTokenFile();
        const tokenFileSnapshotFingerprint = fingerprintTokenFileSnapshot(tokenFileSnapshot);
        let tokenFileWritten = false;

        try {
            // 文件先落盘，Windows Keyring 作为 agy 的最终权威提交点。
            writeTokenFile(accessToken, refreshToken, expiry);
            tokenFileWritten = true;
            const expectedFingerprint = fingerprintRefreshToken(refreshToken);
            const expectedPayloadFingerprint = fingerprintCredentialPayload(payload);
            const expectedSource = platform === 'win32' ? 'windows-keyring' : 'token-file';
            const isExpectedWrittenCredential = (value: AgyCliAuthFingerprint | null) =>
                !!value
                && value.source === expectedSource
                && value.fingerprint === expectedFingerprint
                && (platform !== 'win32' || value.payloadFingerprint === expectedPayloadFingerprint);

            if (platform !== 'win32') {
                const current = await readCurrentFingerprint();
                if (!current || current.source !== expectedSource || current.fingerprint !== expectedFingerprint) {
                    throw new Error('agy 凭据写入后的回读核验失败，账号未确认切换');
                }
                return;
            }

            let current: AgyCliAuthFingerprint | null = null;
            let keyringWriteError: unknown;
            let keyringProbeError: unknown;

            // A timeout or child-process error does not prove CredWrite failed. Retry the
            // idempotent forward commit and let authoritative readback decide the result.
            for (let attempt = 0; attempt < 2; attempt++) {
                keyringWriteError = undefined;
                try {
                    await writeWindowsKeyring(payload);
                } catch (error) {
                    keyringWriteError = error;
                }

                try {
                    current = await readCurrentFingerprint();
                    keyringProbeError = undefined;
                } catch (error) {
                    keyringProbeError = error;
                    if (attempt === 0) continue;
                    break;
                }

                if (isExpectedWrittenCredential(current)) {
                    break;
                }
            }

            if (!isExpectedWrittenCredential(current)) {
                // Restore the snapshot only when it is known to match the surviving
                // authority. Otherwise remove the fallback file instead of leaving a
                // second, conflicting account that could become active later.
                const snapshotMatchesCurrentKeyring = !keyringProbeError
                    && current?.source === 'windows-keyring'
                    && tokenFileSnapshotFingerprint === current.fingerprint;
                const keyringIsConfirmedAbsent = !keyringProbeError
                    && current?.source !== 'windows-keyring';
                try {
                    restoreTokenFile(snapshotMatchesCurrentKeyring || keyringIsConfirmedAbsent
                        ? tokenFileSnapshot
                        : null);
                    tokenFileWritten = false;
                } catch {
                    throw new Error('agy 凭据切换失败，且无法清理冲突的令牌文件；请退出 agy 后重新执行切换');
                }
                if (keyringProbeError) {
                    throw new Error('Windows Keyring 写入结果未知且无法回读确认；冲突的回退文件已清理，请重试');
                }
                const keyringChangedExternally = current?.source === 'windows-keyring'
                    && previousCurrent?.source === 'windows-keyring'
                    && current.fingerprint !== previousCurrent.fingerprint;
                if (keyringChangedExternally) {
                    throw new Error('切换期间 Windows Keyring 被其他进程持续改为另一账号；冲突的回退文件已清理，请重试');
                }
                if (keyringWriteError) throw keyringWriteError;
                throw new Error('agy 凭据写入后的回读核验失败，账号未确认切换');
            }

            // Keyring is authoritative, but the fallback file must also describe the
            // same account before success is reported. Repair it once if needed.
            const repairAndVerifyTokenFile = () => {
                let fileFingerprint = readTokenFileFingerprint();
                if (fileFingerprint !== expectedFingerprint) {
                    writeTokenFile(accessToken, refreshToken, expiry);
                    fileFingerprint = readTokenFileFingerprint();
                }
                if (fileFingerprint !== expectedFingerprint) {
                    restoreTokenFile(null);
                    tokenFileWritten = false;
                    throw new Error('agy 令牌文件写入后的回读核验失败；冲突的回退文件已清理');
                }
            };
            repairAndVerifyTokenFile();

            // Close the small window in which a non-cooperating process could replace
            // Keyring while the fallback file was being verified.
            let finalCurrent: AgyCliAuthFingerprint | null;
            try {
                finalCurrent = await readCurrentFingerprint();
            } catch {
                restoreTokenFile(null);
                tokenFileWritten = false;
                throw new Error('Windows Keyring 最终状态无法确认；冲突的回退文件已清理，请重试');
            }
            const isExpectedCurrent = isExpectedWrittenCredential;
            for (let attempt = 0; !isExpectedCurrent(finalCurrent) && attempt < 2; attempt++) {
                try {
                    await writeWindowsKeyring(payload);
                    finalCurrent = await readCurrentFingerprint();
                } catch {
                    restoreTokenFile(null);
                    tokenFileWritten = false;
                    throw new Error('Windows Keyring 最终协调失败；冲突的回退文件已清理，请重试');
                }
                if (isExpectedCurrent(finalCurrent)) {
                    // A legacy/non-cooperating process may have changed both stores.
                    // Reconcile the file again, then re-read Keyring before success.
                    repairAndVerifyTokenFile();
                    try {
                        finalCurrent = await readCurrentFingerprint();
                    } catch {
                        restoreTokenFile(null);
                        tokenFileWritten = false;
                        throw new Error('Windows Keyring 最终状态无法确认；冲突的回退文件已清理，请重试');
                    }
                }
            }
            if (!isExpectedCurrent(finalCurrent)) {
                restoreTokenFile(null);
                tokenFileWritten = false;
                throw new Error('Windows Keyring 被其他进程持续覆盖；冲突的回退文件已清理，请重试');
            }
        } catch (error) {
            if (tokenFileWritten) {
                try {
                    restoreTokenFile(platform === 'win32' ? null : tokenFileSnapshot);
                    tokenFileWritten = false;
                } catch {
                    throw new Error('agy 凭据切换失败，且令牌文件清理失败；请退出 agy 后重新执行切换');
                }
            }
            throw error;
        } finally {
            tokenFileSnapshot?.fill(0);
        }
    });
}

/** 从 agy CLI 的官方令牌文件读取当前凭据。 */
function readTokensFromAgyCli(): { refreshToken: string; accessToken: string } | null {
    const tokenPath = getAgyCliTokenPath();
    if (!fs.existsSync(tokenPath)) {
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        const token = data?.token;
        if (typeof token?.refresh_token !== 'string' || typeof token?.access_token !== 'string') {
            return null;
        }
        if (!token.refresh_token || !token.access_token) {
            return null;
        }
        return {
            refreshToken: token.refresh_token,
            accessToken: token.access_token,
        };
    } catch {
        return null;
    }
}

/** 读取 agy CLI 当前账号凭据，仅用于本机账号匹配，不向 UI/CLI 输出 Token。 */
export function getCurrentAgyCliTokens(): { refreshToken: string; accessToken: string } | null {
    return readTokensFromAgyCli();
}

export function setDbFileWritable(writable: boolean): void {
    const dbPath = getDbPath();
    const mode = writable ? 0o644 : 0o444;

    try {
        if (fs.existsSync(dbPath)) {
            fs.chmodSync(dbPath, mode);
        }
        ['.vscdb-wal', '.vscdb-shm', '.vscdb.backup'].forEach(suffix => {
            const p = dbPath.replace('.vscdb', suffix);
            if (fs.existsSync(p)) {
                fs.chmodSync(p, mode);
            }
        });
    } catch (error) {
        console.error('[Antigravity] Failed to set permissions:', error);
    }
}

/** 清理 SQLite 锁定文件 */
export function cleanUpLockFiles(): void {
    const dbPath = getDbPath();
    ['.vscdb-wal', '.vscdb-shm'].forEach(suffix => {
        const p = dbPath.replace('.vscdb', suffix);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                console.log(`[Antigravity] Deleted lock file: ${p}`);
            } catch (e) {
                console.error(`[Antigravity] Failed to delete lock file: ${p}`, e);
            }
        }
    });
}

// ============ 切号标志管理 ============

const SWITCH_FLAG_FILE = path.join(os.homedir(), '.anti-quota', 'switch_pending.json');

interface SwitchPendingData {
    timestamp: number;
    fromEmail?: string;
    toEmail?: string;
    activeSessionId?: string; // 切号时正在进行的对话 ID
}

/** 标记切号操作（切号前调用） */
export function markSwitchPending(fromEmail?: string, toEmail?: string, activeSessionId?: string): void {
    try {
        const backupDir = path.dirname(SWITCH_FLAG_FILE);
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const data: SwitchPendingData = {
            timestamp: Date.now(),
            fromEmail,
            toEmail,
            activeSessionId
        };
        fs.writeFileSync(SWITCH_FLAG_FILE, JSON.stringify(data, null, 2), 'utf-8');
        console.log('[Antigravity] Switch pending marked, activeSessionId:', activeSessionId || 'none');
    } catch (e) {
        console.error('[Antigravity] Failed to mark switch pending:', e);
    }
}

/** 检查是否有待处理的切号操作（启动时调用） */
export function checkSwitchPending(): SwitchPendingData | null {
    if (!fs.existsSync(SWITCH_FLAG_FILE)) {
        return null;
    }
    try {
        const content = fs.readFileSync(SWITCH_FLAG_FILE, 'utf-8');
        const data: SwitchPendingData = JSON.parse(content);
        // 只有 5 分钟内的标志才有效（防止过期标志影响，给 IDE 重启留出时间）
        if (Date.now() - data.timestamp < 300000) {
            return data;
        }
        // 过期了，清除
        clearSwitchPending();
        return null;
    } catch (e) {
        return null;
    }
}

/** 清除切号标志 */
export function clearSwitchPending(): void {
    if (fs.existsSync(SWITCH_FLAG_FILE)) {
        try {
            fs.unlinkSync(SWITCH_FLAG_FILE);
            console.log('[Antigravity] Switch pending cleared');
        } catch (e) {
            console.error('[Antigravity] Failed to clear switch pending:', e);
        }
    }
}

// ============ 应用控制 ============

/** 获取所有可能的编辑器数据库路径 */
export function getAllEditorDbPaths(): { name: string; path: string; keyName: string }[] {
    const platform = os.platform();
    const homeDir = os.homedir();

    const editors = [
        { name: 'Antigravity', folder: 'Antigravity', keyName: 'jetskiStateSync.agentManagerInitState' },
        { name: 'Cursor', folder: 'Cursor', keyName: 'jetskiStateSync.agentManagerInitState' },
        { name: 'Windsurf', folder: 'Windsurf', keyName: 'jetskiStateSync.agentManagerInitState' },
        { name: 'Kiro', folder: 'Kiro', keyName: 'jetskiStateSync.agentManagerInitState' },
    ];

    return editors.map(editor => {
        let dbPath: string;
        if (platform === 'darwin') {
            dbPath = path.join(homeDir, `Library/Application Support/${editor.folder}/User/globalStorage/state.vscdb`);
        } else if (platform === 'win32') {
            const appData = process.env.APPDATA || path.join(homeDir, 'AppData/Roaming');
            dbPath = path.join(appData, `${editor.folder}/User/globalStorage/state.vscdb`);
        } else {
            dbPath = path.join(homeDir, `.config/${editor.folder}/User/globalStorage/state.vscdb`);
        }
        return { name: editor.name, path: dbPath, keyName: editor.keyName };
    });
}

/** 从编辑器数据库读取当前登录的账号信息 */
export async function getCurrentAccountFromEditor(): Promise<{ refreshToken: string; accessToken: string; source: string } | null> {
    const editors = getAllEditorDbPaths();

    for (const editor of editors) {
        if (!fs.existsSync(editor.path)) {
            continue;
        }

        try {
            const result = await readTokensFromDb(editor.path, editor.keyName);
            if (result?.refreshToken && result?.accessToken) {
                return {
                    refreshToken: result.refreshToken,
                    accessToken: result.accessToken,
                    source: editor.name
                };
            }
        } catch (error) {
            console.error(`[Antigravity] Failed to read from ${editor.name}:`, error);
        }
    }

    // 新版 Antigravity CLI 不再使用 state.vscdb，而是使用独立 OAuth 配置。
    const cliToken = readTokensFromAgyCli();
    if (cliToken) {
        return {
            refreshToken: cliToken.refreshToken,
            accessToken: cliToken.accessToken,
            source: 'Antigravity CLI'
        };
    }

    return null;
}

/** 从指定数据库读取 tokens（使用 sqlite3 CLI） */
async function readTokensFromDb(dbPath: string, keyName: string): Promise<{ refreshToken: string; accessToken: string } | null> {
    try {
        const { execSync } = require('child_process');
        const stdout = execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${keyName}'"`,
            { encoding: 'utf-8', timeout: 5000 }
        );

        if (!stdout.trim()) {
            return null;
        }

        const blob = Buffer.from(stdout.trim(), 'base64');
        const oauthInfo = findFieldInBlob(blob, 6);
        if (!oauthInfo) {
            return null;
        }

        const accessTokenData = findFieldInBlob(oauthInfo, 1);
        const accessToken = accessTokenData ? accessTokenData.toString('utf-8') : '';

        const refreshTokenData = findFieldInBlob(oauthInfo, 3);
        const refreshToken = refreshTokenData ? refreshTokenData.toString('utf-8') : '';

        if (refreshToken && refreshToken.startsWith('1//') && accessToken) {
            return { refreshToken, accessToken };
        }

        return null;
    } catch (error) {
        return null;
    }
}

function findFieldInBlob(data: Buffer, targetField: number): Buffer | null {
    let offset = 0;
    while (offset < data.length) {
        try {
            const tag = readVarint(data, offset);
            const wireType = tag.value & 7;
            const fieldNum = tag.value >> 3;
            if (fieldNum === targetField && wireType === 2) {
                const len = readVarint(data, tag.newOffset);
                return data.subarray(len.newOffset, len.newOffset + len.value);
            }
            offset = skipField(data, tag.newOffset, wireType);
        } catch { break; }
    }
    return null;
}


/** 深度杀死所有 Antigravity 相关的进程 */
export function nuclearKill(): void {
    const platform = os.platform();
    console.log('[Antigravity] Executing Nuclear Kill...');

    try {
        if (platform === 'darwin') {
            // 杀掉主应用、所有 Helper 进程、以及可能存在的 Electron 独立进程
            execSync('pkill -9 -i "Antigravity"', { stdio: 'ignore' });
            execSync('pkill -9 -f "Antigravity Helper"', { stdio: 'ignore' });
            execSync('pkill -9 -f "jetskiAgent"', { stdio: 'ignore' });
        } else if (platform === 'win32') {
            execSync('taskkill /F /IM Antigravity.exe /T', { stdio: 'ignore' });
        }
    } catch (e) {
        // 忽略进程不存在的错误
    }
}

// ============ Protobuf 工具 ============

function encodeVarint(value: number): number[] {
    const bytes: number[] = [];
    let v = value >>> 0;
    while (v >= 0x80) {
        bytes.push((v & 0x7F) | 0x80);
        v = v >>> 7;
    }
    bytes.push(v);
    return bytes;
}

function createOAuthField(accessToken: string, refreshToken: string, expiry: number): Buffer {
    const parts: number[] = [];
    const addString = (field: number, str: string) => {
        parts.push(...encodeVarint((field << 3) | 2));
        const buf = Buffer.from(str, 'utf-8');
        parts.push(...encodeVarint(buf.length));
        for (const b of buf) parts.push(b);
    };

    addString(1, accessToken);
    addString(2, 'Bearer');
    addString(3, refreshToken);

    // Field 4: expiry
    const timestampParts: number[] = [];
    timestampParts.push(...encodeVarint((1 << 3) | 0));
    timestampParts.push(...encodeVarint(expiry));
    parts.push(...encodeVarint((4 << 3) | 2));
    parts.push(...encodeVarint(timestampParts.length));
    parts.push(...timestampParts);

    const tag6 = (6 << 3) | 2;
    const field6: number[] = [];
    field6.push(...encodeVarint(tag6));
    field6.push(...encodeVarint(parts.length));
    field6.push(...parts);

    return Buffer.from(field6);
}

// ============ 终极注入 ============

export async function injectToken(accessToken: string, refreshToken: string, expiry: number, email?: string): Promise<void> {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) throw new Error('数据库不存在');

    console.log('[Antigravity] Starting Nuclear Injection (CLI mode)...');
    setDbFileWritable(true);

    try {
        // 1. 读取并更新 jetskiStateSync
        const jetskiKey = 'jetskiStateSync.agentManagerInitState';
        const currentValue = execSync(
            `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${jetskiKey}'"`,
            { encoding: 'utf-8', timeout: 10000 }
        ).trim();

        if (currentValue) {
            const blob = Buffer.from(currentValue, 'base64');
            const cleanData = removeField(blob, 6);
            const newField = createOAuthField(accessToken, refreshToken, expiry);
            const finalData = Buffer.concat([cleanData, newField]);
            const newValue = finalData.toString('base64').replace(/'/g, "''");
            execSync(
                `sqlite3 "${dbPath}" "UPDATE ItemTable SET value = '${newValue}' WHERE key = '${jetskiKey}'"`,
                { encoding: 'utf-8', timeout: 10000 }
            );
            console.log('[Antigravity] Updated jetskiStateSync');
        }

        // 2. 更新 antigravityAuthStatus
        if (email) {
            const authKey = 'antigravityAuthStatus';
            const newAuth = JSON.stringify({
                email: email,
                apiKey: accessToken,
                name: email.split('@')[0],
            }).replace(/'/g, "''");
            execSync(
                `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${authKey}', '${newAuth}')"`,
                { encoding: 'utf-8', timeout: 10000 }
            );
            console.log('[Antigravity] Written fresh antigravityAuthStatus');
        }

        // 3. 删除缓存键
        const keysToDelete = [
            'google.geminicodeassist',
            'google.geminicodeassist.hasRunOnce',
            'geminiCodeAssist.chatThreads'
        ];
        for (const k of keysToDelete) {
            try {
                execSync(
                    `sqlite3 "${dbPath}" "DELETE FROM ItemTable WHERE key = '${k}' OR key LIKE '${k}.%'"`,
                    { encoding: 'utf-8', timeout: 10000 }
                );
            } catch (e) { }
        }

        // 4. 重置 Onboarding
        execSync(
            `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true')"`,
            { encoding: 'utf-8', timeout: 10000 }
        );

        console.log('[Antigravity] Final DB written successfully');
    } catch (error) {
        console.error('[Antigravity] Injection failed:', error);
        throw error;
    }
}

// 辅助：从 Buffer 中移除 Proto 字段 (复用之前的实现)
function removeField(data: Buffer, fieldNum: number): Buffer {
    const result: number[] = [];
    let offset = 0;
    while (offset < data.length) {
        const startOffset = offset;
        const tag = readVarint(data, offset);
        const wireType = tag.value & 7;
        const currentField = tag.value >> 3;
        const nextOffset = skipField(data, tag.newOffset, wireType);
        if (currentField !== fieldNum) {
            for (let i = startOffset; i < nextOffset; i++) result.push(data[i]);
        }
        offset = nextOffset;
    }
    return Buffer.from(result);
}

function readVarint(data: Buffer, offset: number) {
    let result = 0, shift = 0, pos = offset;
    while (pos < data.length) {
        const byte = data[pos++];
        result |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result >>> 0, newOffset: pos };
}

function skipField(data: Buffer, offset: number, wireType: number): number {
    if (wireType === 0) return readVarint(data, offset).newOffset;
    if (wireType === 1) return offset + 8;
    if (wireType === 2) {
        const len = readVarint(data, offset);
        return len.newOffset + len.value;
    }
    if (wireType === 5) return offset + 4;
    throw new Error('Unknown wire type');
}

// ============ 暴露给外部的切换接口 ============

export async function switchAccountSeamless(accessToken: string, refreshToken: string, expiry: number, email?: string): Promise<void> {
    console.log('[Antigravity] === 触发无感切换 (V13.0 - 精简版) ===');

    // 新版 agy CLI 没有桌面版 state.vscdb，直接更新其官方令牌文件。
    if (!fs.existsSync(getDbPath()) && isAgyCliAvailable()) {
        await writeAgyCliAuth(accessToken, refreshToken, expiry);
        console.log(`[Antigravity] agy CLI 已切换到 ${email || '目标账号'}，请重启 agy 会话`);
        return;
    }

    // 0. 标记切号操作
    markSwitchPending(undefined, email);

    // 1. 先杀进程（释放数据库锁）
    console.log('[Antigravity] Step 1: 关闭 Antigravity...');
    nuclearKill();
    await new Promise(r => setTimeout(r, 1000));

    // 2. 清理锁文件
    cleanUpLockFiles();
    await new Promise(r => setTimeout(r, 200));

    // 3. 注入新 Token
    console.log('[Antigravity] Step 2: 注入新 Token...');
    await injectToken(accessToken, refreshToken, expiry, email);

    console.log('[Antigravity] 注入完成，正在重启...');
    if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' }).unref();
    }
}

export async function switchAccountFull(accessToken: string, refreshToken: string, expiry: number, email?: string): Promise<void> {
    if (!fs.existsSync(getDbPath()) && isAgyCliAvailable()) {
        await writeAgyCliAuth(accessToken, refreshToken, expiry);
        console.log(`[Antigravity] agy CLI 已切换到 ${email || '目标账号'}，请重启 agy 会话`);
        return;
    }

    nuclearKill();
    await new Promise(r => setTimeout(r, 1000));
    cleanUpLockFiles();
    await injectToken(accessToken, refreshToken, expiry, email);
    console.log('[Antigravity] 完整切换完成，请手动或点击“重载”打开 IDE');
}
