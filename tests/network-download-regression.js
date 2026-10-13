const assert = require('assert');
const fs = require('fs');
const fsPromises = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const proxyEnvironmentKeys = [
    'ANTI_QUOTA_PROXY',
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy',
    'NO_PROXY', 'no_proxy',
    'npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_proxy', 'npm_config_no_proxy',
];
const originalEnvironment = Object.fromEntries(proxyEnvironmentKeys.map(key => [key, process.env[key]]));
const originalHttpsRequest = https.request;

function clearProxyEnvironment() {
    for (const key of proxyEnvironmentKeys) delete process.env[key];
    process.env.ANTI_QUOTA_PROXY = 'direct';
}

function restoreProxyEnvironment() {
    for (const key of proxyEnvironmentKeys) delete process.env[key];
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value !== undefined) process.env[key] = value;
    }
}

function installLocalHttpsAdapter() {
    const state = {
        destroyedPaths: new Set(),
        lateRedirectResponse: undefined,
        redirectResponseDestroyedBeforeFollow: false,
    };
    // 生产代码仍会验证 https:。测试仅把已经通过验证的请求传输映射到本机 HTTP，
    // 从而不需要关闭 TLS 校验、写入系统证书或访问真实网络。
    https.request = (input, options, callback) => {
        const target = input instanceof URL ? new URL(input.href) : new URL(String(input));
        assert.strictEqual(target.protocol, 'https:', '下载器交给传输层的目标必须仍是 HTTPS');
        const requestPath = target.pathname;
        if (requestPath === '/late-error-final') {
            state.redirectResponseDestroyedBeforeFollow = !!state.lateRedirectResponse?.destroyed;
        }
        target.protocol = 'http:';
        target.hostname = '127.0.0.1';
        const localOptions = { ...(options || {}) };
        delete localOptions.agent;
        return http.request(target, localOptions, response => {
            const originalDestroy = response.destroy;
            response.destroy = function (...args) {
                state.destroyedPaths.add(requestPath);
                return originalDestroy.apply(this, args);
            };
            if (requestPath === '/late-error-redirect') {
                state.lateRedirectResponse = response;
            }
            callback(response);
            if (requestPath === '/late-error-redirect') {
                setTimeout(() => response.emit('error', new Error('late redirect response error')), 15);
            }
        });
    };
    return state;
}

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server;
}

function portOf(server) {
    const address = server.address();
    assert(address && typeof address === 'object');
    return address.port;
}

