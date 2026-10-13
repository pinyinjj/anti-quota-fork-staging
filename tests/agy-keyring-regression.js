const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const antigravityService = require('../out/services/antigravityService');

const tokenA = 'refresh-token-account-a';
const tokenB = 'refresh-token-account-b';
const tokenC = 'refresh-token-account-c';
const fingerprintA = antigravityService.fingerprintRefreshToken(tokenA);
const fingerprintB = antigravityService.fingerprintRefreshToken(tokenB);
const fingerprintC = antigravityService.fingerprintRefreshToken(tokenC);
const withoutRealLock = async action => action();
const expiry = 4102444800;

function credentialPayloadFingerprint(accessToken, refreshToken, expirySeconds = expiry) {
    return antigravityService.fingerprintCredentialPayload(JSON.stringify({
        auth_method: 'consumer',
        token: {
            access_token: accessToken,
            token_type: 'Bearer',
            refresh_token: refreshToken,
            expiry: new Date(Math.floor(expirySeconds) * 1000).toISOString(),
        },
    }));
}

const payloadFingerprintA = credentialPayloadFingerprint('access-a', tokenA);
const payloadFingerprintB = credentialPayloadFingerprint('access-b', tokenB);
const payloadFingerprintC = credentialPayloadFingerprint('access-c', tokenC);

function tokenFileSnapshot(refreshToken) {
    return Buffer.from(JSON.stringify({
        token: { access_token: `access-${refreshToken}`, refresh_token: refreshToken },
    }));
}

async function testKeyringIsAuthoritative() {
    let fileRead = false;
    const current = await antigravityService.getCurrentAgyCliRefreshTokenFingerprint({
        platform: 'win32',
        probeWindowsKeyring: async () => ({ status: 'found', fingerprint: fingerprintA }),
        readTokenFile: () => {
            fileRead = true;
            return { refreshToken: tokenB, accessToken: 'access-b' };
        },
    });

    assert.deepStrictEqual(current, {
        fingerprint: fingerprintA,
        source: 'windows-keyring',
    });
    assert.strictEqual(fileRead, false, 'Keyring FOUND 时不应读取文件并覆盖权威结果');
}

async function testFileFallbackOnlyWhenKeyringIsMissing() {
    const current = await antigravityService.getCurrentAgyCliRefreshTokenFingerprint({
        platform: 'win32',
        probeWindowsKeyring: async () => ({ status: 'not_found' }),
        readTokenFile: () => ({ refreshToken: tokenB, accessToken: 'access-b' }),
    });

    assert.deepStrictEqual(current, {
        fingerprint: fingerprintB,
        source: 'token-file',
    });
}

async function testProbeFailureDoesNotFallback() {
    let fileRead = false;
    await assert.rejects(
        antigravityService.getCurrentAgyCliRefreshTokenFingerprint({
            platform: 'win32',
            probeWindowsKeyring: async () => { throw new Error('probe failed'); },
            readTokenFile: () => {
                fileRead = true;
                return { refreshToken: tokenB, accessToken: 'access-b' };
            },
        }),
        /probe failed/
    );
    assert.strictEqual(fileRead, false, 'Keyring 探测失败时不得回退文件');
}

