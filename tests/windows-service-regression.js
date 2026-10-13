'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const service = require('../out/cli/service');
const windows = require('../out/cli/windowsService');
const cli = require('../out/cli/cli');

if (process.argv.includes('--oauth-child')) {
    require('../out/services/accountService').startOAuthFlow = (_open, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('binding-cancelled')), { once: true });
        process.send('binding');
    });
    service.runService().then(() => process.send('ready')).catch(() => { process.exitCode = 1; });
} else {
    void main().catch(error => { console.error(error); process.exitCode = 1; });
}

function nextMessage(child, expected) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Child did not report ${expected}`)), 10000);
        const receive = value => { if (value === expected) finish(); };
        const exited = code => finish(new Error(`Child exited early: ${code}`));
        const finish = error => {
            clearTimeout(timer);
            child.off('message', receive);
            child.off('exit', exited);
            error ? reject(error) : resolve();
        };
        child.on('message', receive);
        child.once('exit', exited);
    });
}

function request(endpoint, token, command) {
    return new Promise((resolve, reject) => {
        let response = '';
        const socket = net.createConnection(endpoint);
        socket.setEncoding('utf8');
        socket.setTimeout(10000, () => socket.destroy(new Error('Request timeout')));
        socket.once('connect', () => socket.end(`${JSON.stringify({ token, command })}\n`));
        socket.on('data', chunk => { response += chunk; });
        socket.once('error', reject);
        socket.once('end', () => {
            try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
        });
    });
}

async function main() {
    const identity = windows.windowsServiceIdentity('S-1-5-21-1-2-3-1001', 'C:\\Program Files');
    assert.match(identity.serviceName, /^AntiQuota-[a-f0-9]{12}$/);
    assert.strictEqual(identity.serviceName, windows.windowsServiceIdentity('S-1-5-21-1-2-3-1001', 'D:\\Programs').serviceName);
    assert.notStrictEqual(identity.serviceName, windows.windowsServiceIdentity('S-1-5-21-1-2-3-1002', 'C:\\Program Files').serviceName);
    assert.throws(() => windows.windowsServiceIdentity('S-1-5-18', 'C:\\Program Files'), /SID/);

    let shutdowns = 0;
    const coordinator = new service.ServiceShutdownCoordinator(() => { shutdowns++; });
    const cancellation = new AbortController();
    coordinator.register(cancellation);
    coordinator.begin('user');
    coordinator.begin('host');
    assert.strictEqual(cancellation.signal.aborted, true);
    assert.strictEqual(coordinator.getReason(), 'user', 'logoff must not overwrite manual pause');
    assert.strictEqual(shutdowns, 1);
    const hostFirst = new service.ServiceShutdownCoordinator(() => undefined);
    hostFirst.begin('host');
    hostFirst.begin('user');
    assert.strictEqual(hostFirst.getReason(), 'host');

    for (const runtime of [
        { stopFileExists: () => true, hostIsAlive: () => true },
        { stopFileExists: () => false, hostIsAlive: () => false },
        { stopFileExists: () => { throw new Error('access denied'); }, hostIsAlive: () => true },
    ]) {
        let stopped = 0;
        const monitor = new service.ManagedAgentStopMonitor({ ...runtime, shutdown: () => { stopped++; } });
        monitor.poll();
        monitor.poll();
        assert.strictEqual(stopped, 1, 'host stop/death/uncertainty must drain exactly once');
    }
    let unexpectedStop = false;
    new service.ManagedAgentStopMonitor({ stopFileExists: () => false, hostIsAlive: () => true,
        shutdown: () => { unexpectedStop = true; } }).poll();
    assert.strictEqual(unexpectedStop, false);

    await assert.rejects(cli.runServiceCommand({
        withStartupGate: action => action(), assertAllowed: () => undefined,
        getServiceInfo: async () => ({ running: true }), isManagedAgent: () => true,
        runService: async () => { throw new Error('duplicate started'); },
    }), /旧用户代理尚未退出/);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-scm-drain-'));
    const username = `AQScm${process.pid}${Date.now()}`;
    const env = { ...process.env, USERNAME: username, HOME: home, USERPROFILE: home };
    for (const key of Object.keys(env)) if (key.startsWith('ANTI_QUOTA_SCM_')) delete env[key];
    delete env.ANTI_QUOTA_UPDATE_RESTORE_CAPABILITY;
    let child;
    try {
        const denied = spawnSync(process.execPath, [path.resolve(__dirname, '../out/cli/cli.js'), 'service', 'managed-agent'],
            { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.strictEqual(denied.status, 1);
        assert.match(denied.stderr, /只能由已安装的 Windows 服务启动/);
        child = spawn(process.execPath, [__filename, '--oauth-child'], {
            env, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        const exited = new Promise(resolve => child.once('exit', resolve));
        await nextMessage(child, 'ready');
        const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\anti-quota-${username}` : path.join(home, '.anti-quota', 'service.sock');
        const token = fs.readFileSync(path.join(home, '.anti-quota', 'service-token'), 'utf8').trim();
        const bindingStarted = nextMessage(child, 'binding');
        const bindingResult = request(endpoint, token, 'bind');
        await bindingStarted;
        const stopResult = await request(endpoint, token, 'stop');
        assert.strictEqual(stopResult.data.stopping, true);
        assert.match((await bindingResult).error, /binding-cancelled/);
        // IPC's own handle must not keep this test process alive after drain.
        child.disconnect();
        const timeout = setTimeout(() => child.kill(), 10000);
        assert.strictEqual(await exited, 0, 'manual stop must exit 0 after pending OAuth cancels');
        clearTimeout(timeout);
    } finally {
        if (child && child.exitCode === null) child.kill();
        fs.rmSync(home, { recursive: true, force: true });
    }
    console.log('Windows service lifecycle regression tests passed.');
}
