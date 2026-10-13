const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cli = require('../out/cli/cli');
const service = require('../out/cli/service');
const { UNSAFE_INSTALL_MARKER_FILE, UpdateInstallError } = require('../out/cli/update');
const SWITCH_PROTOCOL = 'authoritative-keyring-v1';

const ensureRunning = (options, overrides) => cli.ensureRunning(options, {
    assertManagedVersionCompatible: () => undefined,
    ...overrides,
});

function serviceInfo(version, pid = 123) {
    return { running: true, version, pid, switchProtocol: SWITCH_PROTOCOL };
}

function release(version) {
    return {
        version,
        tagName: `v${version}`,
        tgz: { name: `anti-quota-${version}.tgz`, url: 'https://github.com/example.tgz', size: 1 },
        checksum: { name: `anti-quota-${version}.tgz.sha256`, url: 'https://github.com/example.sha256', size: 1 },
    };
}

function checkResult(currentVersion, latestVersion, updateAvailable) {
    return {
        currentVersion,
        latestVersion,
        updateAvailable,
        release: release(latestVersion),
    };
}

function updateDependencies(check, events, output, overrides = {}) {
    return {
        checkForUpdate: async () => { events.push('check'); return check; },
        installLatestUpdate: async (_runtime, options) => {
            events.push(`install:${!!options.force}`);
            return { ...check, installed: true };
        },
        assertUpdatableInstallation: () => { events.push('assert-installable'); },
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        withUpdateLock: async action => {
            events.push('lock:start');
            try {
                await action({ stateDirectory: 'test-state' });
            } finally {
                events.push('lock:end');
            }
        },
        getServiceInfoForUpdate: async () => {
            events.push('is-running');
            return serviceInfo(check.currentVersion);
        },
        stopRunningService: async options => { events.push(`stop:${!!options?.updateLock}`); },
        ensureRunning: async options => { events.push(`start:${!!options?.updateLock}`); },
        getServiceInfo: async () => {
            events.push('service-info');
            return serviceInfo(check.latestVersion);
        },
        getManagedInstallation: () => null,
        stopManagedHost: () => { throw new Error('非 SCM 测试不能停止真实服务'); },
        autostartExists: () => { events.push('autostart-state'); return true; },
        assertInstallationSafe: () => undefined,
        disableAutostart: () => { events.push('disable-autostart'); },
        reinstallAutostart: () => { events.push('restore-autostart'); },
        writeLine: value => output.push(value),
        ...overrides,
    };
}