async function testWriteOrderAndVerification() {
    const calls = [];
    let fingerprintReads = 0;
    await antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
        platform: 'win32',
        withAuthWriteLock: async action => {
            calls.push('lock:start');
            try {
                return await action();
            } finally {
                calls.push('lock:end');
            }
        },
        beforeWrite: async () => { calls.push('process-check'); },
        captureTokenFile: () => {
            calls.push('snapshot');
            return Buffer.from('old-token-file');
        },
        restoreTokenFile: () => { calls.push('restore'); },
        writeTokenFile: (_accessToken, refreshToken) => {
            assert.strictEqual(refreshToken, tokenB);
            calls.push('file');
        },
        readTokenFileFingerprint: () => {
            calls.push('file:verify');
            return fingerprintB;
        },
        writeWindowsKeyring: async (payload) => {
            assert.strictEqual(JSON.parse(payload).token.refresh_token, tokenB);
            calls.push('keyring');
        },
        readCurrentFingerprint: async () => {
            fingerprintReads += 1;
            calls.push(fingerprintReads === 1 ? 'probe:before' : 'verify');
            return {
                fingerprint: fingerprintReads === 1 ? fingerprintA : fingerprintB,
                payloadFingerprint: fingerprintReads === 1 ? payloadFingerprintA : payloadFingerprintB,
                source: 'windows-keyring',
            };
        },
    });

    assert.deepStrictEqual(calls, [
        'lock:start',
        'process-check',
        'probe:before',
        'snapshot',
        'file',
        'keyring',
        'verify',
        'file:verify',
        'verify',
        'lock:end',
    ]);
}

async function testMalformedExistingKeyringCanSelfHeal() {
    const calls = [];
    let fingerprintReads = 0;
    await antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
        platform: 'win32',
        withAuthWriteLock: withoutRealLock,
        captureTokenFile: () => {
            calls.push('snapshot');
            return Buffer.from('old-token-file');
        },
        restoreTokenFile: () => { calls.push('restore'); },
        writeTokenFile: () => { calls.push('file'); },
        readTokenFileFingerprint: () => {
            calls.push('file:verify');
            return fingerprintB;
        },
        writeWindowsKeyring: async () => { calls.push('keyring'); },
        readCurrentFingerprint: async () => {
            fingerprintReads += 1;
            if (fingerprintReads === 1) {
                calls.push('probe:malformed');
                throw new Error('existing keyring payload is malformed');
            }
            calls.push('verify');
            return {
                fingerprint: fingerprintB,
                payloadFingerprint: payloadFingerprintB,
                source: 'windows-keyring',
            };
        },
    });

    assert.deepStrictEqual(calls, [
        'probe:malformed',
        'snapshot',
        'file',
        'keyring',
        'verify',
        'file:verify',
        'verify',
    ], '损坏的旧 Keyring 凭据不得阻止新凭据写入并完成权威回读');
}

async function testFileWriteFailureStopsBeforeKeyring() {
    let keyringWrite = false;
    let fingerprintReads = 0;
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => Buffer.from('old-token-file'),
            restoreTokenFile: () => { throw new Error('restore must not run'); },
            writeTokenFile: () => { throw new Error('file write failed'); },
            writeWindowsKeyring: async () => { keyringWrite = true; },
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                return { fingerprint: fingerprintA, source: 'windows-keyring' };
            },
        }),
        /file write failed/
    );
    assert.strictEqual(keyringWrite, false, '文件未落盘时不得提交 Windows Keyring');
    assert.strictEqual(fingerprintReads, 1, '写入失败时只能发生写前探测，不得执行写后成功核验');
}

async function testKeyringFailureRestoresTokenFile() {
    const calls = [];
    let fingerprintReads = 0;
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => {
                calls.push('snapshot');
                return tokenFileSnapshot(tokenA);
            },
            restoreTokenFile: restored => {
                calls.push(restored ? 'restore:snapshot' : 'restore:clear');
            },
            writeTokenFile: () => { calls.push('file'); },
            writeWindowsKeyring: async () => {
                calls.push('keyring');
                throw new Error('keyring write failed');
            },
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                calls.push(fingerprintReads === 1 ? 'probe:before' : 'verify');
                return { fingerprint: fingerprintA, source: 'windows-keyring' };
            },
        }),
        /keyring write failed/
    );
    assert.deepStrictEqual(
        calls,
        ['probe:before', 'snapshot', 'file', 'keyring', 'verify', 'keyring', 'verify', 'restore:snapshot'],
        'Keyring 写入报错且权威值仍为旧账号时必须恢复原令牌文件'
    );
}

