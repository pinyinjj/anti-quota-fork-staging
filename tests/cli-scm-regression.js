const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../out/cli/cli');

const installation = {
    schemaVersion: 1,
    serviceName: 'AntiQuota-test',
    userSid: 'S-1-5-21-1-2-3-1001',
    version: '1.1.1',
    enabled: true,
    installRoot: 'C:\\Program Files\\Anti Quota\\test',
};
const stopped = { running: false, version: null, pid: null, switchProtocol: null };
const running = { running: true, version: '1.1.1', pid: 321, switchProtocol: 'authoritative-keyring-v1' };

function managementDependencies(events, overrides = {}) {
    return {
        assertMutationAllowed: () => { events.push('lock-check'); },
        assertInstallationSafe: () => { events.push('safe-check'); },
        getCurrentVersion: () => '1.1.1',
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        getServiceInfo: async () => { events.push('probe'); return running; },
        getManagedInstallation: () => installation,
        getManagedStatus: () => 'Running',
        stopRunningService: async pid => { events.push(`stop-agent:${pid}`); return true; },
        stopManagedHost: () => { events.push('stop-scm'); },
        ensureRunning: async () => { events.push('start'); },
        install: () => { events.push('install-scm'); return installation.serviceName; },
        uninstall: () => { events.push('uninstall-scm'); },
        run: async () => { events.push('run'); },
        logPath: () => 'test-service.log',
        writeLine: line => { events.push(`output:${line}`); },
        ...overrides,
    };
}

function updateDependencies(events, overrides = {}) {
    const check = { currentVersion: '1.1.1', latestVersion: '1.2.0', updateAvailable: true };
    return {
        checkForUpdate: async () => check,
        installLatestUpdate: async () => { events.push('install-cli'); return { ...check, installed: true }; },
        assertUpdatableInstallation: () => undefined,
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        withUpdateLock: async action => action({ stateDirectory: 'test-state' }),
        getServiceInfoForUpdate: async () => stopped,
        stopRunningService: async () => { throw new Error('不存在用户代理时不可发送 IPC stop'); },
        ensureRunning: async () => { events.push('start-agent'); },
        getServiceInfo: async () => ({ ...running, version: check.latestVersion }),
        getManagedInstallation: () => installation,
        stopManagedHost: () => { events.push('stop-scm'); },
        autostartExists: () => false,
        assertInstallationSafe: () => undefined,
        disableAutostart: () => { events.push('disable-scm'); },
        reinstallAutostart: () => { events.push('install-protected-runtime'); },
        writeLine: () => undefined,
        ...overrides,
    };
}

