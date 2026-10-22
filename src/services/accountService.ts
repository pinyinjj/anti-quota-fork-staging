/**
 * 账号管理服务
 * 处理账号的增删改查、配额获取等
 */

import { Account, QuotaData, ModelQuota } from '../types/account';
import * as oauthService from './oauthService';
import * as antigravityService from './antigravityService';
import * as accountStorage from './accountStorage';
import * as oauthCallbackServer from './oauthCallbackServer';
import {
    findMissingQuotaData,
    mergeQuotaSummaries,
    parseQuotaSummary,
    ParsedQuotaSummary,
} from './quotaSummaryService';
import { requestHttps } from './networkService';

// Google Cloud Code API
const CLOUD_CODE_API_BASE = 'cloudcode-pa.googleapis.com';
const FETCH_MODELS_PATH = '/v1internal:fetchAvailableModels';
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
const RETRIEVE_QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';
const QUOTA_SUMMARY_HOSTS = [
    'daily-cloudcode-pa.sandbox.googleapis.com',
    'daily-cloudcode-pa.googleapis.com',
    CLOUD_CODE_API_BASE,
];

// 账号缓存和最后读取时间（用于多窗口同步）
let cachedAccounts: Account[] | null = null;
let lastReadTime = 0;
const CACHE_TTL = 2000; // 2秒缓存

// ============ 存储管理 ============

/** 读取账号列表（带缓存，多窗口友好） */
export function listAccounts(): Account[] {
    const now = Date.now();

    // 如果缓存有效，直接返回
    if (cachedAccounts && now - lastReadTime < CACHE_TTL) {
        return cachedAccounts;
    }

    cachedAccounts = accountStorage.readAccounts();
    lastReadTime = now;
    return cachedAccounts;
}

/** 只有主文件和恢复备份都不存在时，才视为真正的首次启动。 */
export function hasAccountStorage(): boolean {
    return accountStorage.hasAccountStorage();
}

/** 强制刷新账号缓存 */
export function invalidateCache(): void {
    cachedAccounts = null;
    lastReadTime = 0;
}

/** 合并保存账号快照；不会让旧窗口隐式删除其他进程新增的账号。 */
function saveAccounts(accounts: Account[]): void {
    cachedAccounts = accountStorage.mergeAccounts(accounts);
    lastReadTime = Date.now();
}

/** 生成唯一 ID */
function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ============ 账号操作 ============

