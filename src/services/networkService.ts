/**
 * Anti Quota 统一 HTTPS 网络层。
 *
 * Node.js 的 https.request 不会自动读取 Windows 浏览器系统代理。本模块统一处理：
 * 1. ANTI_QUOTA_PROXY 显式配置；
 * 2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 与 NO_PROXY；
 * 3. Windows 当前用户的手动代理或 PAC/WPAD 解析结果。
 */

import * as https from 'https';
import { execFileSync } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline, Transform } from 'stream';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

export type ProxySource = 'anti-quota' | 'environment' | 'windows-system' | 'direct';

export interface ProxyResolution {
    proxyUrl?: string;
    source: ProxySource;
}

export interface HttpsResponse {
    status: number;
    body: string;
    headers: NodeJS.Dict<string | string[]>;
}

export interface NetworkDiagnostic {
    name: string;
    host: string;
    source: ProxySource;
    proxy?: string;
    reachable: boolean;
    status?: number;
    error?: string;
}

export interface DownloadHttpsOptions {
    /** 每一个初始或重定向目标都必须与此列表中的主机名完全匹配。 */
    allowedHosts: readonly string[];
    /** 会随同初始请求发送；跨来源重定向时会移除认证类敏感头。 */
    headers?: https.RequestOptions['headers'];
    /** 包含代理解析、所有重定向和文件写入的总时限。 */
    timeoutMs?: number;
    /** 响应正文的最大字节数。 */
    maxBytes?: number;
    /** 最多允许跟随的 HTTPS 重定向次数。 */
    maxRedirects?: number;
}

export interface DownloadHttpsResult {
    finalUrl: string;
    status: number;
    bytes: number;
    headers: NodeJS.Dict<string | string[]>;
}

const WINDOWS_PROXY_CACHE_TTL_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_REDIRECTS = 5;
const DEFAULT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'cookie2',
    'proxy-authorization',
]);
const proxyAgentCache = new Map<string, https.Agent>();
const windowsProxyCache = new Map<string, { expiresAt: number; proxyUrl?: string }>();
let lastProxyLogKey = '';

function normalizeProxyUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^(direct|none):?$/i.test(trimmed)) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return `http://${trimmed}`;
    return trimmed;
}

function sanitizeProxyUrl(proxyUrl: string): string {
    try {
        const parsed = new URL(proxyUrl);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString().replace(/\/$/, '');
    } catch {
        return '[代理地址格式无效]';
    }
}

