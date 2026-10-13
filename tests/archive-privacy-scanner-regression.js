'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    createFindingCollector,
    inspectEntryPath,
    inspectText,
    shouldInspectEntryContent,
} = require('./archive-privacy-regression');

const pathCollector = createFindingCollector();
inspectEntryPath('fixture.tgz', 'package/scm-update-restore.json', pathCollector);
assert(pathCollector.all().some(finding => finding.category === 'account-state-path'),
    'Windows 服务一次性更新恢复凭证不得进入发行包');
inspectEntryPath('fixture.vsix', 'extension/docs/bugment-custom-panel.html', pathCollector);
assert(
    pathCollector.all().some(finding => finding.category === 'forbidden-diagnostic-file'),
    '历史诊断 HTML 必须始终被归档扫描拒绝'
);
inspectEntryPath('fixture.tgz', 'package/debug-session-renamed.b64', pathCollector);
assert(
    pathCollector.all().some(finding => finding.category === 'forbidden-base64-artifact'),
    '任意改名后的 .b64 诊断导出也必须被归档扫描拒绝'
);

const tokenCollector = createFindingCollector();
const entitySplitJwt = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'abcdefghijklmnopqrstuv',
].join('&#10;.');
inspectText(
    'fixture.vsix',
    'extension/docs/renamed-panel.html',
    Buffer.from(entitySplitJwt, 'utf8'),
    tokenCollector
);
assert(
    tokenCollector.all().some(finding => finding.category === 'jwt'),
    'HTML 实体分隔的 JWS/JWT 必须被检出'
);

const googleOAuthCredentialCollector = createFindingCollector();
const simulatedGoogleOAuthClientSecret = [
    'GOC',
    'SPX',
    '-',
    'A'.repeat(28),
].join('');
const simulatedGoogleOAuthClientId = [
    '1234567',
    '890123',
    '-',
    'a'.repeat(32),
    '.apps.',
    'google',
    'usercontent.com',
].join('');
inspectText(
    'fixture.tgz',
    'package/config.js',
    Buffer.from([
        simulatedGoogleOAuthClientSecret,
        simulatedGoogleOAuthClientId,
    ].join('\n'), 'utf8'),
    googleOAuthCredentialCollector
);
assert(
    googleOAuthCredentialCollector.all().some(
        finding => finding.category === 'google-oauth-client-secret'
    ),
    'Google OAuth Client Secret 必须被检出'
);
assert(
    googleOAuthCredentialCollector.all().some(
        finding => finding.category === 'google-oauth-client-id'
    ),
    'Google OAuth Client ID 必须被检出'
);

const encodedBlobCollector = createFindingCollector();
inspectText(
    'fixture.tgz',
    'package/renamed-diagnostic.txt',
    Buffer.from(`prefix\n${'A'.repeat(4096)}\nsuffix`, 'utf8'),
    encodedBlobCollector
);
assert(
    encodedBlobCollector.all().some(finding => finding.category === 'large-encoded-blob'),
    '改名为普通文本文件的超长 Base64/Base64URL 数据也必须被检出'
);

for (const entryName of [
    'extension/data/renamed-diagnostic.dat',
    'package/cache/renamed-diagnostic.blob',
    'extension/fixtures/renamed-diagnostic',
]) {
    assert(
        shouldInspectEntryContent(entryName),
        `第一方未知文件必须进入内容扫描：${entryName}`
    );
    const unknownExtensionCollector = createFindingCollector();
    inspectText(
        'fixture.vsix',
        entryName,
        Buffer.from(`metadata\n${'A'.repeat(4096)}\n`, 'utf8'),
        unknownExtensionCollector
    );
    assert(
        unknownExtensionCollector.all().some(finding => finding.category === 'large-encoded-blob'),
        `未知扩展名或无扩展名不能绕过大型编码数据检测：${entryName}`
    );
}

const binaryDependencyEntry = 'extension/node_modules/native-addon/prebuilds/win32-x64/addon.blob';
assert(
    shouldInspectEntryContent(binaryDependencyEntry),
    'node_modules 中的未知二进制依赖也必须进入敏感内容扫描'
);
const binaryDependencyCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    binaryDependencyEntry,
    Buffer.from('A'.repeat(4096), 'ascii'),
    binaryDependencyCollector
);
assert(
    binaryDependencyCollector.all().some(finding => finding.category === 'large-encoded-blob'),
    '未知二进制依赖中的大型编码数据必须被检出'
);

const binaryDependencyTokenCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/node_modules/debug/leak.bin',
    Buffer.concat([
        Buffer.from([0x00, 0xff]),
        Buffer.from(['ya29', '.', 'A'.repeat(40)].join(''), 'ascii'),
        Buffer.from([0x00]),
    ]),
    binaryDependencyTokenCollector
);
assert(
    binaryDependencyTokenCollector.all().some(finding => finding.category === 'google-access-token'),
    'node_modules 未知二进制中的 OAuth Token 必须被检出'
);

const dependencyTextCases = [
    {
        entry: 'extension/node_modules/debug/leak.js',
        value: 'A'.repeat(4096),
        category: 'large-encoded-blob',
    },
    {
        entry: 'extension/node_modules/debug/leak.txt',
        value: ['https://', 'real-user', ':', 'real-password', '@', '192.0.2.1'].join(''),
        category: 'credentialed-url',
    },
    {
        entry: 'extension/node_modules/debug/leak.md',
        value: ['private.person', '@', 'gmail.com'].join(''),
        category: 'personal-email',
    },
    {
        entry: 'extension/node_modules/debug/leak.json',
        value: ['C:', '\\', 'Users', '\\', 'private-person', '\\', 'secret.txt'].join(''),
        category: 'absolute-user-path',
    },
];
for (const fixture of dependencyTextCases) {
    const collector = createFindingCollector();
    inspectText('fixture.vsix', fixture.entry, Buffer.from(fixture.value, 'utf8'), collector);
    assert(
        collector.all().some(finding => finding.category === fixture.category),
        `node_modules 文本中的敏感内容必须被检出: ${fixture.category}`
    );
}

const auditedDependencyFile = fs.readFileSync(
    path.join(__dirname, '..', 'node_modules', 'debug', 'package.json')
);
const auditedDependencyCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/node_modules/debug/package.json',
    auditedDependencyFile,
    auditedDependencyCollector
);
assert(
    !auditedDependencyCollector.all().some(finding => finding.category === 'personal-email'),
    '精确哈希匹配的上游作者元数据应使用窄例外'
);
const tamperedDependencyCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/node_modules/debug/package.json',
    Buffer.concat([
        auditedDependencyFile,
        Buffer.from(['\n', 'private.person', '@', 'gmail.com'].join(''), 'utf8'),
    ]),
    tamperedDependencyCollector
);
assert(
    tamperedDependencyCollector.all().some(finding => finding.category === 'personal-email'),
    '上游元数据只要有任何字节变化就必须失去邮箱例外'
);
const similarPathDependencyCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/not-node_modules/debug/package.json',
    auditedDependencyFile,
    similarPathDependencyCollector
);
assert(
    similarPathDependencyCollector.all().some(finding => finding.category === 'personal-email'),
    '依赖邮箱例外必须匹配真实 node_modules 路径段'
);

const firstPartyBinaryCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/resources/cache.dat',
    Buffer.concat([Buffer.from([0x00, 0xff, 0x00, 0x80]), Buffer.from('A'.repeat(4096), 'ascii')]),
    firstPartyBinaryCollector
);
assert(
    firstPartyBinaryCollector.all().some(finding => finding.category === 'large-encoded-blob'),
    '第一方二进制中的大型编码数据必须被检出'
);

for (const privateStatePath of [
    'package/accounts.json.tmp',
    'package/accounts.json.123.456.random.tmp',
    'extension/accounts-backup.json.tmp',
    'extension/accounts.latest.json.123.456.random.tmp',
    'package/backups/accounts-20261012T101112Z-123.json.123.456.random.tmp',
    'extension/.gemini/antigravity-cli/antigravity-oauth-token',
    'extension/.gemini/antigravity-cli/antigravity-oauth-token.tmp-123',
    'extension/.anti-quota/oauth-client.json',
    'package/config/oauth-client.json',
    'extension/service-start.lock.release-123-token/owner.json',
    'package/service-start.lock.stale-123-token/owner.json',
]) {
    const privateStateCollector = createFindingCollector();
    inspectEntryPath('fixture.tgz', privateStatePath, privateStateCollector);
    assert(
        privateStateCollector.all().some(finding => finding.category === 'account-state-path'),
        `运行时临时状态必须被归档扫描拒绝: ${privateStatePath}`
    );
}