/** 获取当前账号（匹配 IDE 数据库中的账号，自动同步） */
export async function getCurrentAccount(): Promise<Account | null> {
    let accounts = listAccounts();

    // 尝试从 IDE 获取当前登录的账号
    try {
        const dbAccount = await antigravityService.getCurrentAccountFromEditor();
        if (dbAccount?.refreshToken && dbAccount?.accessToken) {
            // 检查列表中是否存在（先按 refresh_token，再按 email）
            let matched = accounts.find(a => a.token.refresh_token === dbAccount.refreshToken);

            if (matched) {
                // 已存在，同步最新的 access_token
                const now = Math.floor(Date.now() / 1000);
                if (matched.token.access_token !== dbAccount.accessToken) {
                    matched.token.access_token = dbAccount.accessToken;
                    matched.token.expiry_timestamp = now + 3600;
                    matched.last_used = now;
                    // 清除 403 状态，重新获取配额
                    if (matched.quota?.is_forbidden) {
                        matched.quota = undefined;
                    }
                    saveAccounts(accounts);
                    console.log('[Account] Synced token from IDE for:', matched.email);
                }
                return matched;
            } else {
                // 尝试获取用户信息，看是否按 email 已存在
                console.log('[Account] Checking if account exists by email...');
                try {
                    const userInfo = await oauthService.getUserInfo(dbAccount.accessToken);
                    const now = Math.floor(Date.now() / 1000);

                    // 按 email 查找是否已存在
                    const existingByEmail = accounts.find(a => a.email === userInfo.email);
                    if (existingByEmail) {
                        // 邮箱已存在，更新 token（用户可能重新授权了）
                        existingByEmail.token = {
                            access_token: dbAccount.accessToken,
                            refresh_token: dbAccount.refreshToken,
                            expires_in: 3600,
                            expiry_timestamp: now + 3600,
                            token_type: 'Bearer'
                        };
                        existingByEmail.last_used = now;
                        // 清除 403 状态
                        if (existingByEmail.quota?.is_forbidden) {
                            existingByEmail.quota = undefined;
                        }
                        saveAccounts(accounts);
                        console.log('[Account] Updated existing account with new token:', userInfo.email);
                        return existingByEmail;
                    }

                    // 完全不存在，自动添加到列表
                    console.log('[Account] Auto adding current IDE account...');
                    const newAccount: Account = {
                        id: generateId(),
                        email: userInfo.email,
                        name: userInfo.name,
                        token: {
                            access_token: dbAccount.accessToken,
                            refresh_token: dbAccount.refreshToken,
                            expires_in: 3600,
                            expiry_timestamp: now + 3600,
                            token_type: 'Bearer'
                        },
                        created_at: now,
                        last_used: now,
                        priority: accounts.length
                    };
                    accounts.push(newAccount);
                    saveAccounts(accounts);
                    console.log('[Account] Auto added:', userInfo.email);

                    // 自动获取配额
                    try {
                        await fetchAccountQuota(newAccount.id);
                    } catch (e) {
                        console.log('[Account] Auto fetch quota failed:', e);
                    }

                    return newAccount;
                } catch (e) {
                    console.log('[Account] Failed to auto add:', e);
                }
            }
        }
    } catch (error) {
        console.log('[Account] Failed to get current account from IDE:', error);
    }

    // 回退：返回最近使用的账号
    if (accounts.length === 0) return null;
    return accounts.reduce((prev, curr) =>
        prev.last_used > curr.last_used ? prev : curr
    );
}

/** 通过 refresh_token 添加账号 */
export async function addAccountByToken(refreshToken: string): Promise<Account> {
    const accounts = listAccounts();

    // 检查 refresh_token 是否已存在
    const existingByToken = accounts.find(a => a.token.refresh_token === refreshToken);
    if (existingByToken) {
        // 静默返回现有账号（批量导入时跳过重复）
        console.log('[Account] Token already exists, skipping:', existingByToken.email);
        return existingByToken;
    }

    // 刷新 Token 并获取用户信息
    let email = `account_${Date.now()}`;
    let name: string | undefined;
    let accessToken = '';
    let expiresIn = 3600;

    try {
        const tokenRes = await oauthService.refreshAccessToken(refreshToken);
        accessToken = tokenRes.access_token;
        expiresIn = tokenRes.expires_in;

        const userInfo = await oauthService.getUserInfo(accessToken);
        email = userInfo.email;
        name = userInfo.name;
    } catch (error) {
        console.error('Failed to get user info:', error);
    }

    const now = Math.floor(Date.now() / 1000);

    // 再次检查是否有同邮箱的账号（可能用不同的 refresh_token）
    const existingByEmail = accounts.find(a => a.email === email);
    if (existingByEmail) {
        // 更新现有账号的 token
        existingByEmail.token = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: expiresIn,
            expiry_timestamp: now + expiresIn,
            token_type: 'Bearer'
        };
        existingByEmail.last_used = now;
        // 清除 403 状态
        if (existingByEmail.quota?.is_forbidden) {
            existingByEmail.quota = undefined;
        }
        saveAccounts(accounts);
        console.log('[Account] Updated existing account with new token:', email);

        // 自动获取配额
        try {
            await fetchAccountQuota(existingByEmail.id);
        } catch (e) {
            console.log('[Account] Auto fetch quota failed:', e);
        }

        return existingByEmail;
    }

    const newAccount: Account = {
        id: generateId(),
        email,
        name,
        token: {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: expiresIn,
            expiry_timestamp: now + expiresIn,
            token_type: 'Bearer'
        },
        created_at: now,
        last_used: now,
        priority: accounts.length
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    // 自动获取配额
    try {
        await fetchAccountQuota(newAccount.id);
    } catch (e) {
        console.log('[Account] Auto fetch quota failed:', e);
    }

    return newAccount;
}

