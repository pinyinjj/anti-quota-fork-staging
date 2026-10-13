'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const diagnosticArtifacts = [
    'trajectory_blob.b64',
    'analyze_blob.py',
    'debug_reset_time.js',
    'simulate_restore.js',
    'verify_extraction.js',
    'test_restore.ts',
    'docs/bugment-custom-panel.html',
];

const packageOnlyExclusions = [
    ...diagnosticArtifacts,
    'scripts/release.sh',
];

const requiredRuntimeFiles = [
    'package.json',
    'out/cli/cli.js',
    'out/cli/service.js',
    'out/cli/update.js',
    'out/cli/windowsService.js',
    'native/windows/AntiQuotaService.exe',
    'native/windows/Install-Service.ps1',
    'out/extension.js',
    'resources/activity-icon.svg',
    'resources/icon.png',
    'resources/sidebar-icon.svg',
    'scripts/sqlite3.exe',
    'scripts/switch_account.js',
    'scripts/update_windows_keyring.ps1',
    'THIRD_PARTY_NOTICES.txt',
    'node_modules/https-proxy-agent/package.json',
    'node_modules/proxy-from-env/index.js',
    'node_modules/socks-proxy-agent/package.json',
];

const privatePathPatterns = [
    /(^|\/)\.env(?:\.|$)/i,
    /(^|\/)\.anti-quota(?:\/|$)/i,
    /\.b64$/i,
    /\.(?:pem|key|p12|pfx)$/i,
    /(^|\/)(?:accounts\.json|accounts\.latest\.json|service-token|state_backup\.json|unsafe-install\.json)$/i,
    /(^|\/)scm-update-restore\.json$/i,
    /(^|\/)oauth-client\.json$/i,
    /(^|\/)accounts(?:\.latest)?\.json(?:\.[^/]*)?\.tmp$/i,
    /(^|\/)accounts-[^/]+\.json(?:\.[^/]*)?\.tmp$/i,
    /(^|\/)antigravity-oauth-token(?:\.tmp-[^/]+)?$/i,
    /(^|\/)(?:\.accounts\.lock|service\.pid|switch_pending\.json|update\.lock)$/i,
    /(^|\/)service-start\.lock(?:\.(?:release|stale)-[^/]+)?(?:\/|$)/i,
    /(^|\/)backups(?:\/|$)/i,
];

const ignoredPrivateFixtures = [
    '.accounts.lock',
    '.anti-quota/accounts.json',
    'accounts.json.tmp',
    'accounts.json.123.456.random.tmp',
    'accounts.latest.json',
    'accounts.latest.json.123.456.random.tmp',
    'backups/accounts-20261012T101112Z-123.json.123.456.random.tmp',
    'backups/account-2026.json',
    '.gemini/antigravity-cli/antigravity-oauth-token',
    '.gemini/antigravity-cli/antigravity-oauth-token.tmp-123',
    'oauth-client.json',
    'nested/oauth-client.json',
    'service.pid',
    'service-start.lock',
    'service-start.lock/owner.json',
    'service-start.lock.release-123-token/owner.json',
    'service-start.lock.stale-123-token/owner.json',
    'switch_pending.json',
    'update.lock',
    'unsafe-install.json',
    'scm-update-restore.json',
];

const requiredPackageIgnoreRules = new Map([
    ['.npmignore', '**/oauth-client.json'],
    ['.vscodeignore', '**/oauth-client.json'],
]);

const SQLITE3_SHA256 = '3cf89763987cb010fbb888c17a0a431ad9b827918b1d6d6e7941704393d7aca4';

function normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        ...options,
    });

    if (result.error) {
        throw new Error(`${options.label || command} could not be started: ${result.error.code || result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${options.label || command} failed with exit code ${result.status}`);
    }

    return result.stdout;
}

function nulSeparatedPaths(output) {
    return output
        .split('\0')
        .filter(Boolean)
        .map(normalizePath);
}

