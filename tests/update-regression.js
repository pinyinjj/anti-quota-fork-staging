const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const update = require('../out/cli/update');

function createFixture(root, version = '1.0.3', options = {}) {
    fs.mkdirSync(root, { recursive: true });
    const manifest = {
        name: 'anti-quota',
        version,
        bin: {
            anti: './out/cli/cli.js',
            'anti-quota': './out/cli/cli.js',
            aq: './out/cli/cli.js',
        },
        ...options.manifest,
    };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    const cliEntry = path.join(root, 'out', 'cli', 'cli.js');
    fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
    if (options.writeEntry !== false) fs.writeFileSync(cliEntry, '// fixture CLI entry\n');
    else fs.rmSync(cliEntry, { force: true });
}

function releaseMetadata(version, tgz, checksum, overrides = {}) {
    const tgzName = `anti-quota-${version}.tgz`;
    return {
        tag_name: `v${version}`,
        html_url: `https://github.com/pinyinjj/anti-quota-fork-staging/releases/tag/v${version}`,
        published_at: '2026-10-12T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [
            {
                name: tgzName,
                browser_download_url: `https://github.com/pinyinjj/anti-quota-fork-staging/releases/download/v${version}/${tgzName}`,
                size: tgz.length,
            },
            {
                name: `${tgzName}.sha256`,
                browser_download_url: `https://github.com/pinyinjj/anti-quota-fork-staging/releases/download/v${version}/${tgzName}.sha256`,
                size: checksum.length,
            },
        ],
        ...overrides,
    };
}

function fakeRequest(metadata, calls) {
    return async (url, options, body, timeout, maxResponseBytes) => {
        calls.push({ url, options, body, timeout, maxResponseBytes });
        return { status: 200, body: JSON.stringify(metadata), headers: {} };
    };
}

function fakeNpmExecutor(packageRoot, expectedVersion, calls, options = {}) {
    return async (executable, args, execOptions) => {
        calls.push({ executable, args, options: execOptions });
        if (args.includes('root')) {
            assert.deepStrictEqual(args.slice(-2), ['root', '--global']);
            return {
                stdout: `${options.npmRoot || path.dirname(packageRoot)}\n`,
                stderr: '',
            };
        }
        if (args.includes('pack')) {
            if (!args.includes('--dry-run')) {
                const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
                const destinationIndex = args.indexOf('--pack-destination');
                assert(destinationIndex >= 0, '回滚备份必须指定独立目标目录');
                const backupDirectory = args[destinationIndex + 1];
                assert(backupDirectory, '回滚备份目标目录不能为空');
                fs.mkdirSync(backupDirectory, { recursive: true });
                const filename = `${manifest.name}-${manifest.version}.tgz`;
                fs.writeFileSync(path.join(backupDirectory, filename), 'rollback package fixture');
                return {
                    stdout: JSON.stringify([{
                        name: options.backupPackageName || manifest.name,
                        version: options.backupPackageVersion || manifest.version,
                        filename: options.backupFilename || filename,
                        files: options.backupFiles || [
                            { path: 'package.json' },
                            { path: 'out/cli/cli.js' },
                        ],
                    }]),
                    stderr: '',
                };
            }
            const tgzArgument = args.find(value => value.endsWith('.tgz'));
            assert(tgzArgument && fs.existsSync(tgzArgument), 'npm 检查时 TGZ 临时文件必须存在');
            return {
                stdout: JSON.stringify([{
                    name: options.packageName || 'anti-quota',
                    version: options.packageVersion || expectedVersion,
                }]),
                stderr: '',
            };
        }
        if (args.includes('install')) {
            const tgzArgument = args.find(value => value.endsWith('.tgz'));
            assert(tgzArgument && fs.existsSync(tgzArgument), 'npm 安装时 TGZ 临时文件必须存在');
            const isRollback = path.basename(path.dirname(tgzArgument)) === 'rollback';
            if (isRollback) {
                if (options.rollbackInstallFailure) {
                    throw new Error('simulated rollback install failure');
                }
                createFixture(packageRoot, options.previousVersion || '1.0.3');
                return { stdout: '', stderr: '' };
            }
            if (options.failInstallAfterMutation) {
                fs.rmSync(packageRoot, { recursive: true, force: true });
                fs.mkdirSync(packageRoot, { recursive: true });
                fs.writeFileSync(path.join(packageRoot, 'partial-install'), 'broken');
                throw new Error('simulated npm install failure after mutation');
            }
            if (options.writeInstalledVersion !== false) {
                createFixture(packageRoot, expectedVersion, {
                    manifest: options.installedManifest,
                    writeEntry: options.writeInstalledEntry,
                });
            }
            return { stdout: '', stderr: '' };
        }
        assert.strictEqual(executable, process.execPath, '安装后必须直接使用 node.exe 自检新入口');
        assert.deepStrictEqual(args.slice(1), ['version', '--json']);
        assert.strictEqual(path.resolve(args[0]), path.resolve(packageRoot, 'out', 'cli', 'cli.js'));
        assert(fs.statSync(args[0]).isFile(), '自检前新 CLI 入口必须存在');
        const installedVersion = JSON.parse(
            fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
        ).version;
        const smokeVersion = installedVersion === expectedVersion
            ? (options.smokeVersion || installedVersion)
            : (options.rollbackSmokeVersion || installedVersion);
        return {
            stdout: options.smokeStdout !== undefined
                ? options.smokeStdout
                : JSON.stringify({ cliVersion: smokeVersion }),
            stderr: '',
        };
    };
}