/** 批量添加账号（支持多种格式） */
export async function addAccountsBatch(input: string): Promise<{ success: number; failed: number; errors: string[] }> {
    const tokens: string[] = [];
    const errors: string[] = [];

    // 尝试解析 JSON 数组
    try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (typeof item === 'string') {
                    tokens.push(item);
                } else if (item.refresh_token) {
                    tokens.push(item.refresh_token);
                }
            }
        }
    } catch {
        // 非 JSON，按行分割
        const lines = input.split(/[\n,;]+/).map(s => s.trim()).filter(s => s);
        for (const line of lines) {
            if (line.startsWith('1//')) {
                tokens.push(line);
            }
        }
    }

    let success = 0;
    for (const token of tokens) {
        try {
            await addAccountByToken(token);
            success++;
        } catch (error: any) {
            errors.push(`${token.substring(0, 20)}...: ${error.message}`);
        }
    }

    return { success, failed: tokens.length - success, errors };
}

/** OAuth 授权添加账号 */
export async function addAccountViaOAuth(callbackUrl: string): Promise<Account> {
    const code = oauthService.extractCodeFromUrl(callbackUrl);
    if (!code) {
        throw new Error('无效的回调 URL');
    }

    const tokenResponse = await oauthService.exchangeCode(code);
    if (!tokenResponse.refresh_token) {
        throw new Error('未获取到 refresh_token，请在 https://myaccount.google.com/permissions 撤销应用权限后重试');
    }

    const userInfo = await oauthService.getUserInfo(tokenResponse.access_token);
    const accounts = listAccounts();

    // 检查是否已存在
    const existing = accounts.find(a => a.email === userInfo.email);
    if (existing) {
        // 更新现有账号的 Token
        existing.token = {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        };
        existing.last_used = Math.floor(Date.now() / 1000);
        saveAccounts(accounts);
        return existing;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAccount: Account = {
        id: generateId(),
        email: userInfo.email,
        name: userInfo.name,
        token: {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: now + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        },
        created_at: now,
        last_used: now,
        priority: accounts.length
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    // 自动获取配额
    try {
        await fetchAccountQuota(newAccount.id);
    } catch (e) {
        console.log('[Account] Auto fetch quota failed:', e);
    }

    return newAccount;
}

/**
 * 启动完整的 OAuth 授权流程
 * 1. 启动本地回调服务器
 * 2. 打开浏览器进行 Google 授权
 * 3. 自动接收回调并添加账号
 */
export async function startOAuthFlow(
    onCallbackServerReady?: () => void | Promise<void>,
    signal?: AbortSignal
): Promise<Account> {
    // 缺少客户端配置时立即报错，不占用端口或等待授权超时。
    oauthService.getOAuthClientConfig();
    let code: string;
    try {
        // 客户端退出、按 Esc/Ctrl+C 或等待超时时都会结束本地回调监听。
        code = await oauthCallbackServer.startCallbackServer(5 * 60 * 1000, onCallbackServerReady, signal);
    } finally {
        // 成功回调已自行清理；异常路径在这里兜底，避免端口和 Promise 残留。
        oauthCallbackServer.stopCallbackServer();
    }

    // 交换 Token
    const tokenResponse = await oauthService.exchangeCode(code);
    if (!tokenResponse.refresh_token) {
        throw new Error('未获取到 refresh_token，请在 https://myaccount.google.com/permissions 撤销应用权限后重试');
    }

    // 获取用户信息并添加账号
    const userInfo = await oauthService.getUserInfo(tokenResponse.access_token);
    const accounts = listAccounts();

    // 检查是否已存在
    const existing = accounts.find(a => a.email === userInfo.email);
    if (existing) {
        // 更新现有账号的 Token
        existing.token = {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        };
        existing.last_used = Math.floor(Date.now() / 1000);
        saveAccounts(accounts);
        return existing;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAccount: Account = {
        id: generateId(),
        email: userInfo.email,
        name: userInfo.name,
        token: {
            access_token: tokenResponse.access_token,
            refresh_token: tokenResponse.refresh_token,
            expires_in: tokenResponse.expires_in,
            expiry_timestamp: now + tokenResponse.expires_in,
            token_type: tokenResponse.token_type || 'Bearer'
        },
        created_at: now,
        last_used: now,
        priority: accounts.length
    };

    accounts.push(newAccount);
    saveAccounts(accounts);

    // 自动获取配额
    try {
        await fetchAccountQuota(newAccount.id);
    } catch (e) {
        console.log('[Account] Auto fetch quota failed:', e);
    }

    return newAccount;
}

/** 从 IDE 自动导入账号 */
export async function autoImportFromEditor(): Promise<Account | null> {
    const current = await antigravityService.getCurrentAccountFromEditor();
    if (!current?.refreshToken) {
        return null;
    }

    try {
        return await addAccountByToken(current.refreshToken);
    } catch (error: any) {
        if (error.message.includes('已存在')) {
            // 账号已存在，返回现有账号
            const accounts = listAccounts();
            return accounts.find(a => a.token.refresh_token === current.refreshToken) || null;
        }
        throw error;
    }
}

/** 删除账号 */
export function deleteAccount(accountId: string): void {
    cachedAccounts = accountStorage.mutateAccounts(accounts => accounts.filter(a => a.id !== accountId));
    lastReadTime = Date.now();
}

/** 批量删除账号 */
export function deleteAccounts(accountIds: string[]): void {
    cachedAccounts = accountStorage.mutateAccounts(accounts => accounts.filter(a => !accountIds.includes(a.id)));
    lastReadTime = Date.now();
}

/** 更新账号 */
export function updateAccount(accountId: string, updates: Partial<Account>): void {
    cachedAccounts = accountStorage.mutateAccounts(accounts => {
        const account = accounts.find(a => a.id === accountId);
        if (account) Object.assign(account, updates);
        return accounts;
    });
    lastReadTime = Date.now();
}

// ============ 账号切换 ============

/** 切换账号 */
export async function switchAccount(accountId: string, mode: 'seamless' | 'full' = 'seamless'): Promise<void> {
    const accounts = listAccounts();
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
        throw new Error('账号不存在');
    }

    // 切换
    if (mode === 'full') {
        // FULL 模式会把 Token 注入到客户端。切换前始终刷新，避免本地过期时间
        // 尚未到达、但 Google 已提前撤销 access_token 时写入无效凭据。
        const now = Math.floor(Date.now() / 1000);
        try {
            const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
            account.token.access_token = tokenRes.access_token;
            account.token.expires_in = tokenRes.expires_in;
            account.token.expiry_timestamp = now + tokenRes.expires_in;
            saveAccounts(accounts);
        } catch (error) {
            throw new Error(`目标账号登录凭据已失效，无法切换。请删除后重新添加该账号。详细信息: ${error}`);
        }

        // 完整切换模式：修改配置文件 + 手动重启
        console.log('[Account] Using FULL switch mode');
        await antigravityService.switchAccountFull(
            account.token.access_token,
            account.token.refresh_token,
            account.token.expiry_timestamp,
            account.email
        );
    } else {
        // 直接切换模式（参考 Antigravity-Manager）
        // 1. 关闭 Antigravity
        // 2. 注入 Token 到数据库
        // 3. 重启 Antigravity

        console.log('[Account] Using DIRECT switch mode (Close -> Inject -> Restart)');

        try {
            // 动态导入直接切换服务
            const { DirectSwitchService } = await import('./directSwitchService');
            console.log('[Account] ✓ DirectSwitchService loaded');

            const directService = new DirectSwitchService();
            console.log('[Account] Calling directService.switchAccount...');

            const result = await directService.switchAccount(account);
            console.log('[Account] Direct switch result:', JSON.stringify(result));

            if (result.success) {
                // 切换成功，更新 last_used 并返回
                console.log('[Account] ✓ Direct switch SUCCESS!');
                account.last_used = Math.floor(Date.now() / 1000);
                saveAccounts(accounts);
                return;
            }

            // 切换失败，抛出错误
            console.error('[Account] ❌ Direct switch FAILED:', result.error);
            throw new Error(`账号切换失败: ${result.error}`);

        } catch (error: any) {
            // 记录并抛出
            console.error('[Account] ❌ Direct switch error:', error);
            throw new Error(`账号切换异常: ${error.message}`);
        }
    }

    // 更新 last_used
    account.last_used = Math.floor(Date.now() / 1000);
    saveAccounts(accounts);
}

// ============ 配额获取 ============

async function httpsPost(hostname: string, path: string, headers: Record<string, string>, body: any): Promise<{ status: number; data: any }> {
    const postData = JSON.stringify(body);
    const response = await requestHttps(`https://${hostname}${path}`, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData, 20_000);
    try {
        return { status: response.status, data: JSON.parse(response.body) };
    } catch {
        return { status: response.status, data: null };
    }
}

/** 获取 Project ID */
async function fetchProjectId(accessToken: string): Promise<string | null> {
    try {
        const result = await httpsPost(CLOUD_CODE_API_BASE, LOAD_CODE_ASSIST_PATH, {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
        }, {
            metadata: { ideType: 'ANTIGRAVITY' }
        });

        console.log(`[Quota] fetchProjectId response: status=${result.status}, data=${JSON.stringify(result.data)?.substring(0, 500)}`);

        if (result.status === 200) {
            const projectId = result.data?.cloudaicompanionProject || result.data?.cloudaicompanion_project;
            if (projectId) return projectId;
        }

        // 记录失败原因
        console.log(`[Quota] fetchProjectId failed: status=${result.status}, error=${result.data?.error?.message || 'unknown'}`);
        return null;
    } catch (error) {
        console.log(`[Quota] fetchProjectId exception:`, error);
        return null;
    }
}

/** 获取真实的共享配额桶。fetchAvailableModels 可能只返回可用性式的假 100%。 */
async function fetchQuotaSummary(accessToken: string, projectId: string): Promise<ParsedQuotaSummary | null> {
    const summaries: ParsedQuotaSummary[] = [];

    for (const hostname of QUOTA_SUMMARY_HOSTS) {
        try {
            const result = await httpsPost(hostname, RETRIEVE_QUOTA_SUMMARY_PATH, {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'antigravity/1.2.4 windows/amd64'
            }, { project: projectId });

            if (result.status !== 200) {
                console.log(`[Quota] quota summary ${hostname} returned ${result.status}; trying next endpoint`);
                continue;
            }

            const parsed = parseQuotaSummary(result.data);
            if (parsed) {
                console.log(`[Quota] quota summary loaded from ${hostname}`);
                summaries.push(parsed);
                continue;
            }
            console.log(`[Quota] quota summary ${hostname} contained no valid quota buckets`);
        } catch (error) {
            console.log(`[Quota] quota summary ${hostname} failed:`, error);
        }
    }

    return mergeQuotaSummaries(summaries);
}

/** 获取账号配额 */
export async function fetchAccountQuota(accountId: string): Promise<QuotaData> {
    const accounts = listAccounts();
    const account = accounts.find(a => a.id === accountId);

    if (!account) {
        throw new Error('账号不存在');
    }

    const previousQuota = account.quota;

    // 确保 Token 有效
    const now = Math.floor(Date.now() / 1000);
    if (!account.token.access_token || account.token.expiry_timestamp < now + 300) {
        try {
            const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
            account.token.access_token = tokenRes.access_token;
            account.token.expires_in = tokenRes.expires_in;
            account.token.expiry_timestamp = now + tokenRes.expires_in;
            saveAccounts(accounts);
        } catch (error) {
            throw error;
        }
    }


    // 获取 Project ID，如果没有返回则使用默认值
    const DEFAULT_PROJECT_ID = 'bamboo-precept-lgxtn';
    let projectId = await fetchProjectId(account.token.access_token) || DEFAULT_PROJECT_ID;
    console.log(`[Quota] ${account.email} using project ID: ${projectId}`);

    // 获取配额
    let result = await httpsPost(CLOUD_CODE_API_BASE, FETCH_MODELS_PATH, {
        'Authorization': `Bearer ${account.token.access_token}`,
        'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
    }, { project: projectId });

    // access_token 可能在本地 expiry 到期前失效。遇到 401 时刷新一次并重试，
    // 同时持久化新 Token，供后续配额刷新和账号切换复用。
    if (result.status === 401) {
        console.log(`[Quota] ${account.email} access token rejected; refreshing and retrying once`);
        const refreshedAt = Math.floor(Date.now() / 1000);
        const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
        account.token.access_token = tokenRes.access_token;
        account.token.expires_in = tokenRes.expires_in;
        account.token.expiry_timestamp = refreshedAt + tokenRes.expires_in;
        saveAccounts(accounts);

        projectId = await fetchProjectId(account.token.access_token) || DEFAULT_PROJECT_ID;
        result = await httpsPost(CLOUD_CODE_API_BASE, FETCH_MODELS_PATH, {
            'Authorization': `Bearer ${account.token.access_token}`,
            'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
        }, { project: projectId });
    }

    console.log(`[Quota] fetchModels for ${account.email}: status=${result.status}, error=${result.data?.error?.message || 'none'}`);

    if (result.status === 403) {
        console.log(`[Quota] ${account.email} got 403, full response:`, JSON.stringify(result.data)?.substring(0, 500));
        const quota: QuotaData = {
            models: [],
            last_updated: Math.floor(Date.now() / 1000),
            is_forbidden: true
        };
        account.quota = quota;
        saveAccounts(accounts);
        return quota;
    }

    if (result.status !== 200) {
        const message = result.data?.error?.message || `HTTP ${result.status}`;
        throw new Error(`获取模型配额失败: ${message}`);
    }

    const quotaSummary = await fetchQuotaSummary(account.token.access_token, projectId);

    const quota: QuotaData = {
        models: [],
        last_updated: Math.floor(Date.now() / 1000)
    };

    if (result.data?.models) {
        for (const [name, info] of Object.entries(result.data.models as Record<string, any>)) {
            const quotaInfo = info.quotaInfo;
            if (!quotaInfo) continue;

            const nameLower = name.toLowerCase();
            let displayName = '';
            let modelType = '';

            // Claude Sonnet（不含 Thinking）
            if (nameLower.includes('claude') && nameLower.includes('sonnet') && !nameLower.includes('thinking')) {
                displayName = 'Claude Sonnet';
                modelType = 'claude';
            }
            // Gemini 3 Pro High
            else if (nameLower.includes('gemini') && nameLower.includes('3') && nameLower.includes('pro') && nameLower.includes('high')) {
                displayName = 'Gemini 3 Pro';
                modelType = 'gemini-pro';
            }
            // Gemini 3 Flash
            else if (nameLower.includes('gemini') && nameLower.includes('3') && nameLower.includes('flash') && !nameLower.includes('thinking') && !nameLower.includes('lite')) {
                displayName = 'Gemini 3 Flash';
                modelType = 'gemini-flash';
            }
            else {
                continue;
            }

            // 避免重复
            if (quota.models.find(q => q.name === modelType)) {
                continue;
            }

            quota.models.push({
                name: modelType,
                displayName,
                percentage: Math.round((quotaInfo.remainingFraction ?? 0) * 100),
                reset_time: quotaInfo.resetTime || ''
            });
        }
    }

    // summary 是当前 agy 使用的真实共享配额。percentage 始终表示 5 小时窗口，
    // weekly_percentage 单独保存周窗口，禁止在 5 小时耗尽后用周额度覆盖它。
    if (!quotaSummary) {
        // fetchAvailableModels 的 remainingFraction 可能是周额度，不能将它标成 5 小时额度。
        // 本次刷新失败时保留已有完整数据，避免周额度行间歇性消失。
        throw new Error('真实剩余用量暂不可用，已保留上一次配额数据');
    }

    if (quota.models.length === 0) {
        throw new Error('配额接口未返回可识别的 Claude 或 Gemini 模型');
    }

    const missingQuotaData = findMissingQuotaData(quota.models, quotaSummary, previousQuota?.models || []);
    if (missingQuotaData.length > 0) {
        throw new Error(`配额接口只返回部分数据（缺少 ${missingQuotaData.join('、')}），刷新失败，已保留上一次配额数据`);
    }

    for (const model of quota.models) {
        const windows = model.name === 'claude' ? quotaSummary.claude : quotaSummary.gemini;

        if (windows?.fiveHour) {
            model.percentage = windows.fiveHour.percentage;
            if (windows.fiveHour.resetTime) model.reset_time = windows.fiveHour.resetTime;
        }

        if (windows?.weekly) {
            model.weekly_percentage = windows.weekly.percentage;
            model.weekly_reset_time = windows.weekly.resetTime;
        }
    }

    // 按固定顺序排序模型：Claude Sonnet -> Gemini 3 Pro -> Gemini 3 Flash
    const modelOrder: Record<string, number> = {
        'claude': 0,
        'gemini-pro': 1,
        'gemini-flash': 2
    };
    quota.models.sort((a, b) => (modelOrder[a.name] ?? 99) - (modelOrder[b.name] ?? 99));

    account.quota = quota;
    saveAccounts(accounts);
    return quota;
}

function throwIfQuotaRefreshAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('配额刷新已取消');
    error.name = 'AbortError';
    throw error;
}

export async function refreshAccountQuotasSequentially(
    accountIds: string[],
    refreshAccount: (accountId: string) => Promise<unknown>,
    signal?: AbortSignal
): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const accountId of accountIds) {
        throwIfQuotaRefreshAborted(signal);
        try {
            await refreshAccount(accountId);
            success++;
        } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                throwIfQuotaRefreshAborted(signal);
                throw error;
            }
            failed++;
        }
        throwIfQuotaRefreshAborted(signal);
    }

    return { success, failed };
}

