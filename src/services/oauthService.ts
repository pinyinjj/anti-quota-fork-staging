/**
 * Google OAuth 服务
 * 处理授权、Token 刷新等
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStoragePath } from './accountStorage';
import { requestHttps } from './networkService';

// 客户端凭据只从本机配置读取，源码和发行包不携带默认值。
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// 固定的 redirect_uri
const REDIRECT_URI = 'http://localhost:19823/oauth-callback';

const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

export interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
    refresh_token?: string;
}

export interface UserInfo {
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
}

export interface OAuthClientConfig {
    client_id: string;
    client_secret: string;
}

/** 每次操作重新读取，使服务与 VS Code 可共享配置且无需重启即可更新文件。 */
export function getOAuthClientConfig(): OAuthClientConfig {
    const clientId = process.env.ANTI_QUOTA_GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.ANTI_QUOTA_GOOGLE_CLIENT_SECRET?.trim();
    if (clientId || clientSecret) {
        if (!clientId || !clientSecret) {
            throw new Error('请同时设置 ANTI_QUOTA_GOOGLE_CLIENT_ID 和 ANTI_QUOTA_GOOGLE_CLIENT_SECRET；不能混用不同来源的 OAuth 客户端参数');
        }
        return validateClientConfig({ client_id: clientId, client_secret: clientSecret });
    }

    const configPath = path.join(path.dirname(getStoragePath()), 'oauth-client.json');
    let contents: string;
    try {
        if (fs.statSync(configPath).size > 64 * 1024) throw new Error('oversized configuration');
        contents = fs.readFileSync(configPath, 'utf8');
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            throw new Error('尚未配置 Google OAuth 客户端。请在账号数据目录的 oauth-client.json 中填写 client_id 和 client_secret，或同时设置 ANTI_QUOTA_GOOGLE_CLIENT_ID / ANTI_QUOTA_GOOGLE_CLIENT_SECRET；详见 README');
        }
        // 不回显配置内容、系统路径或解析异常，避免凭据进入日志。
        throw new Error('无法读取 oauth-client.json，请检查文件权限、类型和大小（上限 64 KiB）');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents.replace(/^\uFEFF/, ''));
    } catch {
        throw new Error('oauth-client.json 不是有效 JSON，请检查格式');
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'installed' in parsed) {
        parsed = (parsed as Record<string, unknown>).installed;
    }
    return validateClientConfig(parsed);
}

function validateClientConfig(value: unknown): OAuthClientConfig {
    const candidate = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    const clientId = typeof candidate.client_id === 'string' ? candidate.client_id.trim() : '';
    const clientSecret = typeof candidate.client_secret === 'string' ? candidate.client_secret.trim() : '';
    if (!clientId || !clientSecret || clientId === 'YOUR_CLIENT_ID' || clientSecret === 'YOUR_CLIENT_SECRET'
        || clientId.length > 4096 || clientSecret.length > 4096
        || /[\x00-\x20\x7f]/.test(clientId) || /[\x00-\x20\x7f]/.test(clientSecret)) {
        throw new Error('OAuth 客户端配置无效：client_id 和 client_secret 必须是有效的非空字符串，请替换示例占位符');
    }
    return { client_id: clientId, client_secret: clientSecret };
}

/**
 * 生成 OAuth 授权 URL
 */
export function getAuthUrl(): string {
    const config = getOAuthClientConfig();
    const params = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true'
    });
    return `${AUTH_URL}?${params.toString()}`;
}

/**
 * 从回调 URL 中提取 code
 */
export function extractCodeFromUrl(url: string): string | null {
    try {
        let urlObj: URL;
        if (url.startsWith('http')) {
            urlObj = new URL(url);
        } else if (url.includes('code=')) {
            urlObj = new URL('http://localhost?' + url);
        } else {
            return null;
        }
        return urlObj.searchParams.get('code');
    } catch {
        const match = url.match(/code=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }
}

/**
 * 使用 Authorization Code 交换 Token
 */
export async function exchangeCode(code: string): Promise<TokenResponse> {
    const config = getOAuthClientConfig();
    const postData = new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
    }).toString();
    const response = await requestHttps(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData, 20_000);
    const json = parseJson(response.body, 'Token exchange');
    if (!json.access_token) throw new Error(`Token exchange failed (HTTP ${response.status}): ${getApiError(json)}`);
    return json as TokenResponse;
}

/**
 * 刷新 Access Token
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const config = getOAuthClientConfig();
    const postData = new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    }).toString();
    const response = await requestHttps(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData, 20_000);
    const json = parseJson(response.body, 'Token refresh');
    if (!json.access_token) throw new Error(`Token refresh failed (HTTP ${response.status}): ${getApiError(json)}`);
    return json as TokenResponse;
}

/**
 * 获取用户信息
 */
export async function getUserInfo(accessToken: string): Promise<UserInfo> {
    const response = await requestHttps(USERINFO_URL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` }
    }, undefined, 15_000);
    const json = parseJson(response.body, 'Get user info');
    if (!json.email) throw new Error(`Get user info failed (HTTP ${response.status}): ${getApiError(json)}`);
    return json as UserInfo;
}

function parseJson(value: string, operation: string): Record<string, any> {
    try {
        return JSON.parse(value) as Record<string, any>;
    } catch {
        throw new Error(`${operation} returned invalid JSON`);
    }
}

function getApiError(value: Record<string, any>): string {
    return value.error_description || value.error?.message || value.error || 'unknown error';
}
