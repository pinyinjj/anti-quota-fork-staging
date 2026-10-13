const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cli = require('../out/cli/cli');
const service = require('../out/cli/service');
const antigravityService = require('../out/services/antigravityService');
const accountService = require('../out/services/accountService');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function connectToEndpoint(endpoint, timeout = 1000) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`连接服务端点超时: ${endpoint}`));
        }, timeout);
        const finish = callback => {
            clearTimeout(timer);
            socket.removeListener('connect', onConnect);
            socket.removeListener('error', onError);
            callback();
        };
        const onConnect = () => finish(() => resolve(socket));
        const onError = error => finish(() => reject(error));
        socket.once('connect', onConnect);
        socket.once('error', onError);
    });
}

async function waitForService(endpoint, tokenFile, child, stderr) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) {
            throw new Error(`测试服务提前退出 (${child.exitCode}): ${stderr()}`);
        }
        if (fs.existsSync(tokenFile)) {
            try {
                const socket = await connectToEndpoint(endpoint, 100);
                socket.destroy();
                return;
            } catch { }
        }
        await delay(50);
    }
    throw new Error(`等待测试服务启动超时: ${stderr()}`);
}

async function requestService(endpoint, token, command, args = {}, timeout = 3000) {
    const socket = await connectToEndpoint(endpoint);
    return new Promise((resolve, reject) => {
        let output = '';
        let settled = false;
        const finish = callback => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            callback();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`服务请求超时: ${command}`))), timeout);
        socket.setEncoding('utf8');
        socket.on('data', chunk => { output += chunk; });
        socket.on('error', error => finish(() => reject(error)));
        socket.on('end', () => {
            try {
                finish(() => resolve(JSON.parse(output.trim())));
            } catch (error) {
                finish(() => reject(error));
            }
        });
        socket.write(`${JSON.stringify({ token, command, args })}\n`);
    });
}

function waitForChildExit(child, timeout = 5000) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            reject(new Error('等待测试服务进程退出超时'));
        }, timeout);
        const onExit = code => {
            clearTimeout(timer);
            resolve(code);
        };
        child.once('exit', onExit);
    });
}