function readWindowsSystemProxy(targetUrl: string): string | undefined {
    if (process.platform !== 'win32') return undefined;

    const target = new URL(targetUrl);
    const cacheKey = `${target.protocol}//${target.host}`;
    const cached = windowsProxyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.proxyUrl;

    // Windows PowerShell 的 GetSystemWebProxy 会解析手动代理、绕过列表和 PAC/WPAD，
    // 只返回当前目标真正应该使用的代理，不需要在 Node 中执行不受控的 PAC 脚本。
    const script = [
        '$target = [Uri]$args[0]',
        '$systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()',
        '$resolved = $systemProxy.GetProxy($target)',
        'if ($resolved -and $resolved.AbsoluteUri -ne $target.AbsoluteUri) {',
        '  [Console]::Out.Write($resolved.AbsoluteUri)',
        '}',
    ].join('; ');

    let proxyUrl: string | undefined;
    try {
        const output = execFileSync('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-Command', script,
            targetUrl,
        ], {
            encoding: 'utf8',
            timeout: 5_000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        proxyUrl = output ? normalizeProxyUrl(output) : undefined;
    } catch {
        // 系统代理读取失败时保持直连，最终网络错误会给出显式代理配置提示。
        proxyUrl = undefined;
    }

    windowsProxyCache.set(cacheKey, {
        expiresAt: Date.now() + WINDOWS_PROXY_CACHE_TTL_MS,
        proxyUrl,
    });
    return proxyUrl;
}

/** 解析指定目标应使用的代理，不返回或记录代理密码。 */
export function resolveProxyForUrl(targetUrl: string): ProxyResolution {
    const explicit = process.env.ANTI_QUOTA_PROXY?.trim();
    if (explicit) {
        const proxyUrl = normalizeProxyUrl(explicit);
        return proxyUrl ? { proxyUrl, source: 'anti-quota' } : { source: 'direct' };
    }

    const hasEnvironmentProxy = [
        'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
        'npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_proxy'
    ].some(name => !!process.env[name]?.trim());
    if (hasEnvironmentProxy) {
        // 环境层显式配置了 NO_PROXY 时必须尊重直连结果，不能再回退到系统代理。
        let environmentProxy = getProxyForUrl(targetUrl);
        const target = new URL(targetUrl);
        if (!environmentProxy && target.protocol === 'https:') {
            const hasHttpProxy = [
                'HTTP_PROXY', 'http_proxy', 'npm_config_http_proxy',
            ].some(name => !!process.env[name]?.trim());
            if (hasHttpProxy) {
                // proxy-from-env 不会把 HTTP_PROXY 作为 HTTPS 的后备代理。用相同主机和
                // HTTPS 有效端口再次解析，既取得 HTTP_PROXY，也继续遵守 NO_PROXY。
                const httpFallbackTarget = new URL(target.href);
                const effectivePort = target.port || '443';
                httpFallbackTarget.protocol = 'http:';
                httpFallbackTarget.port = effectivePort;
                environmentProxy = getProxyForUrl(httpFallbackTarget.href);
            }
        }
        return environmentProxy
            ? { proxyUrl: normalizeProxyUrl(environmentProxy), source: 'environment' }
            : { source: 'direct' };
    }

    const windowsProxy = readWindowsSystemProxy(targetUrl);
    if (windowsProxy) return { proxyUrl: windowsProxy, source: 'windows-system' };
    return { source: 'direct' };
}

/** 返回可安全显示的代理诊断，不包含用户名或密码。 */
export function describeProxyForUrl(targetUrl: string): { source: ProxySource; proxy?: string } {
    const resolution = resolveProxyForUrl(targetUrl);
    return {
        source: resolution.source,
        proxy: resolution.proxyUrl ? sanitizeProxyUrl(resolution.proxyUrl) : undefined,
    };
}

function getProxyAgent(proxyUrl: string): https.Agent {
    const cached = proxyAgentCache.get(proxyUrl);
    if (cached) return cached;

    const protocol = new URL(proxyUrl).protocol.toLowerCase();
    let agent: https.Agent;
    if (protocol === 'http:' || protocol === 'https:') {
        agent = new HttpsProxyAgent(proxyUrl);
    } else if (protocol === 'socks:' || protocol === 'socks4:' || protocol === 'socks4a:'
        || protocol === 'socks5:' || protocol === 'socks5h:') {
        agent = new SocksProxyAgent(proxyUrl);
    } else {
        throw new Error(`不支持的代理协议“${protocol}”，请使用 http://、https:// 或 socks5://`);
    }

    proxyAgentCache.set(proxyUrl, agent);
    return agent;
}

function logProxyOnce(resolution: ProxyResolution): void {
    if (!resolution.proxyUrl) return;
    const safeProxy = sanitizeProxyUrl(resolution.proxyUrl);
    const key = `${resolution.source}:${safeProxy}`;
    if (key === lastProxyLogKey) return;
    lastProxyLogKey = key;
    // 诊断走 stderr，避免破坏 CLI --json 的 stdout 契约。
    console.error(`[Network] 使用 ${resolution.source} 代理: ${safeProxy}`);
}

function networkError(error: unknown, target: URL, resolution: ProxyResolution): Error {
    const original = error instanceof Error ? error : new Error(String(error));
    const code = (error as NodeJS.ErrnoException)?.code;
    const safeProxy = resolution.proxyUrl ? sanitizeProxyUrl(resolution.proxyUrl) : '';
    let message = original.message;
    if (resolution.proxyUrl) {
        // 某些 Agent 错误会带出含用户名或密码的原始代理 URL，必须替换后再展示。
        message = message.split(resolution.proxyUrl).join(safeProxy);
    }
    const route = resolution.proxyUrl
        ? `通过代理 ${safeProxy}`
        : '直连（未检测到可用代理）';
    const certificateErrors = new Set([
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'CERT_HAS_EXPIRED',
    ]);
    const hint = code && certificateErrors.has(code)
        ? '代理正在检查 HTTPS 证书，请用 NODE_EXTRA_CA_CERTS 配置可信的企业根证书；不要关闭 TLS 校验。'
        : resolution.proxyUrl
            ? '请检查代理是否运行、端口是否正确；也可设置 ANTI_QUOTA_PROXY 覆盖自动检测。'
            : '如当前网络必须使用代理，请设置 ANTI_QUOTA_PROXY=http://127.0.0.1:端口 后重启 Anti Quota 服务。';
    const wrapped = new Error(`${route}访问 ${target.hostname} 失败${code ? ` [${code}]` : ''}: ${message}。${hint}`);
    wrapped.name = 'NetworkError';
    return wrapped;
}

function normalizeAllowedHostname(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('下载允许主机列表中不能包含空值');
    if (trimmed.includes('://') || /[\/@?#]/.test(trimmed)) {
        throw new Error(`下载允许主机必须是纯主机名，不能包含协议、端口或路径: ${trimmed}`);
    }

    const candidate = trimmed.includes(':') && !trimmed.startsWith('[')
        ? `[${trimmed}]`
        : trimmed;
    let parsed: URL;
    try {
        parsed = new URL(`https://${candidate}/`);
    } catch {
        throw new Error(`下载允许主机格式无效: ${trimmed}`);
    }
    if (parsed.port) {
        throw new Error(`下载允许主机必须是纯主机名，不能包含端口: ${trimmed}`);
    }
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
}

function parseAllowedDownloadTarget(targetUrl: string, allowedHosts: ReadonlySet<string>): URL {
    let target: URL;
    try {
        target = new URL(targetUrl);
    } catch {
        throw new Error('下载地址格式无效');
    }
    if (target.protocol !== 'https:') {
        throw new Error(`仅允许 HTTPS 下载: ${target.protocol}`);
    }
    if (target.username || target.password) {
        throw new Error('下载地址不得包含用户名或密码');
    }
    const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
    if (!allowedHosts.has(hostname)) {
        throw new Error(`下载主机不在允许列表中: ${target.hostname}`);
    }
    return target;
}

function stripHeadersForRedirect(
    headers: https.RequestOptions['headers'],
    crossOrigin: boolean
): https.RequestOptions['headers'] {
    if (!headers) return undefined;
    const nextHeaders: NonNullable<https.RequestOptions['headers']> = {};
    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase();
        // Host 必须始终由 Node 根据目标重建，Proxy-Authorization 只能由代理 Agent
        // 根据代理 URL 生成；来源认证信息不得越过来源边界。
        if (normalizedName === 'host'
            || normalizedName === 'proxy-authorization'
            || (crossOrigin && CROSS_ORIGIN_SENSITIVE_HEADERS.has(normalizedName))) {
            continue;
        }
        nextHeaders[name] = value;
    }
    return nextHeaders;
}

function validatePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} 必须是正整数`);
    }
    return value;
}

function validateRedirectLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('maxRedirects 必须是非负整数');
    }
    return value;
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function createDownloadError(message: string, name: string = 'DownloadError'): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

function isFileSystemError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return !!code && new Set([
        'EACCES', 'EBUSY', 'EEXIST', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOSPC', 'EROFS',
    ]).has(code);
}

/**
 * 将显式允许主机上的 HTTPS 响应流式写入文件。
 *
 * 下载使用与普通 API 请求相同的代理解析。总超时和字节上限覆盖整个重定向链；
 * 任何失败都会关闭活动连接并删除本次创建的部分文件，但不会删除预先存在的目标文件。
 */
export async function downloadHttpsFile(
    targetUrl: string,
    destination: string,
    options: DownloadHttpsOptions
): Promise<DownloadHttpsResult> {
    if (!destination || !destination.trim()) throw new Error('下载目标文件路径不能为空');
    if (!options || !Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0) {
        throw new Error('下载必须提供非空的 allowedHosts 列表');
    }

    const allowedHosts = new Set(options.allowedHosts.map(normalizeAllowedHostname));
    const initialTarget = parseAllowedDownloadTarget(targetUrl, allowedHosts);
    const timeoutMs = validatePositiveInteger(
        options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
        'timeoutMs'
    );
    const maxBytes = validatePositiveInteger(
        options.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
        'maxBytes'
    );
    const maxRedirects = validateRedirectLimit(
        options.maxRedirects ?? DEFAULT_DOWNLOAD_MAX_REDIRECTS
    );
    const deadline = Date.now() + timeoutMs;

    return new Promise<DownloadHttpsResult>((resolve, reject) => {
        let settled = false;
        let activeRequest: ReturnType<typeof https.request> | undefined;
        let activeResponse: NodeJS.ReadableStream & { destroy(error?: Error): void } | undefined;
        let activeWriteStream: WriteStream | undefined;
        let destinationCreated = false;

        const closeAndRemovePartialFile = async (): Promise<void> => {
            const stream = activeWriteStream;
            if (stream && !stream.closed) {
                const closed = new Promise<void>(resolveClose => stream.once('close', resolveClose));
                stream.destroy();
                await closed;
            }
            if (!destinationCreated) return;
            try {
                await unlink(destination);
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
            }
        };

        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimeout);
            const normalized = error instanceof Error ? error : new Error(String(error));
            activeRequest?.destroy();
            activeResponse?.destroy();
            void closeAndRemovePartialFile().then(
                () => reject(normalized),
                cleanupError => {
                    const cleanupMessage = cleanupError instanceof Error
                        ? cleanupError.message
                        : String(cleanupError);
                    const combined = new Error(
                        `${normalized.message}；清理部分文件失败: ${cleanupMessage}`
                    );
                    combined.name = normalized.name;
                    reject(combined);
                }
            );
        };

        const succeed = (result: DownloadHttpsResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimeout);
            resolve(result);
        };

        const totalTimeout = setTimeout(() => {
            fail(createDownloadError(`下载总时限 ${timeoutMs}ms 已到达`, 'DownloadTimeoutError'));
        }, timeoutMs);

        const requestTarget = (
            target: URL,
            headers: https.RequestOptions['headers'],
            redirectCount: number
        ): void => {
            if (settled) return;
            if (Date.now() >= deadline) {
                fail(createDownloadError(`下载总时限 ${timeoutMs}ms 已到达`, 'DownloadTimeoutError'));
                return;
            }

            let resolution: ProxyResolution = { source: 'direct' };
            let agent: https.Agent | undefined;
            try {
                resolution = resolveProxyForUrl(target.href);
                agent = resolution.proxyUrl ? getProxyAgent(resolution.proxyUrl) : undefined;
                logProxyOnce(resolution);
            } catch (error) {
                fail(networkError(error, target, resolution));
                return;
            }
            if (Date.now() >= deadline) {
                fail(createDownloadError(`下载总时限 ${timeoutMs}ms 已到达`, 'DownloadTimeoutError'));
                return;
            }

            const req = https.request(target, { method: 'GET', headers, agent }, res => {
                if (settled || activeRequest !== req) {
                    res.destroy();
                    return;
                }
                activeResponse = res;
                const status = res.statusCode || 0;
                res.once('error', error => {
                    // 重定向后的旧响应可能迟发 error，不能让它污染下一跳。
                    if (settled || activeResponse !== res || activeRequest !== req) return;
                    if (error.name === 'DownloadSizeLimitError' || isFileSystemError(error)) {
                        fail(error);
                    } else {
                        fail(networkError(error, target, resolution));
                    }
                });

                if (status === 407) {
                    fail(networkError(
                        new Error('代理要求认证 (HTTP 407)，请在代理 URL 中提供凭据'),
                        target,
                        resolution
                    ));
                    return;
                }

                if (REDIRECT_STATUS_CODES.has(status)) {
                    const locationValue = res.headers.location;
                    // 在启动下一跳前先让旧请求失活并销毁响应，禁止它继续后台下载。
                    if (activeResponse === res) activeResponse = undefined;
                    if (activeRequest === req) activeRequest = undefined;
                    res.destroy();
                    if (!locationValue) {
                        fail(createDownloadError(`HTTP ${status} 重定向缺少 Location`));
                        return;
                    }
                    if (redirectCount >= maxRedirects) {
                        fail(createDownloadError(`HTTPS 下载重定向次数超过限制 ${maxRedirects}`));
                        return;
                    }

                    let nextTarget: URL;
                    try {
                        nextTarget = parseAllowedDownloadTarget(
                            new URL(locationValue, target).href,
                            allowedHosts
                        );
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    const nextHeaders = stripHeadersForRedirect(
                        headers,
                        target.origin !== nextTarget.origin
                    );
                    requestTarget(nextTarget, nextHeaders, redirectCount + 1);
                    return;
                }

                if (status < 200 || status >= 300) {
                    fail(createDownloadError(`下载服务器返回 HTTP ${status}`));
                    return;
                }

                const declaredLength = parseContentLength(res.headers['content-length']);
                if (declaredLength !== undefined && declaredLength > maxBytes) {
                    fail(createDownloadError(
                        `下载文件声明大小 ${declaredLength} 字节，超过限制 ${maxBytes} 字节`,
                        'DownloadSizeLimitError'
                    ));
                    return;
                }

                let bytes = 0;
                const limiter = new Transform({
                    transform(chunk: Buffer | string, encoding, callback) {
                        const chunkBytes = Buffer.isBuffer(chunk)
                            ? chunk.length
                            : Buffer.byteLength(chunk, encoding);
                        bytes += chunkBytes;
                        if (bytes > maxBytes) {
                            callback(createDownloadError(
                                `下载内容超过限制 ${maxBytes} 字节`,
                                'DownloadSizeLimitError'
                            ));
                            return;
                        }
                        callback(null, chunk);
                    },
                });
                const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
                activeWriteStream = output;
                output.once('open', () => {
                    destinationCreated = true;
                });

                pipeline(res, limiter, output, error => {
                    if (error) {
                        if (settled) return;
                        if (error.name === 'DownloadSizeLimitError' || isFileSystemError(error)) {
                            fail(error);
                        } else {
                            fail(networkError(error, target, resolution));
                        }
                        return;
                    }
                    succeed({
                        finalUrl: target.href,
                        status,
                        bytes,
                        headers: res.headers,
                    });
                });
            });

            activeRequest = req;
            req.once('error', error => {
                if (!settled && activeRequest === req) {
                    fail(networkError(error, target, resolution));
                }
            });
            req.end();
        };

        requestTarget(initialTarget, stripHeadersForRedirect(options.headers, false), 0);
    });
}

/** 发起带总时限、自动代理选择的 HTTPS 请求。 */
export function requestHttps(
    targetUrl: string,
    options: https.RequestOptions,
    body?: string | Buffer,
    timeoutMs: number = 15_000,
    maxResponseBytes: number = DEFAULT_RESPONSE_MAX_BYTES
): Promise<HttpsResponse> {
    const target = new URL(targetUrl);
    if (target.protocol !== 'https:') {
        return Promise.reject(new Error(`仅允许 HTTPS 请求: ${target.protocol}`));
    }
    try {
        validatePositiveInteger(maxResponseBytes, 'maxResponseBytes');
    } catch (error) {
        return Promise.reject(error);
    }

    let resolution: ProxyResolution = { source: 'direct' };
    let agent: https.Agent | undefined;
    try {
        resolution = resolveProxyForUrl(target.href);
        agent = resolution.proxyUrl ? getProxyAgent(resolution.proxyUrl) : undefined;
        logProxyOnce(resolution);
    } catch (error) {
        return Promise.reject(networkError(error, target, resolution));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimeout);
            callback();
        };

        const requestOptions = {
            ...options,
            headers: stripHeadersForRedirect(options.headers, false),
            agent,
        };
        const req = https.request(target, requestOptions, res => {
            if (settled) {
                res.destroy();
                return;
            }
            if (res.statusCode === 407) {
                res.destroy();
                finish(() => reject(networkError(new Error('代理要求认证 (HTTP 407)，请在代理 URL 中提供凭据'), target, resolution)));
                return;
            }
            const declaredLength = parseContentLength(res.headers['content-length']);
            if (declaredLength !== undefined
                && declaredLength > maxResponseBytes) {
                res.destroy();
                finish(() => reject(createDownloadError(
                    `HTTPS 响应声明大小 ${declaredLength} 字节，超过限制 ${maxResponseBytes} 字节`,
                    'ResponseSizeLimitError'
                )));
                return;
            }
            let responseBody = '';
            let responseBytes = 0;
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (settled) return;
                responseBytes += Buffer.byteLength(chunk, 'utf8');
                if (responseBytes > maxResponseBytes) {
                    res.destroy(createDownloadError(
                        `HTTPS 响应超过限制 ${maxResponseBytes} 字节`,
                        'ResponseSizeLimitError'
                    ));
                    return;
                }
                responseBody += chunk;
            });
            res.on('end', () => finish(() => resolve({
                status: res.statusCode || 0,
                body: responseBody,
                headers: res.headers,
            })));
            res.on('error', error => finish(() => reject(
                error.name === 'ResponseSizeLimitError'
                    ? error
                    : networkError(error, target, resolution)
            )));
        });

        const totalTimeout = setTimeout(() => {
            req.destroy(new Error(`请求总时限 ${timeoutMs}ms 已到达`));
        }, timeoutMs);

        req.on('error', error => finish(() => reject(
            error.name === 'ResponseSizeLimitError'
                ? error
                : networkError(error, target, resolution)
        )));
        if (body !== undefined) req.write(body);
        req.end();
    });
}

/** 检查授权、用户信息和配额三个独立 Google 网络入口。收到任意 HTTP 响应即表示链路可达。 */
export async function diagnoseGoogleNetwork(): Promise<NetworkDiagnostic[]> {
    const targets = [
        { name: 'Google OAuth', url: 'https://oauth2.googleapis.com/token' },
        { name: 'Google UserInfo', url: 'https://www.googleapis.com/oauth2/v2/userinfo' },
        { name: 'Cloud Code', url: 'https://cloudcode-pa.googleapis.com/' },
    ];
    return Promise.all(targets.map(async target => {
        let route: { source: ProxySource; proxy?: string } = { source: 'direct' };
        try {
            route = describeProxyForUrl(target.url);
            const response = await requestHttps(target.url, { method: 'GET' }, undefined, 10_000);
            return {
                name: target.name,
                host: new URL(target.url).hostname,
                ...route,
                reachable: true,
                status: response.status,
            };
        } catch (error) {
            return {
                name: target.name,
                host: new URL(target.url).hostname,
                ...route,
                reachable: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }));
}

/** 仅供回归测试清理 Agent 和系统代理缓存。 */
export function resetNetworkCachesForTests(): void {
    for (const agent of proxyAgentCache.values()) agent.destroy();
    proxyAgentCache.clear();
    windowsProxyCache.clear();
    lastProxyLogKey = '';
}