async function testKeyringErrorWithCommittedValueSucceeds() {
    const calls = [];
    let fingerprintReads = 0;
    await antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
        platform: 'win32',
        withAuthWriteLock: withoutRealLock,
        captureTokenFile: () => Buffer.from('old-token-file'),
        restoreTokenFile: () => { calls.push('restore'); },
        writeTokenFile: () => { calls.push('file'); },
        readTokenFileFingerprint: () => {
            calls.push('file:verify');
            return fingerprintB;
        },
        writeWindowsKeyring: async () => {
            calls.push('keyring');
            throw new Error('process failed after CredWrite');
        },
        readCurrentFingerprint: async () => {
            fingerprintReads += 1;
            calls.push(fingerprintReads === 1 ? 'probe:before' : 'verify');
            return {
                fingerprint: fingerprintReads === 1 ? fingerprintA : fingerprintB,
                payloadFingerprint: fingerprintReads === 1 ? payloadFingerprintA : payloadFingerprintB,
                source: 'windows-keyring',
            };
        },
    });
    assert.deepStrictEqual(
        calls,
        ['probe:before', 'file', 'keyring', 'verify', 'file:verify', 'verify'],
        '子进程报错但权威回读已是目标账号时应按实际提交结果成功'
    );
}

async function testSameRefreshWithStalePayloadIsRejected() {
    const stalePayloadFingerprint = credentialPayloadFingerprint('expired-access', tokenB, 1);
    let keyringWrites = 0;
    let restoredSnapshot = false;
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, expiry, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => tokenFileSnapshot(tokenB),
            restoreTokenFile: restored => { restoredSnapshot = Buffer.isBuffer(restored); },
            writeTokenFile: () => undefined,
            writeWindowsKeyring: async () => {
                keyringWrites += 1;
                throw new Error('CredWrite remained failed');
            },
            readCurrentFingerprint: async () => ({
                fingerprint: fingerprintB,
                payloadFingerprint: stalePayloadFingerprint,
                source: 'windows-keyring',
            }),
        }),
        /CredWrite remained failed/
    );
    assert.strictEqual(keyringWrites, 2, '完整载荷未更新时必须重试写入且不得仅凭 refresh token 成功');
    assert.strictEqual(restoredSnapshot, true, '写入失败时应恢复与现存账号一致的原令牌文件');
}

async function testUnknownKeyringCommitClearsFallbackFile() {
    const calls = [];
    let fingerprintReads = 0;
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => Buffer.from('old-token-file'),
            restoreTokenFile: restored => { calls.push(restored ? 'restore:snapshot' : 'restore:clear'); },
            writeTokenFile: () => { calls.push('file'); },
            writeWindowsKeyring: async () => {
                calls.push('keyring');
                throw new Error('ambiguous keyring result');
            },
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                calls.push(fingerprintReads === 1 ? 'probe:before' : 'verify');
                if (fingerprintReads === 1) {
                    return { fingerprint: fingerprintA, source: 'windows-keyring' };
                }
                throw new Error('probe failed');
            },
        }),
        /写入结果未知且无法回读确认/
    );
    assert.deepStrictEqual(
        calls,
        ['probe:before', 'file', 'keyring', 'verify', 'keyring', 'verify', 'restore:clear'],
        '提交状态未知时必须清理可能冲突的回退文件'
    );
}

async function testFallbackFileIsRepairedAndVerified() {
    let fingerprintReads = 0;
    let fileReads = 0;
    let fileWrites = 0;
    await antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
        platform: 'win32',
        withAuthWriteLock: withoutRealLock,
        captureTokenFile: () => tokenFileSnapshot(tokenA),
        restoreTokenFile: () => { throw new Error('successful repair must not restore'); },
        writeTokenFile: () => { fileWrites += 1; },
        readTokenFileFingerprint: () => {
            fileReads += 1;
            return fileReads === 1 ? fingerprintC : fingerprintB;
        },
        writeWindowsKeyring: async () => undefined,
        readCurrentFingerprint: async () => {
            fingerprintReads += 1;
            return {
                fingerprint: fingerprintReads === 1 ? fingerprintA : fingerprintB,
                payloadFingerprint: fingerprintReads === 1 ? payloadFingerprintA : payloadFingerprintB,
                source: 'windows-keyring',
            };
        },
    });
    assert.strictEqual(fileWrites, 2, '令牌文件回读不匹配时必须原子重写一次');
    assert.strictEqual(fileReads, 2, '重写后的令牌文件必须再次回读核验');
}