/** 刷新所有账号配额；取消后不再启动后续账号的网络请求。 */
export async function refreshAllQuotas(signal?: AbortSignal): Promise<{ success: number; failed: number }> {
    return refreshAccountQuotasSequentially(
        listAccounts().map(account => account.id),
        accountId => fetchAccountQuota(accountId),
        signal
    );
}

/** 获取最佳可用账号（配额最高且未禁用） */
export function getBestAvailableAccount(excludeId?: string): Account | null {
    const accounts = listAccounts();

    const available = accounts
        .filter(a => a.id !== excludeId && !a.disabled && !a.quota?.is_forbidden)
        .sort((a, b) => {
            const aQuota = getLowestQuota(a);
            const bQuota = getLowestQuota(b);
            return bQuota - aQuota;  // 降序
        });

    return available[0] || null;
}

/** 
 * 获取特定模型的最佳备选账号
 * - 必须未禁用、非 403
 * - 该模型 5 小时配额必须达到设定阈值
 * - 该模型配额必须高于当前账号的配额
 * - 优先选择 Gemini 周额度最高的账号，周额度相同再比较 5 小时额度
 */
export function getBestAvailableAccountForModel(modelName: string, threshold: number, currentAccountPercentage: number, excludeId?: string): Account | null {
    const accounts = listAccounts();
    return selectBestAvailableAccountForModel(accounts, modelName, threshold, currentAccountPercentage, excludeId);
}