(async () => {
    const starts = [];
    cli.startServiceForCurrentInstallation({}, {
        getManagedInstallation: () => installation,
        startManagedAgent: capability => { starts.push(['scm', capability]); },
        startDetached: () => { throw new Error('已安装 SCM 时不得旁路生成 detached 代理'); },
    });
    assert.deepStrictEqual(starts, [['scm', undefined]]);
    cli.startServiceForCurrentInstallation({}, {
        getManagedInstallation: () => null,
        startManagedAgent: () => { throw new Error('未注册 SCM 时不能发送服务控制'); },
        startDetached: () => { starts.push(['detached']); },
    });
    assert.deepStrictEqual(starts, [['scm', undefined], ['detached']]);

    const blockedStartEvents = [];
    await assert.rejects(cli.ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.2.0',
        assertManagedVersionCompatible: () => { throw new Error('Windows 服务版本不一致'); },
        getServiceInfo: async () => { blockedStartEvents.push('probe'); return running; },
        startService: () => { blockedStartEvents.push('spawn'); },
    }), /Windows 服务版本不一致/);
    assert.deepStrictEqual(blockedStartEvents, [], '受保护运行时版本错误必须在停止/派生前拒绝');

    const stopEvents = [];
    await cli.runServiceManagementCommand(['stop'], managementDependencies(stopEvents));
    assert.deepStrictEqual(stopEvents.slice(0, 4), ['lock-check', 'probe', 'stop-agent:321', 'stop-scm']);

    const stoppedHostEvents = [];
    await cli.runServiceManagementCommand(['stop'], managementDependencies(stoppedHostEvents, {
        getServiceInfo: async () => stopped,
    }));
    assert(stoppedHostEvents.includes('stop-scm'), '无用户代理时仍必须停止 SCM host');

    const racedStopEvents = [];
    await assert.rejects(cli.runServiceManagementCommand(['stop'], managementDependencies(racedStopEvents, {
        stopRunningService: async () => false,
    })), /实例已变化/);
    assert(!racedStopEvents.includes('stop-scm'), 'PID 变化后不得停止接管的新 SCM host');

    const installEvents = [];
    await cli.runServiceManagementCommand(['install'], managementDependencies(installEvents));
    assert.deepStrictEqual(installEvents.slice(0, 6), [
        'lock-check', 'safe-check', 'probe', 'stop-agent:321', 'install-scm', 'start',
    ]);
    const unsafeEvents = [];
    await assert.rejects(cli.runServiceManagementCommand(['install'], managementDependencies(unsafeEvents, {
        assertInstallationSafe: () => { throw new Error('未完成恢复'); },
    })), /未完成恢复/);
    assert.deepStrictEqual(unsafeEvents, ['lock-check']);

    const newerAgentEvents = [];
    await assert.rejects(cli.runServiceManagementCommand(['install'], managementDependencies(newerAgentEvents, {
        getServiceInfo: async () => ({ ...running, version: '1.2.0' }),
    })), /高于当前 CLI/);
    assert(!newerAgentEvents.some(event => event.startsWith('stop-agent')));
    assert(!newerAgentEvents.includes('install-scm'));

    const uninstallEvents = [];
    await cli.runServiceManagementCommand(['uninstall'], managementDependencies(uninstallEvents));
    assert.deepStrictEqual(uninstallEvents.slice(0, 4), [
        'lock-check', 'probe', 'stop-agent:321', 'uninstall-scm',
    ]);
    assert(uninstallEvents.some(event => event.includes('凭证已保留')));

    const statusEvents = [];
    await cli.runServiceManagementCommand(['status'], managementDependencies(statusEvents));
    assert(statusEvents.some(event => event.includes('Windows 服务: AntiQuota-test (Running)')));
    assert(statusEvents.some(event => event.includes('用户代理正在运行')));
    assert(!statusEvents.includes('lock-check'), 'status 是只读操作，不应受到更新锁阻断');

    const dormantUpdateEvents = [];
    await cli.runUpdateCommand([], updateDependencies(dormantUpdateEvents));
    assert.deepStrictEqual(dormantUpdateEvents, ['stop-scm', 'install-cli', 'install-protected-runtime'],
        '即使用户代理未运行，也必须先停止 SCM 并在 npm 成功后升级受保护副本');

    const activeUpdateEvents = [];
    await cli.runUpdateCommand([], updateDependencies(activeUpdateEvents, {
        getServiceInfoForUpdate: async () => running,
        stopRunningService: async (_options, pid) => { activeUpdateEvents.push(`stop-agent:${pid}`); return true; },
    }));
    assert.deepStrictEqual(activeUpdateEvents, [
        'stop-agent:321', 'stop-scm', 'install-cli', 'install-protected-runtime', 'start-agent',
    ]);

    const newerHostEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(newerHostEvents, {
        getManagedInstallation: () => ({ ...installation, version: '1.3.0' }),
    })), /高于待安装版本/);
    assert.deepStrictEqual(newerHostEvents, [], '停止的较新 SCM 运行时也不可被旧 CLI 降级');

    const hostFailureEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(hostFailureEvents, {
        stopManagedHost: () => { hostFailureEvents.push('stop-failed'); throw new Error('SCM drain 超时'); },
    })), /SCM drain 超时/);
    assert.deepStrictEqual(hostFailureEvents, ['stop-failed'], 'host 未确认停止时不可更新或恢复');

    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-scm-capability-'));
    try {
        const token = '0123456789abcdef0123456789abcdef';
        fs.writeFileSync(path.join(stateDirectory, 'update.lock'), JSON.stringify({ pid: process.pid, token }));
        const markerFile = path.join(stateDirectory, 'scm-update-restore.json');
        const capability = cli.createUpdateRestoreCapability({ stateDirectory });
        const marker = { capability, serviceName: installation.serviceName, version: installation.version };
        const guard = {
            restoreCapability: '',
            parentPid: process.pid + 1,
            stateDirectory,
            assertInstallationSafe: () => undefined,
            assertNoUpdate: () => { throw new Error('已有更新正在进行'); },
            getManagedHostEnvironment: () => ({ installation, stopFile: 'test-stop', hostPid: process.pid + 1 }),
            scmRestoreFile: markerFile,
            isProcessAlive: () => true,
        };
        fs.writeFileSync(markerFile, JSON.stringify(marker));
        assert.doesNotThrow(() => cli.assertServiceRunAllowed(guard));
        assert.strictEqual(fs.existsSync(markerFile), false, '合法 SCM 恢复能力必须一次性消费');
        assert.throws(() => cli.assertServiceRunAllowed(guard), /更新正在进行/,
            '消费后再次启动不能继续绕过活动更新锁');

        fs.writeFileSync(markerFile, JSON.stringify(marker));
        assert.throws(() => cli.assertServiceRunAllowed({
            ...guard, getManagedHostEnvironment: () => null,
        }), /更新正在进行/, '普通进程不能通过伪造 marker 绕过更新锁');
        assert(fs.existsSync(markerFile));

        assert.throws(() => cli.assertServiceRunAllowed({ ...guard, isProcessAlive: () => false }), /事务已退出/);
        assert(fs.existsSync(markerFile), '失效能力不得被当作合法能力消费');

        fs.writeFileSync(markerFile, JSON.stringify({ ...marker, version: '9.9.9' }));
        assert.throws(() => cli.assertServiceRunAllowed(guard), /安装不匹配/);
        fs.writeFileSync(markerFile, '{broken-json');
        assert.throws(() => cli.assertServiceRunAllowed(guard), /恢复凭证无效/);
        fs.writeFileSync(markerFile, JSON.stringify({ ...marker, capability: 'null' }));
        assert.throws(() => cli.assertServiceRunAllowed(guard), /凭证无效或已经释放/);

        fs.writeFileSync(markerFile, JSON.stringify({
            ...marker,
            capability: JSON.stringify({ stateDirectory, pid: process.pid, token: 'f'.repeat(32) }),
        }));
        assert.throws(() => cli.assertServiceRunAllowed(guard), /凭证无效或已经释放/);
    } finally {
        fs.rmSync(stateDirectory, { recursive: true, force: true });
    }
    console.log('CLI Windows SCM integration regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