async function testFinalKeyringRetryAlsoReconcilesFallbackFile() {
    let keyringFingerprint = fingerprintA;
    let keyringPayloadFingerprint = payloadFingerprintA;
    let fileFingerprint = fingerprintA;
    let fingerprintReads = 0;
    let keyringWrites = 0;
    let fileWrites = 0;

    await antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
        platform: 'win32',
        withAuthWriteLock: withoutRealLock,
        captureTokenFile: () => tokenFileSnapshot(tokenA),
        restoreTokenFile: () => { throw new Error('successful reconciliation must not restore'); },
        writeTokenFile: () => {
            fileWrites += 1;
            fileFingerprint = fingerprintB;
        },
        readTokenFileFingerprint: () => fileFingerprint,
        writeWindowsKeyring: async () => {
            keyringWrites += 1;
            keyringFingerprint = fingerprintB;
            keyringPayloadFingerprint = payloadFingerprintB;
        },
        readCurrentFingerprint: async () => {
            fingerprintReads += 1;
            if (fingerprintReads === 3) {
                // Simulate a legacy process replacing both stores after the first
                // fallback-file verification but before the final Keyring read.
                keyringFingerprint = fingerprintC;
                keyringPayloadFingerprint = payloadFingerprintC;
                fileFingerprint = fingerprintC;
            }
            return {
                fingerprint: keyringFingerprint,
                payloadFingerprint: keyringPayloadFingerprint,
                source: 'windows-keyring',
            };
        },
    });

    assert.strictEqual(keyringWrites, 2, '最终 Keyring 竞争后必须重写权威凭据');
    assert.strictEqual(fileWrites, 2, '重写 Keyring 后必须再次修复被覆盖的回退文件');
    assert.strictEqual(keyringFingerprint, fingerprintB);
    assert.strictEqual(fileFingerprint, fingerprintB);
    assert.strictEqual(fingerprintReads, 5, '修复文件后必须再次回读 Keyring 才能返回成功');
}

async function testPersistentFallbackMismatchIsCleared() {
    let cleared = false;
    let fingerprintReads = 0;
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => tokenFileSnapshot(tokenA),
            restoreTokenFile: restored => {
                assert.strictEqual(restored, null);
                cleared = true;
            },
            writeTokenFile: () => undefined,
            readTokenFileFingerprint: () => fingerprintC,
            writeWindowsKeyring: async () => undefined,
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                return {
                    fingerprint: fingerprintReads === 1 ? fingerprintA : fingerprintB,
                payloadFingerprint: fingerprintReads === 1 ? payloadFingerprintA : payloadFingerprintB,
                    source: 'windows-keyring',
                };
            },
        }),
        /令牌文件写入后的回读核验失败/
    );
    assert.strictEqual(cleared, true, '持续错误的回退文件必须被清理，不能与 Keyring 分裂');
}