/** 供自动切换和回归测试共用的纯候选选择逻辑。 */
export function selectBestAvailableAccountForModel(accounts: Account[], modelName: string, threshold: number, currentAccountPercentage: number, excludeId?: string): Account | null {

    // 1. 筛选出可用的备选账号
    const candidates = accounts.filter(a => {
        if (a.id === excludeId || a.disabled || a.quota?.is_forbidden) return false;
        const model = a.quota?.models.find(m => m.name === modelName);
        if (!model) return false;

        // 当前账号是在低于阈值时触发，因此等于阈值的备选账号已经可用。
        return model.percentage >= threshold && model.percentage > currentAccountPercentage;
    });

    if (candidates.length === 0) return null;

    // 周额度优先；周额度相同时再选触发模型 5 小时额度更高的账号。
    candidates.sort((a, b) => {
        const weeklyDifference = (getGeminiWeeklyQuota(b) ?? -1) - (getGeminiWeeklyQuota(a) ?? -1);
        if (weeklyDifference !== 0) return weeklyDifference;

        const aFiveHour = a.quota?.models.find(model => model.name === modelName)?.percentage ?? -1;
        const bFiveHour = b.quota?.models.find(model => model.name === modelName)?.percentage ?? -1;
        if (bFiveHour !== aFiveHour) return bFiveHour - aFiveHour;

        return (b.last_used || 0) - (a.last_used || 0);
    });

    return candidates[0];
}