async function exists(filePath) {
    try {
        await fsPromises.access(filePath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

(async () => {
    let sourceServer;
    let mirrorServer;
    let tempDirectory;
    try {
        clearProxyEnvironment();
        const adapterState = installLocalHttpsAdapter();
        const network = require('../out/services/networkService');
        network.resetNetworkCachesForTests();

        let sourceHeaders;
        let mirrorHeaders;
        let sameOriginAuthorization;
        let requestHeaders;
        const binaryBody = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);

        mirrorServer = await listen((request, response) => {
            mirrorHeaders = request.headers;
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.end(binaryBody);
        });
        const mirrorPort = portOf(mirrorServer);

        sourceServer = await listen((request, response) => {
            if (request.url === '/binary') {
                response.writeHead(200, {
                    'content-type': 'application/octet-stream',
                    'content-length': binaryBody.length,
                });
                response.end(binaryBody);
                return;
            }
            if (request.url === '/cross-origin') {
                sourceHeaders = request.headers;
                response.writeHead(302, {
                    location: `https://mirror.test:${mirrorPort}/asset`,
                });
                response.end();
                return;
            }
            if (request.url === '/same-origin') {
                response.writeHead(302, { location: '/same-origin-final' });
                response.end();
                return;
            }
            if (request.url === '/same-origin-final') {
                sameOriginAuthorization = request.headers.authorization;
                response.end(binaryBody);
                return;
            }
            if (request.url === '/late-error-redirect') {
                response.writeHead(302, { location: '/late-error-final' });
                response.flushHeaders();
                setTimeout(() => response.end('ignored redirect body'), 100);
                return;
            }
            if (request.url === '/late-error-final') {
                setTimeout(() => response.end(binaryBody), 50);
                return;
            }
            if (request.url === '/blocked-redirect') {
                response.writeHead(302, {
                    location: `https://blocked.test:${mirrorPort}/asset`,
                });
                response.end();
                return;
            }
            if (request.url === '/loop') {
                response.writeHead(302, { location: '/loop' });
                response.end();
                return;
            }
            if (request.url === '/large') {
                response.writeHead(200, { 'content-type': 'application/octet-stream' });
                response.write(Buffer.alloc(8, 0xaa));
                response.end(Buffer.alloc(8, 0xbb));
                return;
            }
            if (request.url === '/declared-large') {
                response.writeHead(200, { 'content-length': '4096' });
                response.end('small');
                return;
            }
            if (request.url === '/large-json') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.write('{"padding":"');
                response.end(`${'x'.repeat(64)}"}`);
                return;
            }
            if (request.url === '/request-407') {
                response.writeHead(407, { 'content-length': String(32 * 1024 * 1024) });
                response.write('proxy body must not be downloaded');
                setTimeout(() => response.end(), 100);
                return;
            }
            if (request.url === '/request-default-too-large') {
                response.writeHead(200, { 'content-length': String((16 * 1024 * 1024) + 1) });
                response.write('oversized body must not be downloaded');
                setTimeout(() => response.end(), 100);
                return;
            }
            if (request.url === '/request-headers') {
                requestHeaders = request.headers;
                response.end('ok');
                return;
            }
            if (request.url === '/broken') {
                response.writeHead(200, { 'content-type': 'application/octet-stream' });
                response.write('partial');
                setTimeout(() => response.destroy(), 20);
                return;
            }
            if (request.url === '/slow-redirect') {
                setTimeout(() => {
                    response.writeHead(302, { location: '/slow-final' });
                    response.end();
                }, 80);
                return;
            }
            if (request.url === '/slow-final') {
                setTimeout(() => response.end(binaryBody), 80);
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const sourcePort = portOf(sourceServer);
        const sourceBase = `https://source.test:${sourcePort}`;

        tempDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'anti-quota-download-test-'));

        await assert.rejects(
            network.downloadHttpsFile(
                `http://source.test:${sourcePort}/binary`,
                path.join(tempDirectory, 'http.bin'),
                { allowedHosts: ['source.test'] }
            ),
            /仅允许 HTTPS/
        );
        await assert.rejects(
            network.downloadHttpsFile(
                `${sourceBase}/binary`,
                path.join(tempDirectory, 'host.bin'),
                { allowedHosts: ['mirror.test'] }
            ),
            /不在允许列表/
        );

        const binaryPath = path.join(tempDirectory, 'binary.bin');
        const binaryResult = await network.downloadHttpsFile(`${sourceBase}/binary`, binaryPath, {
            allowedHosts: ['source.test'],
            maxBytes: 1024,
            timeoutMs: 2_000,
        });
        assert.deepStrictEqual(await fsPromises.readFile(binaryPath), binaryBody);
        assert.strictEqual(binaryResult.bytes, binaryBody.length);
        assert.strictEqual(binaryResult.status, 200);

        const redirectPath = path.join(tempDirectory, 'redirect.bin');
        const redirectResult = await network.downloadHttpsFile(`${sourceBase}/cross-origin`, redirectPath, {
            allowedHosts: ['source.test', 'mirror.test'],
            headers: {
                Authorization: 'Bearer test-secret',
                Cookie: 'session=test-secret',
                'Proxy-Authorization': 'Basic test-secret',
                Host: 'spoofed.invalid',
                'X-Keep': 'kept',
            },
            maxBytes: 1024,
            timeoutMs: 2_000,
        });
        assert(sourceHeaders, '初始服务器应收到请求');
        assert.strictEqual(sourceHeaders.authorization, 'Bearer test-secret');
        assert.strictEqual(sourceHeaders.cookie, 'session=test-secret');
        assert.strictEqual(sourceHeaders['proxy-authorization'], undefined, '初始请求不得发送代理凭据');
        assert.notStrictEqual(sourceHeaders.host, 'spoofed.invalid', '初始请求必须重建 Host');
        assert(mirrorHeaders, '重定向服务器应收到请求');
        assert.strictEqual(mirrorHeaders.authorization, undefined, '跨来源不得转发 Authorization');
        assert.strictEqual(mirrorHeaders.cookie, undefined, '跨来源不得转发 Cookie');
        assert.strictEqual(mirrorHeaders['proxy-authorization'], undefined, '跨来源不得转发代理凭据');
        assert.notStrictEqual(mirrorHeaders.host, 'spoofed.invalid', '重定向必须重建 Host');
        assert.strictEqual(mirrorHeaders['x-keep'], 'kept', '普通头应保留');
        assert.strictEqual(redirectResult.finalUrl, `https://mirror.test:${mirrorPort}/asset`);
        assert.deepStrictEqual(await fsPromises.readFile(redirectPath), binaryBody);

        const sameOriginPath = path.join(tempDirectory, 'same-origin.bin');
        await network.downloadHttpsFile(`${sourceBase}/same-origin`, sameOriginPath, {
            allowedHosts: ['source.test'],
            headers: { Authorization: 'Bearer same-origin' },
            timeoutMs: 2_000,
        });
        assert.strictEqual(sameOriginAuthorization, 'Bearer same-origin');

        const lateErrorRedirectPath = path.join(tempDirectory, 'late-error-redirect.bin');
        await network.downloadHttpsFile(`${sourceBase}/late-error-redirect`, lateErrorRedirectPath, {
            allowedHosts: ['source.test'],
            timeoutMs: 2_000,
        });
        assert.strictEqual(
            adapterState.redirectResponseDestroyedBeforeFollow,
            true,
            '必须销毁旧重定向响应后才创建下一跳请求'
        );
        assert.deepStrictEqual(await fsPromises.readFile(lateErrorRedirectPath), binaryBody);

        const blockedPath = path.join(tempDirectory, 'blocked.bin');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/blocked-redirect`, blockedPath, {
                allowedHosts: ['source.test'],
                timeoutMs: 2_000,
            }),
            /不在允许列表/
        );
        assert.strictEqual(await exists(blockedPath), false);

        const loopPath = path.join(tempDirectory, 'loop.bin');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/loop`, loopPath, {
                allowedHosts: ['source.test'],
                maxRedirects: 1,
                timeoutMs: 2_000,
            }),
            /重定向次数超过限制 1/
        );
        assert.strictEqual(await exists(loopPath), false);

        const largePath = path.join(tempDirectory, 'large.bin');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/large`, largePath, {
                allowedHosts: ['source.test'],
                maxBytes: 12,
                timeoutMs: 2_000,
            }),
            error => error && error.name === 'DownloadSizeLimitError'
        );
        assert.strictEqual(await exists(largePath), false, '超限后不得留下部分文件');

        const declaredLargePath = path.join(tempDirectory, 'declared-large.bin');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/declared-large`, declaredLargePath, {
                allowedHosts: ['source.test'],
                maxBytes: 12,
                timeoutMs: 2_000,
            }),
            error => error && error.name === 'DownloadSizeLimitError'
        );
        assert.strictEqual(await exists(declaredLargePath), false);

        await assert.rejects(
            network.requestHttps(
                `${sourceBase}/large-json`,
                { method: 'GET' },
                undefined,
                2_000,
                16
            ),
            error => error && error.name === 'ResponseSizeLimitError'
        );

        await assert.rejects(
            network.requestHttps(`${sourceBase}/request-407`, { method: 'GET' }, undefined, 2_000),
            error => error && error.name === 'NetworkError' && /407/.test(error.message)
        );
        assert(
            adapterState.destroyedPaths.has('/request-407'),
            'HTTP 407 必须立即销毁响应，不能继续后台读取正文'
        );

        await assert.rejects(
            network.requestHttps(
                `${sourceBase}/request-default-too-large`,
                { method: 'GET' },
                undefined,
                2_000
            ),
            error => error && error.name === 'ResponseSizeLimitError' && /16777216/.test(error.message)
        );
        assert(
            adapterState.destroyedPaths.has('/request-default-too-large'),
            '声明大小超过默认 16 MiB 上限时必须立即销毁响应'
        );

        const requestHeaderResult = await network.requestHttps(`${sourceBase}/request-headers`, {
            method: 'GET',
            headers: {
                Authorization: 'Bearer origin-secret',
                Cookie: 'session=origin-secret',
                'Proxy-Authorization': 'Basic proxy-secret',
                Host: 'spoofed.invalid',
            },
        });
        assert.strictEqual(requestHeaderResult.body, 'ok');
        assert.strictEqual(requestHeaders.authorization, 'Bearer origin-secret');
        assert.strictEqual(requestHeaders.cookie, 'session=origin-secret');
        assert.strictEqual(requestHeaders['proxy-authorization'], undefined);
        assert.notStrictEqual(requestHeaders.host, 'spoofed.invalid');

        const brokenPath = path.join(tempDirectory, 'broken.bin');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/broken`, brokenPath, {
                allowedHosts: ['source.test'],
                timeoutMs: 2_000,
            })
        );
        assert.strictEqual(await exists(brokenPath), false, '断流后不得留下部分文件');

        const timeoutPath = path.join(tempDirectory, 'timeout.bin');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/slow-redirect`, timeoutPath, {
                allowedHosts: ['source.test'],
                timeoutMs: 120,
            }),
            error => error && error.name === 'DownloadTimeoutError'
        );
        assert.strictEqual(await exists(timeoutPath), false, '共享总超时后不得留下部分文件');

        const existingPath = path.join(tempDirectory, 'existing.bin');
        await fsPromises.writeFile(existingPath, 'keep-existing');
        await assert.rejects(
            network.downloadHttpsFile(`${sourceBase}/binary`, existingPath, {
                allowedHosts: ['source.test'],
                timeoutMs: 2_000,
            }),
            error => error && error.code === 'EEXIST'
        );
        assert.strictEqual(await fsPromises.readFile(existingPath, 'utf8'), 'keep-existing');

        console.log('network download regression tests passed');
    } finally {
        https.request = originalHttpsRequest;
        restoreProxyEnvironment();
        if (sourceServer) await new Promise(resolve => sourceServer.close(resolve));
        if (mirrorServer) await new Promise(resolve => mirrorServer.close(resolve));
        if (tempDirectory) {
            await fsPromises.rm(tempDirectory, { recursive: true, force: true });
        }
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