async function assertIdleSocketDoesNotBlockServiceStop() {
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-service-drain-'));
    const username = `AQDrain${process.pid}${Date.now()}`;
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\anti-quota-${username}`
        : path.join(testHome, '.anti-quota', 'service.sock');
    const tokenFile = path.join(testHome, '.anti-quota', 'service-token');
    const pidFile = path.join(testHome, '.anti-quota', 'service.pid');
    const childEnvironment = {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        USERNAME: username,
        APPDATA: path.join(testHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(testHome, 'AppData', 'Local'),
    };
    delete childEnvironment.ANTI_QUOTA_UPDATE_RESTORE_CAPABILITY;

    const cliPath = path.resolve(__dirname, '../out/cli/cli.js');
    const child = spawn(process.execPath, [cliPath, 'service', 'run'], {
        cwd: path.resolve(__dirname, '..'),
        env: childEnvironment,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    let childStderr = '';
    child.stderr.on('data', chunk => { childStderr += chunk; });
    let idleSocket;

    try {
        await waitForService(endpoint, tokenFile, child, () => childStderr);
        idleSocket = await connectToEndpoint(endpoint);
        const idleClosed = new Promise(resolve => idleSocket.once('close', resolve));
        const token = fs.readFileSync(tokenFile, 'utf8').trim();
        const stopResponse = await requestService(endpoint, token, 'stop');
        assert.strictEqual(stopResponse.ok, true);
        assert.strictEqual(stopResponse.data?.stopping, true);

        await Promise.race([
            idleClosed,
            delay(2000).then(() => { throw new Error('stop 未关闭空闲服务 socket'); }),
        ]);
        const exitCode = await waitForChildExit(child);
        assert.strictEqual(exitCode, 0, `服务进程退出失败: ${childStderr}`);
        assert.strictEqual(fs.existsSync(pidFile), false, '服务完全退出后应清理自己的 PID 文件');
    } finally {
        idleSocket?.destroy();
        if (child.exitCode === null) {
            child.kill();
            try { await waitForChildExit(child, 2000); } catch { }
        }
        fs.rmSync(testHome, { recursive: true, force: true });
    }
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function account(id, refreshToken, lastUsed = 0) {
    return {
        id,
        email: `${id}@example.com`,
        token: {
            access_token: `access-${id}`,
            refresh_token: refreshToken,
            expires_in: 3600,
            expiry_timestamp: 1000,
            token_type: 'Bearer',
        },
        created_at: 1,
        last_used: lastUsed,
    };
}

(async () => {
    const first = account('first', 'refresh-first', 10);
    const latest = account('latest', 'refresh-latest', 999);

    const noCredentialCurrent = await service.getCurrentManagedAccount({
        listAccounts: () => [first, latest],
        getCurrentAgyCliRefreshTokenFingerprint: async () => null,
    });
    assert.strictEqual(
        noCredentialCurrent,
        null,
        '没有真实 agy 凭据时不得把 last_used 最大的账号伪装成当前账号'
    );

    const agyCurrent = await service.getCurrentManagedAccount({
        listAccounts: () => [first, latest],
        getCurrentAgyCliRefreshTokenFingerprint: async () => ({
            fingerprint: fingerprint(first.token.refresh_token),
            source: 'windows-keyring',
        }),
    });
    assert.strictEqual(agyCurrent.id, first.id, 'agy 凭据必须优先决定当前账号');

    const unknownAgyCurrent = await service.getCurrentManagedAccount({
        listAccounts: () => [first, latest],
        getCurrentAgyCliRefreshTokenFingerprint: async () => ({
            fingerprint: fingerprint('unmanaged-refresh'),
            source: 'windows-keyring',
        }),
    });
    assert.strictEqual(
        unknownAgyCurrent,
        null,
        'agy 当前凭据未绑定时不得回退到最近使用账号'
    );

    let probeErrorReports = 0;
    const probeErrorDependencies = {
        listAccounts: () => [first, latest],
        getCurrentAgyCliRefreshTokenFingerprint: async () => {
            throw new Error('simulated keyring failure');
        },
        reportProbeError: () => { probeErrorReports += 1; },
    };
    assert.strictEqual(
        await service.getCurrentManagedAccount(probeErrorDependencies),
        null,
        '普通 list/current 不应因 Keyring 探测异常导致整个菜单失败'
    );
    assert.strictEqual(probeErrorReports, 1);
    await assert.rejects(
        service.getCurrentManagedAccount(probeErrorDependencies, { failOnProbeError: true }),
        /无法读取 agy 权威凭据状态/
    );
    assert.strictEqual(probeErrorReports, 2);

    const failedEvents = [];
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => false,
        refreshAccessToken: async () => {
            failedEvents.push('refresh');
            return { access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' };
        },
        writeAgyCliAuth: async () => {
            failedEvents.push('write');
            throw new Error('simulated authoritative readback failure');
        },
        updateAccount: () => { failedEvents.push('update'); },
        now: () => 100,
    }), /authoritative readback failure/);
    assert.deepStrictEqual(
        failedEvents,
        ['refresh', 'write'],
        '凭据层权威回读失败时不得更新 last_used 或宣告成功'
    );

    let mismatchRestored = false;
    let mismatchMetadataUpdated = false;
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => false,
        refreshAccessToken: async () => ({
            access_token: 'mismatch-access',
            expires_in: 3600,
            token_type: 'Bearer',
        }),
        writeAgyCliAuth: (accessToken, refreshToken, expiry, runtime) =>
            antigravityService.writeAgyCliAuth(accessToken, refreshToken, expiry, {
                ...runtime,
                platform: 'win32',
                withAuthWriteLock: async action => action(),
                captureTokenFile: () => Buffer.from('old-token-file'),
                restoreTokenFile: () => { mismatchRestored = true; },
                writeTokenFile: () => undefined,
                writeWindowsKeyring: async () => undefined,
                readCurrentFingerprint: async () => ({
                    fingerprint: fingerprint(latest.token.refresh_token),
                    source: 'windows-keyring',
                }),
            }),
        updateAccount: () => { mismatchMetadataUpdated = true; },
        now: () => 150,
    }), /回读核验失败/);
    assert.strictEqual(mismatchRestored, true, '权威凭据不匹配时必须回滚令牌文件');
    assert.strictEqual(mismatchMetadataUpdated, false, '权威凭据不匹配时不得更新账号元数据');

    const cancellationEvents = [];
    let finishRefresh;
    let markRefreshStarted;
    const refreshStarted = new Promise(resolve => { markRefreshStarted = resolve; });
    const cancellation = new AbortController();
    const cancelledSwitch = service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => false,
        refreshAccessToken: async () => {
            cancellationEvents.push('refresh');
            markRefreshStarted();
            return new Promise(resolve => { finishRefresh = resolve; });
        },
        writeAgyCliAuth: async () => { cancellationEvents.push('write'); },
        updateAccount: () => { cancellationEvents.push('update'); },
        now: () => 175,
    }, cancellation.signal);
    await refreshStarted;
    cancellation.abort();
    finishRefresh({ access_token: 'cancelled-access', expires_in: 3600, token_type: 'Bearer' });
    await assert.rejects(cancelledSwitch, error => error?.name === 'AbortError');
    assert.deepStrictEqual(
        cancellationEvents,
        ['refresh'],
        '取消的旧请求在 Token 刷新返回后不得继续写入并覆盖新选择'
    );

    const quotaRefreshEvents = [];
    const quotaRefreshCancellation = new AbortController();
    await assert.rejects(
        accountService.refreshAccountQuotasSequentially(
            ['first', 'second', 'third'],
            async accountId => {
                quotaRefreshEvents.push(accountId);
                if (accountId === 'first') quotaRefreshCancellation.abort();
            },
            quotaRefreshCancellation.signal
        ),
        error => error?.name === 'AbortError'
    );
    assert.deepStrictEqual(
        quotaRefreshEvents,
        ['first'],
        '批量刷新取消后不得继续启动后续账号请求并长期占用切换队列'
    );

    const commitBoundaryEvents = [];
    let finishCredentialCommit;
    let markCredentialCommitStarted;
    const credentialCommitStarted = new Promise(resolve => { markCredentialCommitStarted = resolve; });
    const credentialCommitGate = new Promise(resolve => { finishCredentialCommit = resolve; });
    const commitBoundaryCancellation = new AbortController();
    const committedSwitch = service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => false,
        refreshAccessToken: async () => ({
            access_token: 'committed-access',
            expires_in: 3600,
            token_type: 'Bearer',
        }),
        writeAgyCliAuth: async (_access, _refresh, _expiry, runtime) => {
            await runtime.beforeWrite();
            commitBoundaryEvents.push('commit:start');
            markCredentialCommitStarted();
            await credentialCommitGate;
            commitBoundaryEvents.push('commit:end');
        },
        updateAccount: () => { commitBoundaryEvents.push('update'); },
        now: () => 190,
    }, commitBoundaryCancellation.signal);
    await credentialCommitStarted;
    commitBoundaryCancellation.abort();
    finishCredentialCommit();
    const committedResult = await committedSwitch;
    assert.strictEqual(committedResult.last_used, 190);
    assert.deepStrictEqual(
        commitBoundaryEvents,
        ['commit:start', 'commit:end', 'update'],
        '凭据提交开始后的取消不得中断回读后的元数据收尾'
    );

    const reappliedEvents = [];
    const reapplied = await service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => false,
        refreshAccessToken: async () => {
            reappliedEvents.push('refresh');
            return { access_token: 'reapplied-access', expires_in: 1800, token_type: 'Bearer' };
        },
        writeAgyCliAuth: async () => { reappliedEvents.push('write'); },
        updateAccount: (id, updates) => {
            reappliedEvents.push(`update:${id}:${updates.last_used}`);
        },
        now: () => 200,
    });
    assert.strictEqual(reapplied.id, first.id);
    assert.deepStrictEqual(
        reappliedEvents,
        ['refresh', 'write', 'update:first:200'],
        '当前账号也必须允许重新写入并在回读确认后更新状态'
    );

    const runningEvents = [];
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => {
            runningEvents.push('process-check');
            return true;
        },
        refreshAccessToken: async () => {
            runningEvents.push('refresh');
            throw new Error('must not refresh');
        },
        writeAgyCliAuth: async () => { runningEvents.push('write'); },
        updateAccount: () => { runningEvents.push('update'); },
        now: () => 300,
    }), /先退出所有 agy 会话/);
    assert.deepStrictEqual(
        runningEvents,
        ['process-check'],
        '检测到旧 agy 会话时必须在刷新或写入凭据前拒绝切换'
    );

    const lateProcessEvents = [];
    let processChecks = 0;
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => {
            processChecks += 1;
            lateProcessEvents.push(`process-check:${processChecks}`);
            return processChecks === 2;
        },
        refreshAccessToken: async () => {
            lateProcessEvents.push('refresh');
            return { access_token: 'late-access', expires_in: 3600, token_type: 'Bearer' };
        },
        writeAgyCliAuth: async () => { lateProcessEvents.push('write'); },
        updateAccount: () => { lateProcessEvents.push('update'); },
        now: () => 400,
    }), /刷新 Token 期间检测到 agy\.exe 已启动/);
    assert.deepStrictEqual(
        lateProcessEvents,
        ['process-check:1', 'refresh', 'process-check:2'],
        'Token 刷新期间启动 agy 时必须在凭据写入前再次拦截'
    );

    const lockedProcessEvents = [];
    let lockedProcessChecks = 0;
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => {
            lockedProcessChecks += 1;
            lockedProcessEvents.push(`process-check:${lockedProcessChecks}`);
            return lockedProcessChecks === 3;
        },
        refreshAccessToken: async () => {
            lockedProcessEvents.push('refresh');
            return { access_token: 'locked-access', expires_in: 3600, token_type: 'Bearer' };
        },
        writeAgyCliAuth: async (_access, _refresh, _expiry, runtime) => {
            lockedProcessEvents.push('lock:acquired');
            await runtime.beforeWrite();
            lockedProcessEvents.push('write');
        },
        updateAccount: () => { lockedProcessEvents.push('update'); },
        now: () => 450,
    }), /取得凭据锁后检测到 agy\.exe 已启动/);
    assert.deepStrictEqual(
        lockedProcessEvents,
        ['process-check:1', 'refresh', 'process-check:2', 'lock:acquired', 'process-check:3'],
        '取得跨进程凭据锁后必须再次确认没有 agy 会话再写入'
    );

    const postCommitProcessEvents = [];
    let postCommitProcessChecks = 0;
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => {
            postCommitProcessChecks += 1;
            postCommitProcessEvents.push(`process-check:${postCommitProcessChecks}`);
            return postCommitProcessChecks === 4;
        },
        refreshAccessToken: async () => {
            postCommitProcessEvents.push('refresh');
            return { access_token: 'post-commit-access', expires_in: 3600, token_type: 'Bearer' };
        },
        writeAgyCliAuth: async (_access, _refresh, _expiry, runtime) => {
            postCommitProcessEvents.push('lock:acquired');
            await runtime.beforeWrite();
            postCommitProcessEvents.push('write');
        },
        updateAccount: () => { postCommitProcessEvents.push('update'); },
        now: () => 475,
    }), /agy 凭据已更新.*当前进程可能仍使用旧凭据.*退出并重启/s);
    assert.deepStrictEqual(
        postCommitProcessEvents,
        [
            'process-check:1',
            'refresh',
            'process-check:2',
            'lock:acquired',
            'process-check:3',
            'write',
            'process-check:4',
        ],
        '凭据提交后才启动的 agy 不得获得普通成功响应或更新 last_used'
    );

    let postCommitProbeChecks = 0;
    let postCommitProbeMetadataUpdates = 0;
    await assert.rejects(service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => {
            postCommitProbeChecks += 1;
            if (postCommitProbeChecks === 4) throw new Error('simulated tasklist failure');
            return false;
        },
        refreshAccessToken: async () => ({
            access_token: 'post-commit-probe-access',
            expires_in: 3600,
            token_type: 'Bearer',
        }),
        writeAgyCliAuth: async (_access, _refresh, _expiry, runtime) => {
            await runtime.beforeWrite();
        },
        updateAccount: () => { postCommitProbeMetadataUpdates += 1; },
        now: () => 490,
    }), /凭据已更新.*无法确认.*退出并重启/s);
    assert.strictEqual(
        postCommitProbeMetadataUpdates,
        0,
        '提交后的进程状态无法确认时不得更新账号元数据'
    );

    const metadataEvents = [];
    const metadataResult = await service.switchAgyAccount(first, {
        isAgyProcessRunning: async () => false,
        refreshAccessToken: async () => ({
            access_token: 'metadata-access',
            expires_in: 3600,
            token_type: 'Bearer',
        }),
        writeAgyCliAuth: async () => { metadataEvents.push('write'); },
        updateAccount: () => {
            metadataEvents.push('update');
            throw new Error('simulated metadata failure');
        },
        reportMetadataError: () => { metadataEvents.push('report'); },
        now: () => 500,
    });
    assert.strictEqual(metadataResult.id, first.id);
    assert.strictEqual(metadataResult.last_used, first.last_used, '元数据保存失败时不得伪造新的 last_used');
    assert.deepStrictEqual(
        metadataEvents,
        ['write', 'update', 'report'],
        '凭据已核验后，元数据保存失败不得把实际切换伪装成失败'
    );

    assert.strictEqual(service.tasklistContainsAgy('"agy.exe","123","Console","1","10,000 K"\r\n'), true);
    assert.strictEqual(service.tasklistContainsAgy('INFO: No tasks are running which match the specified criteria.'), false);
    assert.strictEqual(service.processListContainsAgy('/usr/local/bin/agy\n'), true);
    assert.strictEqual(service.processListContainsAgy('/usr/local/bin/node\n'), false);

    assert.strictEqual(cli.getAccountApplyBlockReason({ current: true, disabled: false }), null);
    assert.strictEqual(cli.getAccountApplyBlockReason({ current: true, disabled: true }), 'disabled');
    assert.strictEqual(cli.getAccountApplyBlockReason(null), 'missing');
    assert.doesNotThrow(() => cli.assertSwitchConfirmed({ current: true }));
    assert.throws(() => cli.assertSwitchConfirmed({ current: false }), /未确认 agy 当前账号/);
    assert.throws(() => cli.assertSwitchConfirmed(null), /未确认 agy 当前账号/);
    assert.doesNotThrow(() => cli.assertSwitchConfirmed({ id: first.id, current: true }, first.id));
    assert.throws(
        () => cli.assertSwitchConfirmed({ id: latest.id, current: true }, first.id),
        /与所选目标不一致/
    );
    assert.strictEqual(
        cli.assertUniqueCurrentAccount([
            { id: latest.id, current: false },
            { id: first.id, current: true },
        ], first.id).id,
        first.id
    );
    assert.throws(
        () => cli.assertUniqueCurrentAccount([{ id: first.id, current: false }], first.id),
        /未检测到 agy 当前账号/
    );
    assert.throws(
        () => cli.assertUniqueCurrentAccount([{ id: latest.id, current: true }], first.id),
        /与所选目标不一致/
    );
    assert.throws(
        () => cli.assertUniqueCurrentAccount([
            { id: first.id, current: true },
            { id: latest.id, current: true },
        ], first.id),
        /多个 agy 当前账号/
    );

    assert.strictEqual(service.publicAccount(first, latest.id).current, false);
    assert.strictEqual(service.publicAccount(first, first.id).current, true);

    const confirmed = await service.confirmSwitchedAccount(first, async () => first);
    assert.strictEqual(confirmed.current, true);
    await assert.rejects(
        service.confirmSwitchedAccount(first, async () => latest),
        /权威凭据未指向目标账号/
    );
    await assert.rejects(
        service.confirmSwitchedAccount(first, async () => null),
        /权威凭据未指向目标账号/
    );
    await assert.rejects(
        service.confirmSwitchedAccount(first, async () => { throw new Error('probe unavailable'); }),
        /probe unavailable/
    );

    const queueEvents = [];
    let releaseFirstTransaction;
    let markFirstTransactionStarted;
    const firstTransactionStarted = new Promise(resolve => { markFirstTransactionStarted = resolve; });
    const firstTransactionGate = new Promise(resolve => { releaseFirstTransaction = resolve; });
    const firstTransaction = service.runSerializedSwitchTransaction(async () => {
        queueEvents.push('first:start');
        markFirstTransactionStarted();
        await firstTransactionGate;
        queueEvents.push('first:end');
    });
    await firstTransactionStarted;
    const secondTransaction = service.runSerializedSwitchTransaction(async () => {
        queueEvents.push('second:start');
        queueEvents.push('second:end');
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(queueEvents, ['first:start'], '后到切换不得越过仍在执行的先到请求');
    releaseFirstTransaction();
    await Promise.all([firstTransaction, secondTransaction]);
    assert.deepStrictEqual(
        queueEvents,
        ['first:start', 'first:end', 'second:start', 'second:end'],
        '切换事务必须按请求到达顺序完整串行执行'
    );

    const cancelledQueueEvents = [];
    let releaseQueueBlocker;
    let markQueueBlockerStarted;
    const queueBlockerStarted = new Promise(resolve => { markQueueBlockerStarted = resolve; });
    const queueBlockerGate = new Promise(resolve => { releaseQueueBlocker = resolve; });
    const queueBlocker = service.runSerializedSwitchTransaction(async () => {
        cancelledQueueEvents.push('blocker');
        markQueueBlockerStarted();
        await queueBlockerGate;
    });
    await queueBlockerStarted;
    const queuedCancellation = new AbortController();
    const cancelledQueueItem = service.runSerializedSwitchTransaction(async () => {
        cancelledQueueEvents.push('cancelled');
    }, queuedCancellation.signal);
    const followingQueueItem = service.runSerializedSwitchTransaction(async () => {
        cancelledQueueEvents.push('following');
    });
    queuedCancellation.abort();
    releaseQueueBlocker();
    await queueBlocker;
    await assert.rejects(cancelledQueueItem, error => error?.name === 'AbortError');
    await followingQueueItem;
    assert.deepStrictEqual(
        cancelledQueueEvents,
        ['blocker', 'following'],
        '排队期间取消的请求必须跳过，同时不得阻塞后续切换'
    );

    const drainEvents = [];
    const requestDrain = new service.ServiceRequestDrain(() => { drainEvents.push('drained'); });
    const finishDrainedRequest = requestDrain.beginRequest();
    requestDrain.beginShutdown();
    assert.deepStrictEqual(drainEvents, [], 'stop 不得在凭据提交仍在进行时关闭服务');
    assert.throws(
        () => requestDrain.beginRequest(),
        /服务正在停止/,
        'stop 到达后不得再接受新的业务请求'
    );
    finishDrainedRequest();
    assert.deepStrictEqual(drainEvents, ['drained'], '最后一个在途请求完成后才能关闭服务');
    finishDrainedRequest();
    requestDrain.beginShutdown();
    assert.deepStrictEqual(drainEvents, ['drained'], '请求完成与重复 stop 都不得重复关闭服务');

    const pidOwnershipDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-pid-owner-'));
    const guardedPidFile = path.join(pidOwnershipDirectory, 'service.pid');
    try {
        fs.writeFileSync(guardedPidFile, '987654321', 'utf8');
        assert.strictEqual(
            service.removeOwnedPidFile(guardedPidFile, process.pid),
            false,
            '旧服务不得删除属于新实例的 PID 文件'
        );
        assert.strictEqual(fs.readFileSync(guardedPidFile, 'utf8'), '987654321');
        fs.writeFileSync(guardedPidFile, String(process.pid), 'utf8');
        assert.strictEqual(service.removeOwnedPidFile(guardedPidFile, process.pid), true);
        assert.strictEqual(fs.existsSync(guardedPidFile), false, '服务应清理仍属于自身的 PID 文件');

        const guardedEndpointFile = path.join(pidOwnershipDirectory, 'service.sock');
        fs.writeFileSync(guardedEndpointFile, 'endpoint-owner', 'utf8');
        const endpointIdentity = service.readEndpointFileIdentity(guardedEndpointFile);
        assert.strictEqual(service.removeOwnedEndpointFile(guardedEndpointFile, {
            ...endpointIdentity,
            ino: endpointIdentity.ino + 1n,
        }), false, '旧服务不得删除身份已变化的 Unix socket 路径');
        assert.strictEqual(fs.existsSync(guardedEndpointFile), true);
        assert.strictEqual(service.removeOwnedEndpointFile(guardedEndpointFile, endpointIdentity), true);
        assert.strictEqual(fs.existsSync(guardedEndpointFile), false);
    } finally {
        fs.rmSync(pidOwnershipDirectory, { recursive: true, force: true });
    }

    await assertIdleSocketDoesNotBlockServiceStop();

    console.log('CLI account switch regression tests passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