const wrappedBase64 = Array.from({ length: 60 }, () => 'A'.repeat(76)).join('\r\n');
for (const fixture of [
    { entry: 'extension/renamed-diagnostic.txt', prefix: Buffer.alloc(0) },
    { entry: 'extension/renamed-diagnostic.dat', prefix: Buffer.from([0x00, 0xff]) },
    { entry: 'extension/node_modules/debug/renamed-diagnostic.bin', prefix: Buffer.from([0x00]) },
]) {
    const collector = createFindingCollector();
    inspectText(
        'fixture.vsix',
        fixture.entry,
        Buffer.concat([fixture.prefix, Buffer.from(wrappedBase64, 'ascii')]),
        collector
    );
    assert(
        collector.all().some(finding => finding.category === 'large-encoded-blob'),
        `换行 Base64 不能绕过大型编码数据检测: ${fixture.entry}`
    );
}

for (const wrappedVariant of [
    Array.from({ length: 180 }, () => 'A'.repeat(12)).join('\r\n'),
    Array.from({ length: 60 }, () => 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA A').join('\r\n'),
    Array.from({ length: 400 }, () => 'AAAA==').join('\r\n'),
]) {
    const collector = createFindingCollector();
    inspectText(
        'fixture.vsix',
        'extension/renamed-wrapped-diagnostic.txt',
        Buffer.from(wrappedVariant, 'ascii'),
        collector
    );
    assert(
        collector.all().some(finding => finding.category === 'large-encoded-blob'),
        '短行、行内空格或独立 padding 块不能绕过大型编码数据检测'
    );
}

const fragmentedBase64Cases = [
    {
        entry: 'extension/quoted-base64-array.json',
        value: `[\n${Array.from({ length: 60 }, () => `  "${'A'.repeat(76)}"`).join(',\n')}\n]`,
        message: 'JSON 数组中逐行带引号的 76 字符 Base64 分片不能绕过检测',
    },
    {
        entry: 'extension/quoted-base64-lines.txt',
        value: Array.from({ length: 60 }, () => `"${'A'.repeat(76)}"`).join('\r\n'),
        message: '逐行带引号的 76 字符 Base64 分片不能绕过检测',
    },
    {
        entry: 'extension/short-quoted-base64-array.json',
        value: JSON.stringify([
            ...Array.from({ length: 180 }, () => 'A'.repeat(12)),
            'A'.repeat(8),
        ]),
        message: 'JSON 数组中的短 Base64 分片及较短尾段不能绕过检测',
    },
    {
        entry: 'extension/single-quoted-base64.js',
        value: Array.from({ length: 30 }, () => `'${'A'.repeat(76)}'`).join(' +\n'),
        message: '单引号包裹并拼接的 Base64 分片不能绕过检测',
    },
    {
        entry: 'extension/template-base64.ts',
        value: [
            ...Array.from({ length: 28 }, () => `\`${'A'.repeat(76)}\``),
            `\`${'A'.repeat(8)}\``,
        ].join(' +\n'),
        message: '反引号模板字符串中的 Base64 分片及较短尾段不能绕过检测',
    },
    {
        entry: 'extension/entity-wrapped-base64.html',
        value: `<pre>${Array.from({ length: 28 }, () => 'A'.repeat(76)).join('&#10;')}</pre>`,
        message: 'HTML 换行实体分隔的 Base64 分片不能绕过检测',
    },
    {
        entry: 'extension/form-feed-wrapped-base64.txt',
        value: `prefix:${Array.from({ length: 28 }, () => 'A'.repeat(76)).join('\f')}:suffix`,
        message: 'form-feed 分隔的 Base64 分片不能绕过检测',
    },
    {
        entry: 'extension/markdown-wrapped-base64.md',
        value: Array.from({ length: 28 }, () => `# ${'A'.repeat(76)}`).join('\n'),
        message: 'Markdown 行前缀不能绕过 Base64 分片检测',
    },
];
for (const fixture of fragmentedBase64Cases) {
    const collector = createFindingCollector();
    inspectText(
        'fixture.vsix',
        fixture.entry,
        Buffer.from(fixture.value, 'ascii'),
        collector
    );
    assert(
        collector.all().some(finding => finding.category === 'large-encoded-blob'),
        fixture.message
    );
}

for (const [fragment, count] of [
    ['AAAAA', 411],
    ['AAAA==', 400],
]) {
    const nulFragmentedCollector = createFindingCollector();
    const nulFragmentedBase64 = Buffer.from(
        Array.from({ length: count }, () => fragment).join('\0'),
        'ascii'
    );
    inspectText(
        'fixture.vsix',
        'extension/resources/nul-fragmented.bin',
        Buffer.concat([Buffer.from([0xff, 0x01]), nulFragmentedBase64, Buffer.from([0x02])]),
        nulFragmentedCollector
    );
    assert(
        nulFragmentedCollector.all().some(finding => finding.category === 'large-encoded-blob'),
        'NUL 分隔的短 Base64 或 padding 分片不能绕过检测'
    );
}

const alternatingNulCollector = createFindingCollector();
const alternatingNulBase64 = Buffer.from(
    Array.from({ length: 190 }, (_, index) => 'A'.repeat(index % 2 === 0 ? 12 : 13)).join('\0'),
    'ascii'
);
inspectText(
    'fixture.vsix',
    'extension/resources/alternating-nul-fragmented.bin',
    Buffer.concat([Buffer.from([0xff]), alternatingNulBase64, Buffer.from([0x01])]),
    alternatingNulCollector
);
assert(
    alternatingNulCollector.all().some(finding => finding.category === 'large-encoded-blob'),
    '相邻宽度交替的 NUL Base64 分片不能绕过检测'
);

const benignFragmentCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/resources/benign-fragments.json',
    Buffer.from(JSON.stringify(Array.from({ length: 600 }, (_, index) => `item${index}`)), 'utf8'),
    benignFragmentCollector
);
assert(
    !benignFragmentCollector.all().some(finding => finding.category === 'large-encoded-blob'),
    '普通 JSON 短字符串数组不应被当作大型 Base64 载荷'
);

const benignBinaryStringsCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/resources/benign-string-table.bin',
    Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from(Array.from({ length: 500 }, () => 'alpha\0bravo6\0').join(''), 'ascii'),
        Buffer.from([0x01]),
    ]),
    benignBinaryStringsCollector
);
assert(
    !benignBinaryStringsCollector.all().some(finding => finding.category === 'large-encoded-blob'),
    '普通的非定长 NUL 终止二进制字符串表不应被误判为 Base64 载荷'
);

const binaryPathCollector = createFindingCollector();
inspectText(
    'fixture.vsix',
    'extension/scripts/untrusted-tool.exe',
    Buffer.concat([
        Buffer.from([0x4d, 0x5a, 0x00, 0xff]),
        Buffer.from([
            'C:', '\\', 'Users', '\\', 'real-person', '\\', 'build', '\\', 'private-tool.pdb',
        ].join(''), 'ascii'),
        Buffer.from([0x00, 0x01]),
    ]),
    binaryPathCollector
);
assert(
    binaryPathCollector.all().some(finding => finding.category === 'absolute-user-path'),
    '第一方二进制中的个人绝对路径必须被检出'
);

const proxyCredentialCollector = createFindingCollector();
inspectText(
    'fixture.tgz',
    'package/config.txt',
    Buffer.from([
        'HTTPS_PROXY=http://',
        'real-user',
        ':',
        'real-password',
        '@',
        '192.0.2.1:8080',
    ].join(''), 'utf8'),
    proxyCredentialCollector
);
assert(
    proxyCredentialCollector.all().some(finding => finding.category === 'credentialed-url'),
    '带密码的代理 URL 必须被检出，不能因目标是 IP 地址而被邮箱误报豁免'
);

console.log('Archive privacy scanner regression checks passed.');
