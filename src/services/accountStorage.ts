/**
 * 多进程安全的账号存储。
 *
 * VS Code 的多个窗口和 CLI 服务会同时访问同一个 accounts.json。这里集中处理
 * 锁、原子替换和备份，避免读取到半写文件或用旧快照覆盖其他进程新增的账号。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Account } from '../types/account';

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const MAX_HISTORY_BACKUPS = 20;

function getDataDirectory(): string {
    return process.env.ANTI_QUOTA_DATA_DIR || path.join(os.homedir(), '.anti-quota');
}

export function getStoragePath(): string {
    return path.join(getDataDirectory(), 'accounts.json');
}

function getLatestBackupPath(): string {
    return path.join(getDataDirectory(), 'accounts.latest.json');
}

function ensureDataDirectory(): void {
    fs.mkdirSync(getDataDirectory(), { recursive: true });
}

function parseAccounts(contents: string, source: string): Account[] {
    const parsed: unknown = JSON.parse(contents);
    if (!Array.isArray(parsed)) {
        throw new Error(`${source} 的内容不是账号数组`);
    }
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            throw new Error(`${source} 包含无效账号记录`);
        }
        const account = item as Partial<Account>;
        if (typeof account.id !== 'string' || typeof account.email !== 'string' || !account.token) {
            throw new Error(`${source} 包含不完整账号记录`);
        }
    }
    return parsed as Account[];
}

function readFileStrict(filePath: string): Account[] {
    return parseAccounts(fs.readFileSync(filePath, 'utf8'), filePath);
}

function cloneAccounts(accounts: Account[]): Account[] {
    return JSON.parse(JSON.stringify(accounts)) as Account[];
}

/** 是否存在账号存储或可恢复备份。只有两者都不存在才算真正首次启动。 */
export function hasAccountStorage(): boolean {
    return fs.existsSync(getStoragePath()) || fs.existsSync(getLatestBackupPath());
}

/**
 * 严格读取账号。主文件损坏时读取最新备份；两者都损坏时抛错，绝不伪装成空列表。
 */
export function readAccounts(): Account[] {
    const storagePath = getStoragePath();
    const backupPath = getLatestBackupPath();

    if (!fs.existsSync(storagePath)) {
        if (fs.existsSync(backupPath)) return readFileStrict(backupPath);
        return [];
    }

    try {
        return readFileStrict(storagePath);
    } catch (primaryError) {
        if (fs.existsSync(backupPath)) {
            try {
                const recovered = readFileStrict(backupPath);
                console.error(`[AccountStorage] 主文件损坏，已从备份读取: ${String(primaryError)}`);
                return recovered;
            } catch (backupError) {
                throw new Error(`账号存储和备份均损坏。主文件: ${String(primaryError)}；备份: ${String(backupError)}`);
            }
        }
        throw new Error(`账号存储损坏且没有可用备份: ${String(primaryError)}`);
    }
}

function pause(milliseconds: number): void {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, milliseconds);
}

function acquireLock(): { fd: number; token: string; lockPath: string } {
    ensureDataDirectory();
    const lockPath = path.join(getDataDirectory(), '.accounts.lock');
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, token, 'utf8');
            fs.fsyncSync(fd);
            return { fd, token, lockPath };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;

            try {
                const age = Date.now() - fs.statSync(lockPath).mtimeMs;
                if (age > STALE_LOCK_MS) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch (statError: any) {
                if (statError?.code === 'ENOENT') continue;
            }

            if (Date.now() >= deadline) {
                throw new Error('等待账号存储锁超时，请关闭残留的 Anti Quota 进程后重试');
            }
            pause(LOCK_RETRY_MS);
        }
    }
}

function releaseLock(lock: { fd: number; token: string; lockPath: string }): void {
    try {
        fs.closeSync(lock.fd);
    } finally {
        try {
            if (fs.readFileSync(lock.lockPath, 'utf8') === lock.token) {
                fs.unlinkSync(lock.lockPath);
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT') console.error('[AccountStorage] 释放账号锁失败:', error);
        }
    }
}

function writeAtomic(filePath: string, accounts: Account[]): void {
    ensureDataDirectory();
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = fs.openSync(temporaryPath, 'wx');
    try {
        fs.writeFileSync(fd, JSON.stringify(accounts, null, 2), 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    try {
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        try { fs.unlinkSync(temporaryPath); } catch { /* ignore cleanup failure */ }
        throw error;
    }
}

function membershipKey(accounts: Account[]): string {
    return accounts.map(account => `${account.id}\0${account.email.toLowerCase()}`).sort().join('\n');
}

function createHistoryBackup(accounts: Account[]): void {
    const backupDirectory = path.join(getDataDirectory(), 'backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupPath = path.join(backupDirectory, `accounts-${stamp}-${process.pid}.json`);
    writeAtomic(backupPath, accounts);

    const history = fs.readdirSync(backupDirectory)
        .filter(name => /^accounts-.*\.json$/.test(name))
        .sort()
        .reverse();
    for (const oldName of history.slice(MAX_HISTORY_BACKUPS)) {
        fs.unlinkSync(path.join(backupDirectory, oldName));
    }
}

/** 在专用跨进程锁中重新读取最新数据并修改。 */
export function mutateAccounts(mutator: (accounts: Account[]) => Account[]): Account[] {
    const lock = acquireLock();
    try {
        const current = readAccounts();
        const next = mutator(cloneAccounts(current));
        // 在落盘前验证序列化结果，防止把非法数据写入主文件。
        parseAccounts(JSON.stringify(next), '待写入账号数据');

        writeAtomic(getStoragePath(), next);
        writeAtomic(getLatestBackupPath(), next);
        if (membershipKey(current) !== membershipKey(next)) {
            createHistoryBackup(next);
        }
        return cloneAccounts(next);
    } finally {
        releaseLock(lock);
    }
}

function mergeAccount(existing: Account, incoming: Account): Account {
    const merged: Account = { ...existing, ...incoming };
    merged.created_at = Math.min(existing.created_at || incoming.created_at, incoming.created_at || existing.created_at);
    merged.last_used = Math.max(existing.last_used || 0, incoming.last_used || 0);

    // Token 和配额都带有可比较时间，旧窗口不能倒灌旧数据。
    merged.token = (incoming.token.expiry_timestamp || 0) >= (existing.token.expiry_timestamp || 0)
        ? incoming.token
        : existing.token;
    if (existing.quota && incoming.quota) {
        merged.quota = incoming.quota.last_updated >= existing.quota.last_updated ? incoming.quota : existing.quota;
    } else {
        merged.quota = incoming.quota || existing.quota;
    }
    return merged;
}

/**
 * 合并一个可能过期的进程快照。此操作只会新增/更新，不会隐式删除磁盘上的账号。
 */
export function mergeAccounts(snapshot: Account[]): Account[] {
    return mutateAccounts(current => {
        for (const incoming of snapshot) {
            const incomingEmail = incoming.email.toLowerCase();
            const index = current.findIndex(existing =>
                existing.id === incoming.id
                || existing.email.toLowerCase() === incomingEmail
                || (!!incoming.token.refresh_token && existing.token.refresh_token === incoming.token.refresh_token)
            );
            if (index >= 0) current[index] = mergeAccount(current[index], incoming);
            else current.push(incoming);
        }
        return current;
    });
}
