'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    createFindingCollector,
    inspectEntryPath,
    inspectText,
} = require('./archive-privacy-regression');

const root = path.resolve(__dirname, '..');
const result = spawnSync('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
});

assert.ifError(result.error);
assert.strictEqual(result.status, 0, 'git ls-files failed during repository privacy scan');

const collector = createFindingCollector();
const files = result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();

for (const relativePath of files) {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const absolutePath = path.resolve(root, relativePath);
    assert(
        absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`),
        'git returned a path outside the repository root'
    );

    // Deleted-but-not-yet-staged files can still appear in the index while preparing a cleanup commit.
    if (!fs.existsSync(absolutePath)) continue;
    const stats = fs.lstatSync(absolutePath);
    assert(!stats.isSymbolicLink(), `repository must not publish symlink: ${normalizedPath}`);
    if (!stats.isFile()) continue;

    inspectEntryPath('repository', normalizedPath, collector);
    inspectText('repository', normalizedPath, fs.readFileSync(absolutePath), collector);
}

const findings = collector.all();
if (findings.length > 0) {
    for (const finding of findings) {
        console.error(JSON.stringify({ entry: finding.entry, category: finding.category }));
    }
}
assert.deepStrictEqual(findings, [], 'repository privacy scan found publish-blocking content');

console.log(`Repository privacy regression checks passed for ${files.length} candidate files.`);