function assertNoPrivatePaths(files, packageName) {
    const normalized = new Set(files.map(normalizePath));

    for (const blockedPath of packageOnlyExclusions) {
        assert(
            !normalized.has(blockedPath),
            `${packageName} must not contain ${blockedPath}`,
        );
    }

    for (const filePath of normalized) {
        assert(
            !privatePathPatterns.some((pattern) => pattern.test(filePath)),
            `${packageName} contains a private-state path that must be excluded`,
        );
    }

    for (const requiredPath of requiredRuntimeFiles) {
        assert(
            normalized.has(requiredPath),
            `${packageName} must retain runtime file ${requiredPath}`,
        );
    }
}

function assertDiagnosticArtifactsRemoved() {
    const tracked = new Set(nulSeparatedPaths(run(
        'git',
        ['ls-files', '--cached', '-z', '--', ...diagnosticArtifacts],
        { label: 'git tracked-file check' },
    )));
    const deleted = new Set(nulSeparatedPaths(run(
        'git',
        ['ls-files', '--deleted', '-z', '--', ...diagnosticArtifacts],
        { label: 'git deleted-file check' },
    )));

    for (const filePath of diagnosticArtifacts) {
        assert(
            !fs.existsSync(path.join(root, filePath)),
            `${filePath} must not exist in the working tree`,
        );
        assert(
            !tracked.has(filePath) || deleted.has(filePath),
            `${filePath} must not remain as an active tracked file`,
        );

        run(
            'git',
            ['check-ignore', '--no-index', '--quiet', '--', filePath],
            { label: `ignore rule for ${filePath}` },
        );
    }

    for (const filePath of ignoredPrivateFixtures) {
        run(
            'git',
            ['check-ignore', '--no-index', '--quiet', '--', filePath],
            { label: `ignore rule for ${filePath}` },
        );
    }
}

function assertPrivatePackageIgnoreRules() {
    for (const [ignoreFile, expectedRule] of requiredPackageIgnoreRules) {
        const rules = fs.readFileSync(path.join(root, ignoreFile), 'utf8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        assert(
            rules.includes(expectedRule),
            `${ignoreFile} must exclude ${expectedRule}`,
        );
    }
}

function assertTrustedSqliteBinary() {
    const executable = fs.readFileSync(path.join(root, 'scripts', 'sqlite3.exe'));
    const digest = crypto.createHash('sha256').update(executable).digest('hex');
    assert.strictEqual(
        digest,
        SQLITE3_SHA256,
        'scripts/sqlite3.exe must remain byte-for-byte identical to the audited official SQLite 3.47.0 binary',
    );

    const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert(notice.includes(SQLITE3_SHA256), 'third-party notice must record the audited sqlite3.exe SHA-256');
    assert(
        notice.includes('https://www.sqlite.org/2024/sqlite-tools-win-x64-3470000.zip'),
        'third-party notice must identify the official SQLite archive',
    );
}

function npmPackFiles() {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-package-privacy-'));
    const npmCliCandidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        '/usr/share/nodejs/npm/bin/npm-cli.js',
    ].filter(Boolean);
    const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate));

    assert(npmCli, 'Could not locate npm-cli.js for the package privacy check');

    try {
        const output = run(
            process.execPath,
            [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'],
            {
                label: 'npm pack privacy listing',
                env: {
                    ...process.env,
                    npm_config_audit: 'false',
                    npm_config_cache: path.join(temporaryDirectory, 'npm-cache'),
                    npm_config_fund: 'false',
                    npm_config_update_notifier: 'false',
                },
            },
        );
        const manifest = JSON.parse(output);
        assert(Array.isArray(manifest) && manifest.length === 1, 'npm pack must return one package manifest');
        return manifest[0].files.map((entry) => entry.path);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function vsixFiles() {
    const vsceCli = require.resolve('@vscode/vsce/vsce');
    return run(
        process.execPath,
        [vsceCli, 'ls'],
        { label: 'VSIX privacy listing' },
    )
        .split(/\r?\n/)
        .filter(Boolean);
}

assertDiagnosticArtifactsRemoved();
assertPrivatePackageIgnoreRules();
assertTrustedSqliteBinary();
assertNoPrivatePaths(npmPackFiles(), 'npm package');
assertNoPrivatePaths(vsixFiles(), 'VSIX package');

console.log('Package privacy regression checks passed.');
