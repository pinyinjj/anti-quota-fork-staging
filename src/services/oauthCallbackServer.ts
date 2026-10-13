/**
 * OAuth 回调服务器
 * 启动本地 HTTP 服务器接收 Google OAuth 回调
 */

import * as http from 'http';

const CALLBACK_PORT = 19823;
const CALLBACK_PATH = '/oauth-callback';

interface LoopbackListener {
    host: '127.0.0.1' | '::1';
    ipv6Only?: boolean;
}

const LOOPBACK_LISTENERS: readonly LoopbackListener[] = [
    { host: '127.0.0.1' },
    { host: '::1', ipv6Only: true }
];

let servers: http.Server[] = [];
let callbackPending = false;
let activeSession: symbol | null = null;
let pendingResolve: ((code: string) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;
let serverTimeout: NodeJS.Timeout | null = null;
let pendingAbortSignal: AbortSignal | null = null;
let pendingAbortListener: (() => void) | null = null;

/**
 * 启动 OAuth 回调服务器并等待授权码
 * @param timeout 超时时间（毫秒），默认 5 分钟
 */
export function startCallbackServer(
    timeout: number = 5 * 60 * 1000,
    onReady?: () => void | Promise<void>,
    signal?: AbortSignal
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createCancellationError());
            return;
        }

        // 不要让第二次点击悄悄取消第一次授权并留下一个永远不结束的 Promise。
        if (callbackPending) {
            reject(new Error('已有 Google 授权正在进行，请先完成或取消后再试'));
            return;
        }

        const session = Symbol('oauth-callback-session');
        callbackPending = true;
        activeSession = session;
        pendingResolve = resolve;
        pendingReject = reject;
        pendingAbortSignal = signal || null;
        pendingAbortListener = signal ? () => settleReject(createCancellationError(), session) : null;
        if (signal && pendingAbortListener) signal.addEventListener('abort', pendingAbortListener, { once: true });

        let remainingListeners = LOOPBACK_LISTENERS.length;
        const listeningHosts: string[] = [];
        let readyStarted = false;

        const finishStartup = (): void => {
            if (activeSession !== session || remainingListeners !== 0 || readyStarted) return;
            if (listeningHosts.length === 0) {
                settleReject(new Error(`无法在本机回环地址启动 OAuth 回调服务器（端口 ${CALLBACK_PORT}）`), session);
                return;
            }

            readyStarted = true;
            const addresses = listeningHosts.map(host =>
                host === '::1' ? `[::1]:${CALLBACK_PORT}` : `${host}:${CALLBACK_PORT}`
            );
            console.log(`[OAuth] Callback server started on ${addresses.join(', ')}`);
            void (async () => {
                try {
                    await onReady?.();
                } catch (error) {
                    settleReject(error instanceof Error ? error : new Error(String(error)), session);
                }
            })();
        };

        for (const listener of LOOPBACK_LISTENERS) {
            const candidate = http.createServer((req, res) => handleRequest(session, req, res));
            servers.push(candidate);
            let bindSettled = false;

            candidate.once('listening', () => {
                if (bindSettled || activeSession !== session) return;
                bindSettled = true;
                remainingListeners--;
                listeningHosts.push(listener.host);
                finishStartup();
            });

            candidate.on('error', (error: NodeJS.ErrnoException) => {
                if (activeSession !== session) return;

                // 某一地址族可能在系统层面被禁用；此时安全地降级到另一回环地址。
                if (!bindSettled && isUnavailableAddressFamily(error)) {
                    bindSettled = true;
                    remainingListeners--;
                    console.log(`[OAuth] Loopback ${listener.host} is unavailable; using the other address family`);
                    finishStartup();
                    return;
                }

                // 端口占用、权限错误及未知错误均安全失败，避免浏览器把授权码交给其他进程。
                settleReject(createListenError(listener.host, error), session);
            });

            candidate.listen({
                port: CALLBACK_PORT,
                host: listener.host,
                ipv6Only: listener.ipv6Only
            });
        }

        // 设置超时
        serverTimeout = setTimeout(() => {
            settleReject(new Error('OAuth 授权超时，请重试'), session);
        }, timeout);
    });
}