async function testWriteRejectsWrongSourceOrFingerprint() {
    let restores = 0;
    const baseRuntime = {
        platform: 'win32',
        withAuthWriteLock: withoutRealLock,
        captureTokenFile: () => tokenFileSnapshot(tokenA),
        restoreTokenFile: () => { restores += 1; },
        writeTokenFile: () => undefined,
        writeWindowsKeyring: async () => undefined,
    };

    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            ...baseRuntime,
            readCurrentFingerprint: async () => ({ fingerprint: fingerprintB, source: 'token-file' }),
        }),
        /回读核验失败/
    );
    assert.strictEqual(restores, 1, '错误来源必须恢复事务前的令牌文件');
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            ...baseRuntime,
            readCurrentFingerprint: async () => ({ fingerprint: fingerprintA, source: 'windows-keyring' }),
        }),
        /回读核验失败/
    );
    assert.strictEqual(restores, 2, '明确读到其他账号时必须恢复事务前的令牌文件');
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            ...baseRuntime,
            readCurrentFingerprint: async () => null,
        }),
        /回读核验失败/
    );
    assert.strictEqual(restores, 3, '权威凭据明确不存在时必须恢复事务前的令牌文件');
}

async function testCommittedKeyringProbeFailureClearsFallbackFile() {
    const calls = [];
    let fingerprintReads = 0;
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => Buffer.from('old-token-file'),
            restoreTokenFile: restored => { calls.push(restored ? 'restore:snapshot' : 'restore:clear'); },
            writeTokenFile: () => { calls.push('file'); },
            writeWindowsKeyring: async () => { calls.push('keyring'); },
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                calls.push(fingerprintReads === 1 ? 'probe:before' : 'verify');
                if (fingerprintReads === 1) {
                    return { fingerprint: fingerprintA, source: 'windows-keyring' };
                }
                throw new Error('keyring probe failed');
            },
        }),
        /写入结果未知且无法回读确认/
    );
    assert.deepStrictEqual(
        calls,
        ['probe:before', 'file', 'keyring', 'verify', 'keyring', 'verify', 'restore:clear'],
        'Keyring 无法确认时必须清理可能冲突的回退文件'
    );
}

async function testConcurrentThirdAccountDoesNotBlindlyRestoreFile() {
    let fingerprintReads = 0;
    let restoredValue = 'not-called';
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'win32',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => Buffer.from('old-token-file'),
            restoreTokenFile: restored => { restoredValue = restored; },
            writeTokenFile: () => undefined,
            writeWindowsKeyring: async () => undefined,
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                return {
                    fingerprint: fingerprintReads === 1 ? fingerprintA : fingerprintC,
                    source: 'windows-keyring',
                };
            },
        }),
        /持续改为另一账号/
    );
    assert.strictEqual(restoredValue, null, '第三账号持续覆盖时必须清理冲突的回退文件');
}

async function testNonWindowsVerificationFailureRestoresTokenFile() {
    const calls = [];
    await assert.rejects(
        antigravityService.writeAgyCliAuth('access-b', tokenB, 4102444800, {
            platform: 'linux',
            withAuthWriteLock: withoutRealLock,
            captureTokenFile: () => Buffer.from('old-token-file'),
            restoreTokenFile: restored => { calls.push(`restore:${restored.toString('utf8')}`); },
            writeTokenFile: () => { calls.push('file'); },
            readCurrentFingerprint: async () => {
                calls.push('verify');
                return { fingerprint: fingerprintA, source: 'token-file' };
            },
        }),
        /回读核验失败/
    );
    assert.deepStrictEqual(calls, ['file', 'verify', 'restore:old-token-file']);
}