async function captureRejection(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected promise to reject');
}

function fixtureVersion(packageRoot) {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}

(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-update-test-'));
    try {
        assert.strictEqual(update.compareVersions('1.0.3', '1.0.3'), 0);
        assert.strictEqual(update.compareVersions('1.0.3', '1.0.4'), -1);
        assert.strictEqual(update.compareVersions('2.0.0', '1.99.99'), 1);
        assert.strictEqual(update.compareVersions('1.1.0-beta.2', '1.1.0-beta.10'), -1);
        assert.strictEqual(update.compareVersions('1.1.0-rc.1', '1.1.0'), -1);
        assert.strictEqual(update.compareVersions('v1.0.0+build.1', '1.0.0+build.2'), 0);
        assert.strictEqual(update.compareVersions('9007199254740991.0.0', '9007199254740990.99.99'), 1);
        assert.throws(() => update.compareVersions('1.01.0', '1.1.0'), /格式无效/);
        assert.throws(() => update.compareVersions('9007199254740992.0.0', '1.0.0'), /格式无效/);
        assert.throws(() => update.compareVersions('1.0.0-9007199254740992', '1.0.0-1'), /格式无效/);

        const npmGlobalRoot = path.join(scratch, 'global', 'node_modules');
        const packageRoot = path.join(npmGlobalRoot, 'anti-quota');
        const stateDirectory = path.join(scratch, 'state');
        const temporaryDirectory = path.join(scratch, 'tmp');
        createFixture(packageRoot);
        assert.strictEqual(update.getCurrentVersion({ packageRoot }), '1.0.3');
        assert.strictEqual(update.detectInstallationKind({ packageRoot }), 'package');

        const npmInvocation = update.resolveNpmInvocation({ platform: process.platform });
        const npmVersion = await promisify(execFile)(
            npmInvocation.executable,
            [...npmInvocation.argsPrefix, '--version'],
            { windowsHide: true }
        );
        assert.match(npmVersion.stdout.trim(), /^\d+\.\d+\.\d+/);

        const tgz = Buffer.from('trusted tgz fixture');
        const tgzName = 'anti-quota-1.1.0.tgz';
        const digest = crypto.createHash('sha256').update(tgz).digest('hex');
        const checksum = Buffer.from(`${digest}  ${tgzName}\n`);
        const metadata = releaseMetadata('1.1.0', tgz, checksum);
        const checkCalls = [];
        const check = await update.checkForUpdate({
            packageRoot,
            requestHttps: fakeRequest(metadata, checkCalls),
        });
        assert.strictEqual(check.currentVersion, '1.0.3');
        assert.strictEqual(check.latestVersion, '1.1.0');
        assert.strictEqual(check.updateAvailable, true);
        assert.strictEqual(checkCalls.length, 1);
        assert.strictEqual(checkCalls[0].url, update.RELEASE_API_URL);
        assert.strictEqual(checkCalls[0].options.headers['User-Agent'], 'anti-quota/1.0.3');
        assert.strictEqual(checkCalls[0].body, undefined);
        assert.strictEqual(checkCalls[0].maxResponseBytes, 1024 * 1024);

        const npmCalls = [];
        const downloadCalls = [];
        const install = await update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            platform: 'win32',
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination, options) => {
                downloadCalls.push({ url, destination, options });
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', npmCalls),
        });
        assert.strictEqual(install.installed, true);
        assert.strictEqual(downloadCalls.length, 2);
        assert.strictEqual(downloadCalls[0].options.allowedHosts.includes('github.com'), true);
        assert.strictEqual(npmCalls.length, 5);
        assert(npmCalls[0].args.includes('pack'), '安装前必须检查 TGZ 包标识');
        assert.strictEqual(npmCalls[1].executable, process.execPath);
        assert.match(npmCalls[1].args[0], /npm-cli\.js$/i);
        assert.deepStrictEqual(npmCalls[1].args.slice(1), ['root', '--global']);
        assert(npmCalls[2].args.includes('pack'), '全局安装前必须创建当前版本回滚备份');
        assert(!npmCalls[2].args.includes('--dry-run'), '回滚备份必须实际生成 TGZ');
        assert.deepStrictEqual(npmCalls[3].args.slice(1, 3), ['install', '--global']);
        assert(npmCalls[3].args.includes('--ignore-scripts'));
        assert(!npmCalls[3].args.some(value => /\.vsix$/i.test(value)), 'CLI 更新不得安装 VSIX');
        assert.strictEqual(npmCalls[4].executable, process.execPath);
        assert.deepStrictEqual(npmCalls[4].args.slice(1), ['version', '--json']);
        assert.strictEqual(fs.existsSync(path.join(stateDirectory, 'update.lock')), false, '更新锁必须释放');
        assert.deepStrictEqual(fs.readdirSync(temporaryDirectory), [], '更新临时目录必须清理');

        createFixture(packageRoot, '1.0.3');
        let badChecksumNpmCalled = false;
        const badChecksum = Buffer.from(`${'0'.repeat(64)}  ${tgzName}\n`);
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(releaseMetadata('1.1.0', tgz, badChecksum), []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? badChecksum : tgz);
            },
            execFile: async () => {
                badChecksumNpmCalled = true;
                return { stdout: '', stderr: '' };
            },
        }), /SHA256 校验失败/);
        assert.strictEqual(badChecksumNpmCalled, false, '校验失败不得调用 npm');
        assert.strictEqual(fs.existsSync(path.join(stateDirectory, 'update.lock')), false);

        const sameVersionMetadata = releaseMetadata('1.0.3', tgz, Buffer.from(`${digest}\n`));
        // 元数据大小必须与真实下载内容独立；无更新时根本不下载。
        let noUpdateSideEffect = false;
        const noUpdate = await update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(sameVersionMetadata, []),
            downloadHttpsFile: async () => { noUpdateSideEffect = true; },
            execFile: async () => { noUpdateSideEffect = true; return { stdout: '', stderr: '' }; },
        });
        assert.strictEqual(noUpdate.installed, false);
        assert.strictEqual(noUpdateSideEffect, false);

        let releaseDriftSideEffect = false;
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async () => { releaseDriftSideEffect = true; },
            execFile: async () => {
                releaseDriftSideEffect = true;
                return { stdout: '', stderr: '' };
            },
        }, { minimumVersion: '1.1.1' }), /低于本次更新允许的最低版本 1\.1\.1/);
        assert.strictEqual(releaseDriftSideEffect, false,
            '二次 Release 查询降级时必须在下载和 npm 操作前失败');
        assert.strictEqual(fs.existsSync(path.join(stateDirectory, 'update.lock')), false);

        const forceNpmCalls = [];
        const unsafeMarkerPath = path.join(stateDirectory, update.UNSAFE_INSTALL_MARKER_FILE);
        fs.mkdirSync(stateDirectory, { recursive: true });
        fs.writeFileSync(unsafeMarkerPath, JSON.stringify({ backupPath: 'fixture' }));
        assert.throws(
            () => update.assertInstallationSafeToStart({ stateDirectory }),
            /未完成恢复/
        );
        const forced = await update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(sameVersionMetadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? Buffer.from(`${digest}\n`) : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.0.3', forceNpmCalls),
        }, { force: true });
        assert.strictEqual(forced.installed, true, '--force 应允许重新安装相同版本');
        assert.strictEqual(forceNpmCalls.filter(call => call.args.includes('install')).length, 1);
        assert.strictEqual(fs.existsSync(unsafeMarkerPath), false, '成功更新必须清除不安全安装标记');
        assert.doesNotThrow(() => update.assertInstallationSafeToStart({ stateDirectory }));

        const preexistingMarker = JSON.stringify({
            backupPath: 'preexisting-unsafe-backup.tgz',
            reason: 'previous recovery was not completed',
        });
        fs.writeFileSync(unsafeMarkerPath, preexistingMarker);
        createFixture(packageRoot, '1.0.3');
        const blockedRollbackCalls = [];
        const blockedRollbackError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(sameVersionMetadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? Buffer.from(`${digest}\n`) : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.0.3', blockedRollbackCalls, {
                failInstallAfterMutation: true,
            }),
        }, { force: true }));
        assert(blockedRollbackError instanceof update.UpdateInstallError);
        assert.strictEqual(blockedRollbackError.rollbackSucceeded, true);
        assert.strictEqual(
            blockedRollbackError.serviceSafeToRestore,
            false,
            '既有未验证标记存在时，即使回滚版本自检通过也不得恢复服务'
        );
        assert.match(blockedRollbackError.message, /已保留该标记且不会恢复服务/);
        assert.strictEqual(
            fs.readFileSync(unsafeMarkerPath, 'utf8'),
            preexistingMarker,
            '失败回滚不得删除或改写更新前已有的持久阻断标记'
        );
        assert.strictEqual(fixtureVersion(packageRoot), '1.0.3');
        assert.strictEqual(blockedRollbackCalls.filter(call => call.args.includes('install')).length, 2);
        fs.unlinkSync(unsafeMarkerPath);

        createFixture(packageRoot, '1.0.3');
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', [], {
                packageName: 'unexpected-package',
            }),
        }), /包标识不匹配/);

        createFixture(packageRoot, '1.0.3');
        const badManifestCalls = [];
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', badManifestCalls, {
                writeInstalledVersion: false,
            }),
        }), /新安装包不是有效的 anti-quota@1\.1\.0/);
        assert.strictEqual(fixtureVersion(packageRoot), '1.0.3', 'manifest 校验失败后必须恢复旧版本');
        assert.strictEqual(badManifestCalls.filter(call => call.args.includes('install')).length, 2);
        assert.strictEqual(badManifestCalls.filter(call => call.args.includes('version')).length, 1);

        createFixture(packageRoot, '1.0.3');
        const mismatchedPrefixCalls = [];
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', mismatchedPrefixCalls, {
                npmRoot: path.join(scratch, 'different-global', 'node_modules'),
            }),
        }), /全局包目录与当前 CLI 安装位置不一致/);
        assert.strictEqual(
            mismatchedPrefixCalls.some(call => call.args.includes('install')),
            false,
            'npm root 与当前 CLI prefix 不一致时不得安装'
        );

        createFixture(packageRoot, '1.0.3');
        const badBinCalls = [];
        const badBinError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', badBinCalls, {
                installedManifest: {
                    bin: {
                        anti: './out/cli/other.js',
                        'anti-quota': './out/cli/cli.js',
                        aq: './out/cli/cli.js',
                    },
                },
            }),
        }));
        assert.match(badBinError.message, /bin\.anti 未指向 out\/cli\/cli\.js/);
        assert(badBinError instanceof update.UpdateInstallError);
        assert.strictEqual(badBinError.rollbackSucceeded, true);
        assert.strictEqual(badBinError.serviceSafeToRestore, true);
        assert.strictEqual(badBinError.backupPath, undefined);
        assert.strictEqual(fixtureVersion(packageRoot), '1.0.3', 'bad bin 后必须恢复旧版本');
        assert.strictEqual(
            badBinCalls.filter(call => call.args.includes('install')).length,
            2,
            'bad bin 后必须通过备份 TGZ 回滚'
        );
        assert.strictEqual(
            badBinCalls.filter(call => call.args.includes('version')).length,
            1,
            'bad bin 在新入口 smoke 前失败，但必须 smoke 校验回滚版本'
        );

        createFixture(packageRoot, '1.0.3');
        const missingEntryCalls = [];
        const missingEntryError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', missingEntryCalls, {
                writeInstalledEntry: false,
            }),
        }));
        assert.match(missingEntryError.message, /新安装的 CLI 入口不存在/);
        assert.strictEqual(missingEntryError.rollbackSucceeded, true);
        assert.strictEqual(missingEntryError.serviceSafeToRestore, true);
        assert.strictEqual(fixtureVersion(packageRoot), '1.0.3', '入口缺失后必须恢复旧版本');
        assert(fs.statSync(path.join(packageRoot, 'out', 'cli', 'cli.js')).isFile());
        assert.strictEqual(missingEntryCalls.filter(call => call.args.includes('install')).length, 2);
        assert.strictEqual(missingEntryCalls.filter(call => call.args.includes('version')).length, 1);

        createFixture(packageRoot, '1.0.3');
        const smokeMismatchCalls = [];
        const smokeMismatchError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', smokeMismatchCalls, {
                smokeVersion: '1.0.3',
            }),
        }));
        assert.match(smokeMismatchError.message, /CLI 自检版本不匹配/);
        assert.strictEqual(smokeMismatchError.rollbackSucceeded, true);
        assert.strictEqual(smokeMismatchError.serviceSafeToRestore, true);
        assert.strictEqual(fixtureVersion(packageRoot), '1.0.3', 'smoke 不匹配后必须恢复旧版本');
        assert.strictEqual(smokeMismatchCalls.filter(call => call.args.includes('install')).length, 2);
        assert.strictEqual(
            smokeMismatchCalls.filter(call => call.args.includes('version')).length,
            2,
            '必须分别 smoke 新版本和恢复后的旧版本'
        );

        createFixture(packageRoot, '1.0.3');
        const interruptedInstallCalls = [];
        const interruptedInstallError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', interruptedInstallCalls, {
                failInstallAfterMutation: true,
            }),
        }));
        assert.match(interruptedInstallError.message, /simulated npm install failure after mutation/);
        assert.strictEqual(interruptedInstallError.rollbackSucceeded, true);
        assert.strictEqual(interruptedInstallError.serviceSafeToRestore, true);
        assert.strictEqual(fixtureVersion(packageRoot), '1.0.3', 'npm 中途失败后必须恢复旧版本');
        assert.strictEqual(interruptedInstallCalls.filter(call => call.args.includes('install')).length, 2);
        assert.strictEqual(interruptedInstallCalls.filter(call => call.args.includes('version')).length, 1);

        createFixture(packageRoot, '1.0.3');
        const rollbackFailureCalls = [];
        const rollbackFailureError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', rollbackFailureCalls, {
                failInstallAfterMutation: true,
                rollbackInstallFailure: true,
            }),
        }));
        assert(rollbackFailureError instanceof update.UpdateInstallError);
        assert.strictEqual(rollbackFailureError.rollbackSucceeded, false);
        assert.strictEqual(rollbackFailureError.serviceSafeToRestore, false);
        assert.match(rollbackFailureError.message, /自动回滚旧版本 1\.0\.3 失败/);
        assert.match(rollbackFailureError.message, /可恢复备份已保留/);
        assert.strictEqual(typeof rollbackFailureError.backupPath, 'string');
        assert(fs.statSync(rollbackFailureError.backupPath).isFile(), '回滚失败时必须保留备份 TGZ');
        assert.strictEqual(fs.existsSync(unsafeMarkerPath), true, '回滚失败必须写入持久启动阻断标记');
        assert.throws(
            () => update.assertInstallationSafeToStart({ stateDirectory }),
            /未完成恢复/
        );
        assert.strictEqual(fs.existsSync(path.join(stateDirectory, 'update.lock')), false, '回滚失败也必须释放更新锁');
        // 回滚失败用例故意留下损坏目录；重建夹具后再执行其余相互独立的元数据测试。
        createFixture(packageRoot, '1.0.3');

        const rollbackSmokeFailureError = await captureRejection(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            requestHttps: fakeRequest(metadata, []),
            downloadHttpsFile: async (url, destination) => {
                fs.writeFileSync(destination, url.endsWith('.sha256') ? checksum : tgz);
            },
            execFile: fakeNpmExecutor(packageRoot, '1.1.0', [], {
                smokeVersion: '1.0.3',
                rollbackSmokeVersion: '0.0.0',
            }),
        }));
        assert.strictEqual(rollbackSmokeFailureError.rollbackSucceeded, false);
        assert.strictEqual(rollbackSmokeFailureError.serviceSafeToRestore, false);
        assert.match(rollbackSmokeFailureError.message, /回滚错误: 新安装的 CLI 自检版本不匹配/);
        assert(fs.statSync(rollbackSmokeFailureError.backupPath).isFile(), '回滚校验失败也必须保留备份 TGZ');
        createFixture(packageRoot, '1.0.3');

        const newerPackageRoot = path.join(scratch, 'newer-installed-package');
        createFixture(newerPackageRoot, '2.0.0');
        let downgradeSideEffect = false;
        await assert.rejects(update.installLatestUpdate({
                packageRoot: newerPackageRoot,
                stateDirectory,
                temporaryDirectory,
                requestHttps: fakeRequest(metadata, []),
                downloadHttpsFile: async () => { downgradeSideEffect = true; },
                execFile: async () => { downgradeSideEffect = true; return { stdout: '', stderr: '' }; },
            }, { force: true }),
            /已拒绝自动降级/
        );
        assert.strictEqual(downgradeSideEffect, false);

        fs.mkdirSync(stateDirectory, { recursive: true });
        fs.writeFileSync(path.join(stateDirectory, 'update.lock'), JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
            token: 'active-test-lock',
        }));
        assert.throws(
            () => update.assertNoUpdateInProgress({ stateDirectory }),
            /已有 Anti Quota 更新正在进行/
        );
        let lockNetworkCalled = false;
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            requestHttps: async () => { lockNetworkCalled = true; throw new Error('unexpected'); },
        }), /已有 Anti Quota 更新正在进行/);
        assert.strictEqual(lockNetworkCalled, false, '发现活动更新锁后不得发起网络请求');
        fs.unlinkSync(path.join(stateDirectory, 'update.lock'));
        assert.doesNotThrow(() => update.assertNoUpdateInProgress({ stateDirectory }));

        let releaseFirstLock;
        let firstLockAcquired;
        const firstLockReady = new Promise(resolve => { firstLockAcquired = resolve; });
        const firstLockGate = new Promise(resolve => { releaseFirstLock = resolve; });
        const firstLock = update.withUpdateLock({ stateDirectory }, async () => {
            firstLockAcquired();
            await firstLockGate;
        });
        await firstLockReady;
        await assert.rejects(
            update.withUpdateLock({ stateDirectory }, async () => undefined),
            /已有 Anti Quota 更新正在进行/
        );
        releaseFirstLock();
        await firstLock;

        const missingReleaseLockState = path.join(scratch, 'missing-release-lock-state');
        await assert.rejects(update.withUpdateLock({ stateDirectory: missingReleaseLockState }, async () => {
            fs.unlinkSync(path.join(missingReleaseLockState, 'update.lock'));
        }), /事务锁在释放前丢失/);

        const replacedReleaseLockState = path.join(scratch, 'replaced-release-lock-state');
        await assert.rejects(update.withUpdateLock({ stateDirectory: replacedReleaseLockState }, async () => {
            fs.writeFileSync(path.join(replacedReleaseLockState, 'update.lock'), JSON.stringify({
                pid: process.pid,
                createdAt: Date.now(),
                token: 'replacement-owner',
            }));
        }), /事务锁所有权已变化/);
        fs.unlinkSync(path.join(replacedReleaseLockState, 'update.lock'));

        const missingRetainedLockState = path.join(scratch, 'missing-retained-lock-state');
        await assert.rejects(update.withUpdateLock({ stateDirectory: missingRetainedLockState }, async () => {
            fs.unlinkSync(path.join(missingRetainedLockState, 'update.lock'));
            throw new update.UpdateInstallError(
                '需要保留更新锁',
                false,
                false,
                undefined,
                undefined,
                undefined,
                true
            );
        }), /事务锁在释放前丢失/);

        // 确定性覆盖原竞态：服务在门禁内完成 listen 之前，更新器不能发布 update.lock。
        const startupRaceState = path.join(scratch, 'startup-race-state');
        let releaseStartup;
        let startupEntered;
        let serviceListening = false;
        let updateEntered = false;
        const startupReady = new Promise(resolve => { startupEntered = resolve; });
        const startupBarrier = new Promise(resolve => { releaseStartup = resolve; });
        const startingService = update.withServiceStartupGate({ stateDirectory: startupRaceState }, async () => {
            startupEntered();
            await startupBarrier;
            serviceListening = true;
        });
        await startupReady;
        const racingUpdate = update.withUpdateLock({ stateDirectory: startupRaceState }, async () => {
            updateEntered = true;
            assert.strictEqual(serviceListening, true, '更新锁只能在服务完成 listen 后发布');
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(updateEntered, false, '更新器必须等待正在启动的服务释放门禁');
        assert.strictEqual(
            fs.existsSync(path.join(startupRaceState, 'update.lock')),
            false,
            '服务完成 listen 前不得出现 update.lock'
        );
        releaseStartup();
        await startingService;
        await racingUpdate;

        // 反向次序同样关闭：更新器先发布锁后，普通服务只能在门禁内看到锁并拒绝。
        const updateFirstState = path.join(scratch, 'update-first-state');
        let releaseUpdate;
        let updateLockPublished;
        const updateLockReady = new Promise(resolve => { updateLockPublished = resolve; });
        const updateBarrier = new Promise(resolve => { releaseUpdate = resolve; });
        const updateFirst = update.withUpdateLock({ stateDirectory: updateFirstState }, async () => {
            assert.strictEqual(fs.existsSync(path.join(updateFirstState, 'update.lock')), true);
            updateLockPublished();
            await updateBarrier;
        });
        await updateLockReady;
        await assert.rejects(
            update.withServiceStartupGate({ stateDirectory: updateFirstState }, async () => {
                update.assertNoUpdateInProgress({ stateDirectory: updateFirstState });
            }),
            /更新正在进行/
        );
        releaseUpdate();
        await updateFirst;

        const retainedLockState = path.join(scratch, 'retained-lock-state');
        await assert.rejects(update.withUpdateLock({ stateDirectory: retainedLockState }, async () => {
            throw new update.UpdateInstallError(
                '无法写入持久阻断标记',
                false,
                false,
                undefined,
                undefined,
                undefined,
                true
            );
        }), /无法写入持久阻断标记/);
        const retainedLockPath = path.join(retainedLockState, 'update.lock');
        assert.strictEqual(
            fs.existsSync(retainedLockPath),
            true,
            '持久阻断标记无法写入时必须保留 update.lock'
        );
        fs.unlinkSync(retainedLockPath);

        // 不自动删除陈旧锁，避免检查与删除之间误删另一个进程刚取得的新锁。
        fs.writeFileSync(path.join(stateDirectory, 'update.lock'), JSON.stringify({
            pid: 424242,
            createdAt: 1,
            token: 'stale-test-lock',
        }));
        await assert.rejects(update.installLatestUpdate({
            packageRoot,
            stateDirectory,
            temporaryDirectory,
            now: () => 2 * 60 * 60 * 1000,
            isProcessAlive: () => false,
            requestHttps: fakeRequest(sameVersionMetadata, []),
            downloadHttpsFile: async () => { throw new Error('unexpected download'); },
            execFile: async () => { throw new Error('unexpected npm'); },
        }), /异常退出遗留的更新锁/);
        assert.strictEqual(fs.existsSync(path.join(stateDirectory, 'update.lock')), true);
        fs.unlinkSync(path.join(stateDirectory, 'update.lock'));

        const developmentRoot = path.join(scratch, 'development');
        createFixture(developmentRoot);
        fs.mkdirSync(path.join(developmentRoot, '.git'));
        assert.strictEqual(update.detectInstallationKind({ packageRoot: developmentRoot }), 'development-checkout');
        await assert.rejects(update.installLatestUpdate({ packageRoot: developmentRoot }), /Git 开发工作区/);

        const linkTarget = path.join(scratch, 'link-target');
        const linkedRoot = path.join(scratch, 'linked-package');
        createFixture(linkTarget);
        fs.symlinkSync(linkTarget, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
        assert.strictEqual(update.detectInstallationKind({ packageRoot: linkedRoot }), 'npm-link');
        assert.throws(() => update.assertUpdatableInstallation({ packageRoot: linkedRoot }), /npm link/);

        const duplicateMetadata = releaseMetadata('1.1.0', tgz, checksum);
        duplicateMetadata.assets.push({ ...duplicateMetadata.assets[0] });
        await assert.rejects(update.checkForUpdate({
            packageRoot,
            requestHttps: fakeRequest(duplicateMetadata, []),
        }), /必须且只能包含一组/);

        const wrongHostMetadata = releaseMetadata('1.1.0', tgz, checksum);
        wrongHostMetadata.assets[0].browser_download_url = 'https://example.com/anti-quota-1.1.0.tgz';
        await assert.rejects(update.checkForUpdate({
            packageRoot,
            requestHttps: fakeRequest(wrongHostMetadata, []),
        }), /不受信任/);

        const prereleaseMetadata = releaseMetadata('1.1.0', tgz, checksum, { prerelease: true });
        await assert.rejects(update.checkForUpdate({
            packageRoot,
            requestHttps: fakeRequest(prereleaseMetadata, []),
        }), /预发布/);

        console.log('update regression tests passed');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