/**
 * 停止回调服务器
 */
export function stopCallbackServer(reason: Error = createCancellationError()): void {
    const session = activeSession;
    if (!session || (!callbackPending && !pendingReject)) return;
    settleReject(reason, session);
}

/**
 * 检查服务器是否在运行
 */
export function isServerRunning(): boolean {
    return callbackPending;
}

function cleanup(session: symbol): void {
    if (activeSession !== session) return;

    activeSession = null;
    callbackPending = false;
    if (serverTimeout) {
        clearTimeout(serverTimeout);
        serverTimeout = null;
    }

    const activeServers = servers;
    servers = [];
    for (const activeServer of activeServers) {
        activeServer.close();
    }

    if (pendingAbortSignal && pendingAbortListener) {
        pendingAbortSignal.removeEventListener('abort', pendingAbortListener);
    }
    pendingAbortSignal = null;
    pendingAbortListener = null;
    pendingResolve = null;
    pendingReject = null;
}

function settleReject(error: Error, session: symbol): void {
    if (activeSession !== session) return;
    const reject = pendingReject;
    cleanup(session);
    reject?.(error);
}

function settleResolve(code: string, session: symbol): void {
    if (activeSession !== session) return;
    const resolve = pendingResolve;
    cleanup(session);
    resolve?.(code);
}

function handleRequest(session: symbol, req: http.IncomingMessage, res: http.ServerResponse): void {
    // 授权完成后会立即关闭 listener；同时关闭客户端连接，避免后续授权复用到旧 session。
    res.setHeader('Connection', 'close');

    if (activeSession !== session) {
        res.writeHead(410);
        res.end('Gone');
        return;
    }

    const url = new URL(req.url || '', `http://localhost:${CALLBACK_PORT}`);

    if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (error) {
        res.writeHead(400);
        res.end(getErrorHtml(error));
        settleReject(new Error(`OAuth 错误: ${error}`), session);
    } else if (code) {
        res.writeHead(200);
        res.end(getSuccessHtml());
        settleResolve(code, session);
    } else {
        res.writeHead(400);
        res.end(getErrorHtml('未收到授权码'));
    }
}

function isUnavailableAddressFamily(error: NodeJS.ErrnoException): boolean {
    return error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL';
}

function createListenError(host: string, error: NodeJS.ErrnoException): Error {
    if (error.code === 'EADDRINUSE') {
        return new Error(`OAuth 回调地址 ${host}:${CALLBACK_PORT} 已被占用，请关闭占用该端口的进程后重试`);
    }
    if (error.code === 'EACCES') {
        return new Error(`无权监听 OAuth 回调地址 ${host}:${CALLBACK_PORT}，请检查系统或安全软件设置`);
    }
    return new Error(`无法监听 OAuth 回调地址 ${host}:${CALLBACK_PORT}: ${error.message}`);
}

function createCancellationError(): Error {
    const error = new Error('OAuth 授权已取消');
    error.name = 'AbortError';
    return error;
}

function getSuccessHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>授权成功</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { margin: 0 0 10px; font-size: 28px; }
        p { margin: 0; opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>授权成功！</h1>
        <p>您可以关闭此窗口，返回 Anti Quota。</p>
    </div>
    <script>
        // 3秒后自动关闭
        setTimeout(() => window.close(), 3000);
    </script>
</body>
</html>`;
}

function getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>授权失败</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f44336 0%, #e91e63 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { margin: 0 0 10px; font-size: 28px; }
        p { margin: 0; opacity: 0.9; }
        .error { font-family: monospace; margin-top: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">❌</div>
        <h1>授权失败</h1>
        <p>请返回 Anti Quota 重试。</p>
        <div class="error">${error}</div>
    </div>
</body>
</html>`;
}