(async () => {
    const versionOutput = [];
    await cli.runVersionCommand(['--json'], {
        getCurrentVersion: () => '1.1.0',
        getServiceInfo: async () => serviceInfo('1.0.3'),
        writeLine: value => versionOutput.push(value),
    });
    assert.deepStrictEqual(JSON.parse(versionOutput[0]), {
        cliVersion: '1.1.0',
        serviceRunning: true,
        serviceVersion: '1.0.3',
        serviceSwitchProtocol: SWITCH_PROTOCOL,
        versionMismatch: true,
        protocolCompatible: true,
    });

    const stoppedVersionOutput = [];
    await cli.runVersionCommand([], {
        getCurrentVersion: () => '1.1.0',
        getServiceInfo: async () => ({ running: false, version: null, pid: null, switchProtocol: null }),
        writeLine: value => stoppedVersionOutput.push(value),
    });
    assert(stoppedVersionOutput.includes('后台服务: 未运行'));
    await assert.rejects(cli.runVersionCommand(['--bad'], {
        getCurrentVersion: () => '1.1.0',
    }), /未知参数/);

    const loadedPackage = require('../package.json');
    const originalLoadedVersion = loadedPackage.version;
    const startupServiceVersion = service.getServicePingInfo().version;
    assert.strictEqual(service.getServicePingInfo().switchProtocol, SWITCH_PROTOCOL);
    try {
        loadedPackage.version = '99.99.99';
        assert.strictEqual(
            service.getServicePingInfo().version,
            startupServiceVersion,
            '服务必须报告进程启动时捕获的版本，不能在 npm 覆盖磁盘后伪装成新版本'
        );
    } finally {
        loadedPackage.version = originalLoadedVersion;
    }

    const staleServiceEvents = [];
    let staleServiceProbe = 0;
    await ensureRunning({}, {
        assertMutationAllowed: () => { staleServiceEvents.push('assert-mutation'); },
        assertInstallationSafe: () => { staleServiceEvents.push('assert-installation'); },
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => {
            staleServiceProbe += 1;
            staleServiceEvents.push(`probe:${staleServiceProbe}`);
            return staleServiceProbe === 1
                ? serviceInfo('1.1.0', 100)
                : serviceInfo('1.1.1', 200);
        },
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async () => { staleServiceEvents.push('stop-old'); },
        startService: () => { staleServiceEvents.push('start-current'); },
        delay: async () => { staleServiceEvents.push('wait'); },
    });
    assert.deepStrictEqual(staleServiceEvents, [
        'assert-mutation',
        'assert-installation',
        'probe:1',
        'stop-old',
        'start-current',
        'wait',
        'probe:2',
    ], '版本不一致的后台服务必须先停止，再从当前 CLI 启动并核验版本');

    const compatibleServiceEvents = [];
    await ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => serviceInfo('v1.1.1', 200),
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async () => { compatibleServiceEvents.push('stop'); },
        startService: () => { compatibleServiceEvents.push('start'); },
        delay: async () => undefined,
    });
    assert.deepStrictEqual(compatibleServiceEvents, [], '版本一致时应复用现有服务');
    assert.strictEqual(cli.isServiceSwitchProtocolCompatible(SWITCH_PROTOCOL), true);
    assert.strictEqual(cli.isServiceSwitchProtocolCompatible('authoritative-keyring-v2'), true);
    assert.strictEqual(cli.isServiceSwitchProtocolCompatible('legacy-switch-v1'), false);
    assert.strictEqual(cli.isServiceSwitchProtocolCompatible(null), false);
    assert.strictEqual(
        cli.isServiceVersionCompatible(
            { ...serviceInfo('1.1.1'), switchProtocol: 'authoritative-keyring-v2' },
            '1.1.1'
        ),
        true,
        '更新中的旧 CLI 进程必须接受同系列更高协议的新服务'
    );

    const legacyServiceEvents = [];
    let legacyServiceProbe = 0;
    await ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => {
            legacyServiceProbe += 1;
            return legacyServiceProbe === 1
                ? { running: true, version: '1.1.1', pid: 100, switchProtocol: null }
                : serviceInfo('1.1.1', 200);
        },
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async () => { legacyServiceEvents.push('stop'); },
        startService: () => { legacyServiceEvents.push('start'); },
        delay: async () => undefined,
    });
    assert.deepStrictEqual(
        legacyServiceEvents,
        ['stop', 'start'],
        '同版本但缺少权威 Keyring 切换协议的旧服务也必须被替换'
    );

    const newerServiceEvents = [];
    await assert.rejects(ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => serviceInfo('1.1.2', 300),
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async () => { newerServiceEvents.push('stop'); },
        startService: () => { newerServiceEvents.push('start'); },
        delay: async () => undefined,
    }), /高于当前 CLI 1\.1\.1/);
    assert.deepStrictEqual(
        newerServiceEvents,
        [],
        '旧 CLI 不得停止或降级更高版本的后台服务'
    );

    const missingPidEvents = [];
    await assert.rejects(ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => ({
            running: true,
            version: '1.1.0',
            pid: null,
            switchProtocol: null,
        }),
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async () => { missingPidEvents.push('stop'); },
        startService: () => { missingPidEvents.push('start'); },
        delay: async () => undefined,
    }), /未报告可信 PID/);
    assert.deepStrictEqual(missingPidEvents, [], '无可信 PID 时不得降级为无约束 stop');

    const newerStartupRaceEvents = [];
    let newerStartupRaceProbe = 0;
    await assert.rejects(ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => {
            newerStartupRaceProbe += 1;
            return newerStartupRaceProbe === 1
                ? serviceInfo('1.1.0', 100)
                : serviceInfo('1.1.2', 300);
        },
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async (_options, expected) => {
            newerStartupRaceEvents.push(`stop:${expected.pid}`);
            return true;
        },
        startService: () => { newerStartupRaceEvents.push('start'); },
        delay: async () => { newerStartupRaceEvents.push('wait'); },
    }), /高于当前 CLI 1\.1\.1/);
    assert.deepStrictEqual(
        newerStartupRaceEvents,
        ['stop:100', 'start', 'wait'],
        '启动竞争中出现更高版本服务时不得再次停止该服务'
    );

    const replacedServiceEvents = [];
    let replacedServiceProbe = 0;
    await ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => {
            replacedServiceProbe += 1;
            replacedServiceEvents.push(`probe:${replacedServiceProbe}`);
            return replacedServiceProbe === 1
                ? serviceInfo('1.1.0', 100)
                : serviceInfo('1.1.1', 200);
        },
        compareVersions: (left, right) => left === right ? 0 : left < right ? -1 : 1,
        stopService: async (_options, expected) => {
            replacedServiceEvents.push(`stop:${expected.pid}`);
            return false;
        },
        startService: () => { replacedServiceEvents.push('start'); },
        delay: async () => { replacedServiceEvents.push('wait'); },
    });
    assert.deepStrictEqual(
        replacedServiceEvents,
        ['probe:1', 'stop:100', 'wait', 'probe:2'],
        '目标 PID 已变化时必须重新探测，不能停止或重复启动接管端点的新服务'
    );

    const unknownVersionEvents = [];
    await assert.rejects(ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async () => ({
            running: true,
            version: null,
            pid: 321,
            switchProtocol: null,
        }),
        stopService: async () => { unknownVersionEvents.push('stop'); },
        startService: () => { unknownVersionEvents.push('start'); },
    }), /未报告可信版本/);
    assert.deepStrictEqual(unknownVersionEvents, [], '未知版本的服务不得被自动停止或替换');

    let startupClock = 0;
    const startupProbeBudgets = [];
    let startupProbeCount = 0;
    await assert.rejects(ensureRunning({}, {
        assertMutationAllowed: () => undefined,
        assertInstallationSafe: () => undefined,
        getExpectedVersion: () => '1.1.1',
        getServiceInfo: async timeoutMs => {
            startupProbeCount += 1;
            if (startupProbeCount === 1) {
                return { running: false, version: null, pid: null, switchProtocol: null };
            }
            startupProbeBudgets.push(timeoutMs);
            startupClock += timeoutMs;
            return { running: false, version: null, pid: null, switchProtocol: null };
        },
        startService: () => undefined,
        delay: async milliseconds => { startupClock += milliseconds; },
        now: () => startupClock,
        startupTimeoutMs: 500,
    }), /无法启动/);
    assert(startupClock <= 500, `启动等待不得超出绝对 deadline，实际 ${startupClock}ms`);
    assert(startupProbeBudgets.every(timeout => timeout <= 250), '单次启动 ping 必须使用短预算');

    assert.strictEqual(service.shouldStopServiceInstance(undefined, 123), true);
    assert.strictEqual(service.shouldStopServiceInstance(123, 123), true);
    assert.strictEqual(service.shouldStopServiceInstance(122, 123), false);
    assert.throws(() => service.shouldStopServiceInstance('123', 123), /无效的目标 PID/);
    assert.strictEqual(
        service.getEndpoint({
            platform: 'win32',
            env: { USERNAME: 'Test User' },
            homedir: () => { throw new Error('homedir must not be read'); },
        }),
        '\\\\.\\pipe\\anti-quota-Test-User',
        'Windows 服务端点不得依赖可能抛出 ENOMEM 的 os.userInfo()'
    );
    assert.strictEqual(
        service.getEndpoint({
            platform: 'win32',
            env: {},
            homedir: () => { throw new Error('simulated homedir failure'); },
        }),
        '\\\\.\\pipe\\anti-quota-user',
        'Windows 用户信息全部不可用时仍必须生成稳定端点且不能抛错'
    );

    let guardedStopRequestedPid = null;
    const guardedStopResult = await cli.stopRunningService({}, {
        probe: async () => true,
        getServiceInfo: async () => { throw new Error('实例变化响应后不应继续轮询'); },
        requestStop: async expectedPid => {
            guardedStopRequestedPid = expectedPid;
            return { stopping: false, reason: 'service-instance-changed' };
        },
        delay: async () => undefined,
    }, 321);
    assert.strictEqual(guardedStopResult, false);
    assert.strictEqual(guardedStopRequestedPid, 321, '自动替换停止请求必须绑定初次探测到的 PID');

    assert.throws(() => cli.assertServiceMutationAllowed({}, () => {
        throw new Error('已有 Anti Quota 更新正在进行，请稍后重试');
    }), /更新正在进行/);
    let bypassAssertionCalled = false;
    cli.assertServiceMutationAllowed({ updateLock: {} }, () => { bypassAssertionCalled = true; });
    assert.strictEqual(bypassAssertionCalled, false, '更新事务内部必须能显式绕过普通命令锁检查');

    const lockedRunEvents = [];
    await assert.rejects(cli.runServiceCommand({
        withStartupGate: async action => {
            lockedRunEvents.push('gate:start');
            try { await action(); } finally { lockedRunEvents.push('gate:end'); }
        },
        assertAllowed: () => {
            lockedRunEvents.push('lock-check');
            throw new Error('已有 Anti Quota 更新正在进行，请稍后重试');
        },
        getServiceInfo: async () => {
            lockedRunEvents.push('service-probe');
            return { running: false, version: null, pid: null, switchProtocol: null };
        },
        runService: async () => { lockedRunEvents.push('service-run'); },
    }), /更新正在进行/);
    assert.deepStrictEqual(
        lockedRunEvents,
        ['gate:start', 'lock-check', 'gate:end'],
        'service run 必须在门禁内、探测或载入服务前拒绝活动更新锁'
    );

    const serviceRunEvents = [];
    await cli.runServiceCommand({
        withStartupGate: async action => {
            serviceRunEvents.push('gate:start');
            try { await action(); } finally { serviceRunEvents.push('gate:end'); }
        },
        assertAllowed: () => { serviceRunEvents.push('lock-check'); },
        getServiceInfo: async () => {
            serviceRunEvents.push('service-probe');
            return { running: false, version: null, pid: null, switchProtocol: null };
        },
        runService: async () => { serviceRunEvents.push('service-run'); },
    });
    assert.deepStrictEqual(serviceRunEvents, [
        'gate:start', 'lock-check', 'service-probe', 'service-run', 'gate:end',
    ]);

    const rejectedServiceRunEvents = [];
    await assert.rejects(cli.runServiceCommand({
        withStartupGate: async action => action(),
        assertAllowed: () => undefined,
        getServiceInfo: async () => {
            rejectedServiceRunEvents.push('probe');
            throw new Error('服务端点状态无法安全确认');
        },
        runService: async () => { rejectedServiceRunEvents.push('run'); },
    }), /端点状态无法安全确认/);
    assert.deepStrictEqual(rejectedServiceRunEvents, ['probe'],
        '严格探测失败时 service run 不得创建新实例');

    const restoreStateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-service-run-'));
    try {
        const token = '0123456789abcdef0123456789abcdef';
        fs.writeFileSync(path.join(restoreStateDirectory, 'update.lock'), JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
            token,
        }));
        const capability = cli.createUpdateRestoreCapability({ stateDirectory: restoreStateDirectory });
        assert.doesNotThrow(() => cli.assertServiceRunAllowed({
            restoreCapability: capability,
            parentPid: process.pid,
            stateDirectory: restoreStateDirectory,
        }), '更新事务直接派生的服务恢复进程必须能在锁内启动');
        assert.throws(() => cli.assertServiceRunAllowed({
            restoreCapability: capability,
            parentPid: process.pid + 1,
            stateDirectory: restoreStateDirectory,
        }), /恢复凭证无效/);
        fs.writeFileSync(path.join(restoreStateDirectory, UNSAFE_INSTALL_MARKER_FILE), '{}');
        assert.throws(() => cli.assertServiceRunAllowed({
            restoreCapability: capability,
            parentPid: process.pid,
            stateDirectory: restoreStateDirectory,
        }), /未完成恢复/, '持久不安全标记必须优先阻止事务恢复能力启动服务');
    } finally {
        fs.rmSync(restoreStateDirectory, { recursive: true, force: true });
    }

    const lockedCommandHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-service-command-'));
    try {
        const lockedCommandState = path.join(lockedCommandHome, '.anti-quota');
        fs.mkdirSync(lockedCommandState);
        fs.writeFileSync(path.join(lockedCommandState, 'update.lock'), JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
            token: 'fedcba9876543210fedcba9876543210',
        }));
        const commandEnvironment = {
            ...process.env,
            HOME: lockedCommandHome,
            USERPROFILE: lockedCommandHome,
        };
        delete commandEnvironment.ANTI_QUOTA_UPDATE_RESTORE_CAPABILITY;
        const lockedCommand = spawnSync(process.execPath, [
            path.join(__dirname, '..', 'out', 'cli', 'cli.js'),
            'service',
            'run',
        ], {
            encoding: 'utf8',
            env: commandEnvironment,
            timeout: 5000,
        });
        assert.strictEqual(lockedCommand.status, 1, lockedCommand.stderr || lockedCommand.error);
        assert.match(lockedCommand.stderr, /更新正在进行/);
        assert.strictEqual(lockedCommand.error, undefined, 'service run 应立即拒绝锁，不能进入常驻服务');

        fs.unlinkSync(path.join(lockedCommandState, 'update.lock'));
        fs.writeFileSync(path.join(lockedCommandState, UNSAFE_INSTALL_MARKER_FILE), '{}');
        for (const action of ['run', 'start', 'install']) {
            const unsafeCommand = spawnSync(process.execPath, [
                path.join(__dirname, '..', 'out', 'cli', 'cli.js'),
                'service',
                action,
            ], {
                encoding: 'utf8',
                env: commandEnvironment,
                timeout: 5000,
            });
            assert.strictEqual(unsafeCommand.status, 1, unsafeCommand.stderr || unsafeCommand.error);
            assert.match(unsafeCommand.stderr, /未完成恢复/);
            assert.strictEqual(unsafeCommand.error, undefined, `service ${action} 不得绕过持久阻断标记`);
        }
    } finally {
        fs.rmSync(lockedCommandHome, { recursive: true, force: true });
    }

    await assert.rejects(cli.probeRunningServiceForUpdate({
        ping: async () => { throw new Error('本地服务认证失败'); },
        endpointConnects: async () => true,
        getLiveServicePid: () => null,
    }), /旧服务仍在运行或 service-token 不一致/);
    assert.strictEqual(await cli.probeRunningServiceForUpdate({
        ping: async () => { throw new Error('ENOENT'); },
        endpointConnects: async () => false,
        getLiveServicePid: () => null,
    }), false);
    await assert.rejects(cli.probeRunningServiceForUpdate({
        ping: async () => { throw new Error('ENOENT'); },
        endpointConnects: async () => false,
        getLiveServicePid: () => 7440,
    }), /PID 7440 仍在运行/);

    const pidProbeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-pid-probe-'));
    const pidProbeFile = path.join(pidProbeDirectory, 'service.pid');
    try {
        assert.strictEqual(cli.getLiveServicePid(pidProbeFile, () => true), null);
        fs.writeFileSync(pidProbeFile, 'not-a-pid', 'utf8');
        assert.throws(() => cli.getLiveServicePid(pidProbeFile, () => true), /PID 文件损坏/);
        fs.writeFileSync(pidProbeFile, '4242', 'utf8');
        assert.strictEqual(cli.getLiveServicePid(pidProbeFile, () => false), null);
        assert.strictEqual(cli.getLiveServicePid(pidProbeFile, () => true), 4242);
    } finally {
        fs.rmSync(pidProbeDirectory, { recursive: true, force: true });
    }

    let strictInfoClock = 0;
    const strictStopped = await cli.getRunningServiceInfoStrict(500, {
        requestInfo: async timeoutMs => {
            assert(timeoutMs <= 250);
            strictInfoClock += 10;
            throw new Error('ENOENT');
        },
        endpointConnects: async timeoutMs => {
            assert(timeoutMs <= 250);
            strictInfoClock += 10;
            return false;
        },
        getLiveServicePid: () => null,
        now: () => strictInfoClock,
    });
    assert.strictEqual(strictStopped.running, false);
    await assert.rejects(cli.getRunningServiceInfoStrict(500, {
        requestInfo: async () => { throw new Error('认证失败'); },
        endpointConnects: async () => true,
    }), /端点仍被占用或状态无法安全确认/);

    let expectedPidProbeCount = 0;
    await assert.rejects(cli.stopRunningService({}, {
        probe: async () => {
            expectedPidProbeCount += 1;
            if (expectedPidProbeCount === 1) return true;
            throw new Error('端点仍可连接，ping 暂时失败');
        },
        getServiceInfo: async () => ({ running: false, version: null, pid: null, switchProtocol: null }),
        requestStop: async () => ({ stopping: true }),
        delay: async () => undefined,
    }, 321), /端点仍可连接/);
    assert.strictEqual(expectedPidProbeCount, 2, 'expected PID 停机不能把一次 ping 失败当成已退出');

    let stopClock = 0;
    await assert.rejects(cli.stopRunningService({}, {
        probe: async () => true,
        getServiceInfo: async () => serviceInfo('1.1.1', 321),
        requestStop: async () => ({ stopping: true }),
        delay: async milliseconds => { stopClock += milliseconds; },
        now: () => stopClock,
        stopTimeoutMs: 300,
    }, 321), /退出超时/);
    assert.strictEqual(stopClock, 300, '停机等待必须遵守绝对 deadline');

    let drainingPidAlive = true;
    let drainingPolls = 0;
    const drainedResult = await cli.stopRunningService({}, {
        probe: async () => {
            drainingPolls += 1;
            return drainingPolls === 1;
        },
        getServiceInfo: async () => ({ running: false, version: null, pid: null, switchProtocol: null }),
        requestStop: async () => ({ stopping: true }),
        delay: async () => { drainingPidAlive = false; },
        isProcessAlive: () => drainingPidAlive,
    }, 321);
    assert.strictEqual(drainedResult, true);
    assert.strictEqual(drainingPolls, 2, '端点消失后仍必须等待目标 PID 真正退出');

    let strictStopProbeCount = 0;
    let strictStopInstallCalled = false;
    const strictStopEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(
        checkResult('1.0.3', '1.1.0', true),
        strictStopEvents,
        [],
        {
            stopRunningService: (options, expectedPid) => cli.stopRunningService(options, {
                probe: async () => {
                    strictStopProbeCount += 1;
                    if (strictStopProbeCount === 1) return true;
                    return cli.probeRunningServiceForUpdate({
                        ping: async () => { throw new Error('Anti Quota 服务响应超时'); },
                        endpointConnects: async () => true,
                    });
                },
                requestStop: async () => undefined,
                delay: async () => undefined,
            }, expectedPid),
            installLatestUpdate: async () => {
                strictStopInstallCalled = true;
                throw new Error('端点仍连接时不得进入安装');
            },
        }
    )), /服务端点仍可连接/);
    assert.strictEqual(strictStopInstallCalled, false, '旧服务端点仍可连接时不得进入 npm 安装');

    const available = checkResult('1.0.3', '1.1.0', true);

    const newerUpdateEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, newerUpdateEvents, [], {
        getServiceInfoForUpdate: async () => {
            newerUpdateEvents.push('service:newer');
            return serviceInfo('1.1.2', 912);
        },
        stopRunningService: async () => { newerUpdateEvents.push('stop'); },
        installLatestUpdate: async () => {
            newerUpdateEvents.push('install');
            return { ...available, installed: true };
        },
    })), /高于待安装版本 1\.1\.0/);
    assert(!newerUpdateEvents.includes('stop') && !newerUpdateEvents.includes('install'),
        '旧 CLI 更新不得停止或降级更高版本服务');

    const missingUpdatePidEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, missingUpdatePidEvents, [], {
        getServiceInfoForUpdate: async () => ({
            running: true,
            version: '1.0.3',
            pid: null,
            switchProtocol: SWITCH_PROTOCOL,
        }),
        stopRunningService: async () => { missingUpdatePidEvents.push('stop'); },
        installLatestUpdate: async () => {
            missingUpdatePidEvents.push('install');
            return { ...available, installed: true };
        },
    })), /未报告可信 PID/);
    assert(!missingUpdatePidEvents.includes('stop') && !missingUpdatePidEvents.includes('install'),
        '更新预检缺少可信 PID 时必须在停止和安装前失败');

    let changedPidInstallCalled = false;
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, [], [], {
        getServiceInfoForUpdate: async () => serviceInfo('1.0.3', 100),
        stopRunningService: async (_options, expectedPid) => {
            assert.strictEqual(expectedPid, 100);
            return false;
        },
        installLatestUpdate: async () => {
            changedPidInstallCalled = true;
            return { ...available, installed: true };
        },
    })), /实例已变化/);
    assert.strictEqual(changedPidInstallCalled, false, '服务实例变化后不得继续安装');

    let newerThanCliStopped = false;
    let newerThanCliInstalled = false;
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, [], [], {
        getServiceInfoForUpdate: async () => serviceInfo('1.0.5', 777),
        stopRunningService: async () => {
            newerThanCliStopped = true;
        },
        installLatestUpdate: async () => {
            newerThanCliInstalled = true;
            return { ...available, installed: true };
        },
    })), /高于当前 CLI 1\.0\.3/);
    assert.strictEqual(newerThanCliStopped, false);
    assert.strictEqual(newerThanCliInstalled, false);

    let observedStopPid = null;
    let observedMinimumVersion = null;
    await cli.runUpdateCommand([], updateDependencies(available, [], [], {
        getServiceInfoForUpdate: async () => serviceInfo('1.0.3', 777),
        stopRunningService: async (_options, expectedPid) => {
            observedStopPid = expectedPid;
            return true;
        },
        installLatestUpdate: async (_runtime, options) => {
            observedMinimumVersion = options.minimumVersion;
            return { ...available, installed: true };
        },
    }));
    assert.strictEqual(observedStopPid, 777, '更新 stop 必须绑定预检到的 PID');
    assert.strictEqual(observedMinimumVersion, '1.0.3', '当前版本必须成为二次 Release 检查下限');

    const checkEvents = [];
    const checkOutput = [];
    await cli.runUpdateCommand(['--check'], updateDependencies(available, checkEvents, checkOutput, {
        installLatestUpdate: async () => { throw new Error('检查更新不应安装'); },
        assertUpdatableInstallation: () => { throw new Error('检查更新不应检查安装类型'); },
        getServiceInfoForUpdate: async () => { throw new Error('检查更新不应探测或启动服务'); },
    }));
    assert.deepStrictEqual(checkEvents, ['check']);
    assert(checkOutput[0].includes('1.0.3 -> 1.1.0'));

    const same = checkResult('1.1.0', '1.1.0', false);
    const forceEvents = [];
    const forceOutput = [];
    await cli.runUpdateCommand(['--force'], updateDependencies(same, forceEvents, forceOutput));
    assert.deepStrictEqual(forceEvents, [
        'lock:start',
        'check',
        'assert-installable',
        'is-running',
        'autostart-state',
        'stop:true',
        'install:true',
        'restore-autostart',
        'start:true',
        'service-info',
        'lock:end',
    ]);
    assert(forceOutput.some(value => value.includes('已重新安装')));
    assert(forceOutput.some(value => value.includes('VS Code 扩展未更新')));

    const failureEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, failureEvents, [], {
        installLatestUpdate: async () => {
            failureEvents.push('install-failed');
            throw new Error('模拟 npm 失败');
        },
        getServiceInfo: async () => {
            failureEvents.push('service-info');
            return serviceInfo(available.currentVersion);
        },
    })), /模拟 npm 失败/);
    assert.deepStrictEqual(failureEvents, [
        'lock:start',
        'check',
        'assert-installable',
        'is-running',
        'autostart-state',
        'stop:true',
        'install-failed',
        'restore-autostart',
        'start:true',
        'service-info',
        'lock:end',
    ]);

    const unsafeRollbackEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, unsafeRollbackEvents, [], {
        installLatestUpdate: async () => {
            unsafeRollbackEvents.push('install-and-rollback-failed');
            throw new UpdateInstallError(
                '模拟更新和回滚失败；可恢复备份已保留在 C:\\Temp\\anti-quota-old.tgz',
                false,
                false,
                'C:\\Temp\\anti-quota-old.tgz'
            );
        },
    })), /后台服务和登录自启均未恢复/);
    assert.deepStrictEqual(unsafeRollbackEvents, [
        'lock:start',
        'check',
        'assert-installable',
        'is-running',
        'autostart-state',
        'stop:true',
        'install-and-rollback-failed',
        'disable-autostart',
        'lock:end',
    ], '未验证的安装绝不能恢复后台服务或登录自启');

    const preexistingUnsafeEvents = [];
    await assert.rejects(cli.runUpdateCommand(['--force'], updateDependencies(available, preexistingUnsafeEvents, [], {
        assertInstallationSafe: () => {
            preexistingUnsafeEvents.push('unsafe-marker');
            throw new Error('检测到未完成恢复的 Anti Quota 安装');
        },
        installLatestUpdate: async () => {
            preexistingUnsafeEvents.push('install-failed-before-rollback');
            throw new Error('模拟下载或校验阶段失败');
        },
    })), /后台服务和登录自启均未恢复/);
    assert.deepStrictEqual(preexistingUnsafeEvents, [
        'lock:start',
        'check',
        'assert-installable',
        'unsafe-marker',
        'is-running',
        'autostart-state',
        'stop:true',
        'install-failed-before-rollback',
        'disable-autostart',
        'lock:end',
    ], '更新前已有持久阻断标记时，任一失败阶段都不得恢复服务或自启');

    const currentEvents = [];
    const currentOutput = [];
    await cli.runUpdateCommand([], updateDependencies(same, currentEvents, currentOutput, {
        assertInstallationSafe: () => { currentEvents.push('assert-installation-safe'); },
        assertUpdatableInstallation: () => { throw new Error('无更新时不应触碰安装'); },
        getServiceInfoForUpdate: async () => { throw new Error('无更新时不应探测服务'); },
    }));
    assert.deepStrictEqual(currentEvents, ['lock:start', 'check', 'assert-installation-safe', 'lock:end']);
    assert(currentOutput[0].includes('当前已是最新版'));

    const stopFailureEvents = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, stopFailureEvents, [], {
        stopRunningService: async options => {
            stopFailureEvents.push(`stop-failed:${!!options?.updateLock}`);
            throw new Error('模拟 stop 失败');
        },
        getServiceInfo: async () => {
            stopFailureEvents.push('service-info');
            return serviceInfo(available.currentVersion);
        },
    })), /模拟 stop 失败/);
    assert.deepStrictEqual(stopFailureEvents, [
        'lock:start', 'check', 'assert-installable', 'is-running', 'autostart-state',
        'stop-failed:true', 'lock:end',
    ], '未确认旧服务已停止时不得启动恢复流程或触碰安装');

    const mismatchEvents = [];
    const mismatchOutput = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, mismatchEvents, mismatchOutput, {
        getServiceInfo: async () => {
            mismatchEvents.push('service-info:mismatch');
            return serviceInfo('1.0.3');
        },
    })), /服务版本或切换协议与已安装版本 1\.1\.0 不兼容/);
    assert.strictEqual(
        mismatchEvents.filter(event => event === 'stop:true').length,
        1,
        '恢复校验遇到实例交接时不得再停止新实例'
    );
    assert.deepStrictEqual(mismatchOutput, []);

    const changedReleaseEvents = [];
    await cli.runUpdateCommand([], updateDependencies(available, changedReleaseEvents, [], {
        installLatestUpdate: async () => {
            changedReleaseEvents.push('release-changed');
            return { ...checkResult('1.0.3', '1.0.3', false), installed: false };
        },
        getServiceInfo: async () => {
            changedReleaseEvents.push('service-info:current');
            return serviceInfo('1.0.3');
        },
    }));
    assert.strictEqual(
        changedReleaseEvents.filter(event => event === 'stop:true').length,
        1,
        '第二次 Release 查询变为无需更新时，恢复的当前版本服务不应被误停'
    );

    const releaseFailureEvents = [];
    const releaseFailureOutput = [];
    await assert.rejects(cli.runUpdateCommand([], updateDependencies(available, releaseFailureEvents, releaseFailureOutput, {
        withUpdateLock: async action => {
            releaseFailureEvents.push('lock:start');
            await action({ stateDirectory: 'test-state' });
            releaseFailureEvents.push('lock:release-failed');
            throw new Error('模拟 lock release 失败');
        },
    })), /lock release 失败/);
    assert.deepStrictEqual(releaseFailureOutput, [], '锁释放失败前不得输出更新成功');

    await assert.rejects(cli.runUpdateCommand(['--check', '--force'], updateDependencies(same, [], [])), /不能同时使用/);

    const jsonFailure = spawnSync(process.execPath, [
        path.join(__dirname, '..', 'out', 'cli', 'cli.js'),
        'version',
        '--bad',
        '--json',
    ], { encoding: 'utf8' });
    assert.notStrictEqual(jsonFailure.status, 0);
    assert.deepStrictEqual(JSON.parse(jsonFailure.stdout), {
        ok: false,
        error: '未知参数: --bad',
    });
    console.log('CLI version/update regression tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