async function testConcurrentWritesAreSerialized() {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-auth-lock-'));
    const previousDataDirectory = process.env.ANTI_QUOTA_DATA_DIR;
    process.env.ANTI_QUOTA_DATA_DIR = temporaryDirectory;
    let activeKeyringWrites = 0;
    let maximumConcurrentWrites = 0;
    let releaseFirstReadback;
    let markFirstReadbackStarted;
    const firstReadbackStarted = new Promise(resolve => { markFirstReadbackStarted = resolve; });
    const firstReadbackGate = new Promise(resolve => { releaseFirstReadback = resolve; });
    const events = [];

    const write = (refreshToken, fingerprint) => {
        let fingerprintReads = 0;
        const payloadFingerprint = credentialPayloadFingerprint(`access-${refreshToken}`, refreshToken);
        return antigravityService.writeAgyCliAuth(
            `access-${refreshToken}`,
            refreshToken,
            4102444800,
            {
            platform: 'win32',
            captureTokenFile: () => null,
            restoreTokenFile: () => undefined,
            writeTokenFile: () => { events.push(`${refreshToken}:file`); },
            readTokenFileFingerprint: () => fingerprint,
            writeWindowsKeyring: async () => {
                events.push(`${refreshToken}:keyring:start`);
                activeKeyringWrites += 1;
                maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeKeyringWrites);
                await new Promise(resolve => setTimeout(resolve, 40));
                activeKeyringWrites -= 1;
                events.push(`${refreshToken}:keyring:end`);
            },
            readCurrentFingerprint: async () => {
                fingerprintReads += 1;
                if (refreshToken === tokenA && fingerprintReads === 2) {
                    events.push(`${refreshToken}:readback:start`);
                    markFirstReadbackStarted();
                    await firstReadbackGate;
                    events.push(`${refreshToken}:readback:end`);
                }
                return { fingerprint, payloadFingerprint, source: 'windows-keyring' };
            },
            }
        );
    };

    try {
        const firstWrite = write(tokenA, fingerprintA);
        await firstReadbackStarted;
        const secondWrite = write(tokenB, fingerprintB);
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.strictEqual(
            events.includes(`${tokenB}:file`),
            false,
            '第一笔事务仍在权威回读时，第二笔事务不得开始写文件'
        );
        releaseFirstReadback();
        await Promise.all([firstWrite, secondWrite]);
        assert.strictEqual(maximumConcurrentWrites, 1, '跨进程锁必须串行化完整的凭据写入事务');

        await assert.rejects(
            antigravityService.writeAgyCliAuth('access-a', tokenA, 4102444800, {
                platform: 'win32',
                beforeWrite: async () => { throw new Error('stop inside lock'); },
                captureTokenFile: () => null,
                restoreTokenFile: () => undefined,
                writeTokenFile: () => undefined,
                writeWindowsKeyring: async () => undefined,
                readCurrentFingerprint: async () => ({ fingerprint: fingerprintA, source: 'windows-keyring' }),
            }),
            /stop inside lock/
        );
        await Promise.race([
            write(tokenB, fingerprintB),
            new Promise((_, reject) => setTimeout(() => reject(new Error('异常事务未释放凭据锁')), 2000)),
        ]);
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.existsSync(path.join(temporaryDirectory, '.agy-auth.lock')), false);
        }
    } finally {
        releaseFirstReadback?.();
        if (previousDataDirectory === undefined) delete process.env.ANTI_QUOTA_DATA_DIR;
        else process.env.ANTI_QUOTA_DATA_DIR = previousDataDirectory;
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

async function main() {
    await testKeyringIsAuthoritative();
    await testFileFallbackOnlyWhenKeyringIsMissing();
    await testProbeFailureDoesNotFallback();
    await testWriteOrderAndVerification();
    await testMalformedExistingKeyringCanSelfHeal();
    await testFileWriteFailureStopsBeforeKeyring();
    await testKeyringFailureRestoresTokenFile();
    await testKeyringErrorWithCommittedValueSucceeds();
    await testSameRefreshWithStalePayloadIsRejected();
    await testUnknownKeyringCommitClearsFallbackFile();
    await testFallbackFileIsRepairedAndVerified();
    await testFinalKeyringRetryAlsoReconcilesFallbackFile();
    await testPersistentFallbackMismatchIsCleared();
    await testWriteRejectsWrongSourceOrFingerprint();
    await testCommittedKeyringProbeFailureClearsFallbackFile();
    await testConcurrentThirdAccountDoesNotBlindlyRestoreFile();
    await testNonWindowsVerificationFailureRestoresTokenFile();
    await testConcurrentWritesAreSerialized();
    console.log('agy keyring regression tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
