const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const oauthCallback = require('../out/services/oauthCallbackServer');

async function expectRejected(promise, pattern) {
    await assert.rejects(promise, pattern);
}

function listen(host, port = 19823) {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.once('error', reject);
        server.listen({ port, host, ipv6Only: host === '::1' }, () => resolve(server));
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function sendCallback(host, code) {
    const address = host === '::1' ? '[::1]' : host;
    return new Promise((resolve, reject) => {
        const request = http.get(`http://${address}:19823/oauth-callback?code=${encodeURIComponent(code)}`, response => {
            response.resume();
            response.once('end', resolve);
        });
        request.once('error', reject);
    });
}

async function supportsIpv6Loopback() {
    try {
        const probe = await listen('::1', 0);
        await close(probe);
        return true;
    } catch (error) {
        if (error && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) return false;
        throw error;
    }
}

async function assertPortAvailable(host) {
    const probe = await listen(host);
    await close(probe);
}

async function assertLoopbackPortsAvailable(ipv6Available) {
    await assertPortAvailable('127.0.0.1');
    if (ipv6Available) await assertPortAvailable('::1');
}

async function completeThrough(host, code) {
    let callbackRequest;
    let readyCount = 0;
    const completed = oauthCallback.startCallbackServer(10_000, () => {
        readyCount++;
        callbackRequest = sendCallback(host, code);
    });
    assert.strictEqual(await completed, code);
    await callbackRequest;
    assert.strictEqual(readyCount, 1);
    assert.strictEqual(oauthCallback.isServerRunning(), false);
}

async function completeWithUnavailableListener(unavailableOrdinal, activeHost, code) {
    const originalCreateServer = http.createServer;
    let created = 0;
    let callbackRequest;

    http.createServer = function (...args) {
        created++;
        if (created !== unavailableOrdinal) return originalCreateServer.apply(this, args);

        const unavailable = new EventEmitter();
        unavailable.listen = () => {
            process.nextTick(() => {
                const error = new Error('address family unavailable for regression test');
                error.code = 'EAFNOSUPPORT';
                unavailable.emit('error', error);
            });
            return unavailable;
        };
        unavailable.close = () => unavailable;
        return unavailable;
    };

    try {
        const completed = oauthCallback.startCallbackServer(10_000, () => {
            callbackRequest = sendCallback(activeHost, code);
        });
        http.createServer = originalCreateServer;
        assert.strictEqual(await completed, code);
        await callbackRequest;
    } finally {
        http.createServer = originalCreateServer;
        oauthCallback.stopCallbackServer();
    }
}

(async () => {
    const ipv6Available = await supportsIpv6Loopback();

    // 客户端取消后必须立即结束等待并释放 IPv4/IPv6 两个监听。
    const controller = new AbortController();
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    const cancelled = oauthCallback.startCallbackServer(10_000, markReady, controller.signal);
    await ready;
    assert.strictEqual(oauthCallback.isServerRunning(), true);
    controller.abort();
    await expectRejected(cancelled, /已取消/);
    assert.strictEqual(oauthCallback.isServerRunning(), false);
    await assertLoopbackPortsAvailable(ipv6Available);

    // 重复点击不能悄悄替换第一个流程，两个 Promise 都必须有明确结果。
    const first = oauthCallback.startCallbackServer(10_000);
    await expectRejected(oauthCallback.startCallbackServer(10_000), /已有 Google 授权正在进行/);
    oauthCallback.stopCallbackServer();
    await expectRejected(first, /已取消/);

    // 两个 localhost 地址族都能独立完成回调。
    await completeThrough('127.0.0.1', 'ipv4-test-code');
    if (ipv6Available) await completeThrough('::1', 'ipv6-test-code');

    // 任一地址族在操作系统中不可用时，应降级到另一回环地址继续授权。
    await completeWithUnavailableListener(2, '127.0.0.1', 'ipv6-unavailable-code');
    if (ipv6Available) {
        await completeWithUnavailableListener(1, '::1', 'ipv4-unavailable-code');
    }

    // 上一次授权的迟到异步错误不能破坏已经开始的下一次授权。
    let rejectOldReady;
    let oldCallbackRequest;
    const oldReady = new Promise((_, reject) => { rejectOldReady = reject; });
    const oldFlow = oauthCallback.startCallbackServer(10_000, () => {
        oldCallbackRequest = sendCallback('127.0.0.1', 'old-flow-code');
        return oldReady;
    });
    assert.strictEqual(await oldFlow, 'old-flow-code');
    await oldCallbackRequest;

    let markNewReady;
    const newReady = new Promise(resolve => { markNewReady = resolve; });
    const newFlow = oauthCallback.startCallbackServer(10_000, markNewReady);
    await newReady;
    rejectOldReady(new Error('late-old-ready-error'));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.strictEqual(oauthCallback.isServerRunning(), true);
    const newCallbackRequest = sendCallback('127.0.0.1', 'new-flow-code');
    assert.strictEqual(await newFlow, 'new-flow-code');
    await newCallbackRequest;

    // 任一回环地址被其他进程占用时必须安全失败，不能打开浏览器。
    const blocker = await listen('127.0.0.1');
    let openedBrowser = false;
    const blocked = oauthCallback.startCallbackServer(10_000, () => { openedBrowser = true; });
    await expectRejected(blocked, /已被占用/);
    assert.strictEqual(openedBrowser, false);
    assert.strictEqual(oauthCallback.isServerRunning(), false);
    await close(blocker);
    await assertLoopbackPortsAvailable(ipv6Available);

    // IPv6 被单独占用时也必须整体失败，并释放已监听的 IPv4 地址。
    if (ipv6Available) {
        const ipv6Blocker = await listen('::1');
        openedBrowser = false;
        const ipv6Blocked = oauthCallback.startCallbackServer(10_000, () => { openedBrowser = true; });
        await expectRejected(ipv6Blocked, /已被占用/);
        assert.strictEqual(openedBrowser, false);
        assert.strictEqual(oauthCallback.isServerRunning(), false);
        await close(ipv6Blocker);
        await assertLoopbackPortsAvailable(ipv6Available);
    }

    // 打开浏览器失败和授权超时都必须释放两个监听。
    const openFailed = oauthCallback.startCallbackServer(10_000, () => {
        throw new Error('browser-open-failed');
    });
    await expectRejected(openFailed, /browser-open-failed/);
    await assertLoopbackPortsAvailable(ipv6Available);

    const timedOut = oauthCallback.startCallbackServer(50);
    await expectRejected(timedOut, /授权超时/);
    await assertLoopbackPortsAvailable(ipv6Available);

    console.log('oauth callback regression tests passed');
})().catch(error => {
    oauthCallback.stopCallbackServer();
    console.error(error);
    process.exitCode = 1;
});
