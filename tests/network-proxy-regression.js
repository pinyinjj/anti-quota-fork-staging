const assert = require('assert');
const http = require('http');
const network = require('../out/services/networkService');

const proxyEnvironmentKeys = [
    'ANTI_QUOTA_PROXY',
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy',
    'NO_PROXY', 'no_proxy',
    'npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_proxy', 'npm_config_no_proxy',
];
const originalEnvironment = Object.fromEntries(proxyEnvironmentKeys.map(key => [key, process.env[key]]));

function clearProxyEnvironment() {
    for (const key of proxyEnvironmentKeys) delete process.env[key];
    network.resetNetworkCachesForTests();
}

function restoreProxyEnvironment() {
    clearProxyEnvironment();
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value !== undefined) process.env[key] = value;
    }
}

(async () => {
    let proxyServer;
    try {
        clearProxyEnvironment();

        process.env.ANTI_QUOTA_PROXY = 'direct';
        assert.deepStrictEqual(network.resolveProxyForUrl('https://oauth2.googleapis.com/token'), { source: 'direct' });

        process.env.ANTI_QUOTA_PROXY = '127.0.0.1:7890';
        assert.deepStrictEqual(network.resolveProxyForUrl('https://oauth2.googleapis.com/token'), {
            proxyUrl: 'http://127.0.0.1:7890',
            source: 'anti-quota',
        });

        process.env.ANTI_QUOTA_PROXY = 'http://proxy-user:proxy-secret@127.0.0.1:7890';
        const safeDescription = network.describeProxyForUrl('https://oauth2.googleapis.com/token');
        assert.strictEqual(safeDescription.proxy, 'http://127.0.0.1:7890');
        assert(!JSON.stringify(safeDescription).includes('proxy-secret'));

        delete process.env.ANTI_QUOTA_PROXY;
        process.env.HTTPS_PROXY = 'http://127.0.0.1:7891';
        process.env.NO_PROXY = 'oauth2.googleapis.com';
        assert.deepStrictEqual(network.resolveProxyForUrl('https://oauth2.googleapis.com/token'), { source: 'direct' });
        assert.deepStrictEqual(network.resolveProxyForUrl('https://www.googleapis.com/oauth2/v2/userinfo'), {
            proxyUrl: 'http://127.0.0.1:7891',
            source: 'environment',
        });

        clearProxyEnvironment();
        process.env.HTTP_PROXY = 'http://127.0.0.1:7892';
        assert.deepStrictEqual(network.resolveProxyForUrl('https://www.googleapis.com/oauth2/v2/userinfo'), {
            proxyUrl: 'http://127.0.0.1:7892',
            source: 'environment',
        }, '仅配置 HTTP_PROXY 时，HTTPS 请求也必须使用它作为后备代理');
        process.env.NO_PROXY = 'oauth2.googleapis.com';
        assert.deepStrictEqual(
            network.resolveProxyForUrl('https://oauth2.googleapis.com/token'),
            { source: 'direct' },
            'HTTP_PROXY 后备解析仍必须遵守 NO_PROXY'
        );
        assert.deepStrictEqual(network.resolveProxyForUrl('https://www.googleapis.com/oauth2/v2/userinfo'), {
            proxyUrl: 'http://127.0.0.1:7892',
            source: 'environment',
        });

        clearProxyEnvironment();
        let connectTarget = '';
        proxyServer = http.createServer();
        proxyServer.on('connect', (request, socket) => {
            connectTarget = request.url;
            socket.destroy();
        });
        await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
        const address = proxyServer.address();
        process.env.ANTI_QUOTA_PROXY = `http://proxy-user:proxy-secret@127.0.0.1:${address.port}`;

        let proxyError;
        try {
            await network.requestHttps('https://example.invalid/test', { method: 'GET' }, undefined, 2_000);
        } catch (error) {
            proxyError = error;
        }
        assert(proxyError instanceof Error, '代理隧道断开时请求应失败');
        assert.match(proxyError.message, /通过代理/);
        assert(!proxyError.message.includes('proxy-secret'), '错误信息不得泄露代理密码');
        assert.strictEqual(connectTarget, 'example.invalid:443', 'HTTPS 请求必须通过 CONNECT 隧道');

        console.log('network proxy regression tests passed');
    } finally {
        if (proxyServer) await new Promise(resolve => proxyServer.close(resolve));
        restoreProxyEnvironment();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