/**
 * 获取 Gemini 周额度触发时的最佳备选账号。
 * - 周额度必须至少剩余 1%
 * - Gemini Pro 或 Flash 至少有一个模型的 5 小时额度可用
 * - 优先选择周额度最高的账号，周额度相同时再比较最佳 5 小时额度
 */
export function getBestAvailableAccountForGeminiWeekly(modelThresholds: Record<string, number>, excludeId?: string): Account | null {
    return selectBestAvailableAccountForGeminiWeekly(listAccounts(), modelThresholds, excludeId);
}

/** 供自动切换和回归测试共用的周额度候选选择逻辑。 */
export function selectBestAvailableAccountForGeminiWeekly(accounts: Account[], modelThresholds: Record<string, number>, excludeId?: string): Account | null {
    const getBestUsableFiveHourQuota = (account: Account): number => {
        const usableQuotas = (account.quota?.models || [])
            .filter(model => model.name === 'gemini-pro' || model.name === 'gemini-flash')
            .filter(model => model.percentage >= Math.max(modelThresholds[model.name] || 0, 1))
            .map(model => model.percentage);
        return usableQuotas.length > 0 ? Math.max(...usableQuotas) : -1;
    };

    const candidates = accounts.filter(account => {
        if (account.id === excludeId || account.disabled || account.quota?.is_forbidden) return false;
        const weeklyQuota = getGeminiWeeklyQuota(account);
        return typeof weeklyQuota === 'number'
            && weeklyQuota >= 1
            && getBestUsableFiveHourQuota(account) >= 1;
    });

    candidates.sort((a, b) => {
        const weeklyDifference = (getGeminiWeeklyQuota(b) ?? -1) - (getGeminiWeeklyQuota(a) ?? -1);
        if (weeklyDifference !== 0) return weeklyDifference;

        const fiveHourDifference = getBestUsableFiveHourQuota(b) - getBestUsableFiveHourQuota(a);
        if (fiveHourDifference !== 0) return fiveHourDifference;

        return (b.last_used || 0) - (a.last_used || 0);
    });

    return candidates[0] || null;
}

/** 获取账号的 Gemini 周额度，用于自动切换排序和提示。 */
export function getGeminiWeeklyQuota(account: Account): number | undefined {
    return account.quota?.models.find(model =>
        (model.name === 'gemini-pro' || model.name === 'gemini-flash')
        && typeof model.weekly_percentage === 'number'
    )?.weekly_percentage;
}

/** 获取账号最低配额 */
export function getLowestQuota(account: Account): number {
    if (!account.quota?.models.length) return -1;
    return Math.min(...account.quota.models.map(m => m.percentage));
}

/** 获取 OAuth 授权 URL */
export function getOAuthUrl(): string {
    return oauthService.getAuthUrl();
}

/** 导出账号 */
export function exportAccounts(accountIds?: string[]): { email: string; refresh_token: string }[] {
    const accounts = listAccounts();
    const toExport = accountIds
        ? accounts.filter(a => accountIds.includes(a.id))
        : accounts;

    return toExport.map(a => ({
        email: a.email,
        refresh_token: a.token.refresh_token
    }));
}
