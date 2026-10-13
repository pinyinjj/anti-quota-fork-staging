const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-storage-test-'));
process.env.ANTI_QUOTA_DATA_DIR = testDirectory;

const storage = require('../out/services/accountStorage');

function account(id, email, updated = 1) {
    return {
        id,
        email,
        token: {
            access_token: `access-${id}-${updated}`,
            refresh_token: `refresh-${id}`,
            expires_in: 3600,
            expiry_timestamp: updated,
            token_type: 'Bearer'
        },
        quota: {
            models: [{ name: 'gemini-pro', percentage: updated }],
            last_updated: updated
        },
        created_at: 1,
        last_used: updated,
        priority: 0
    };
}

function runConcurrentWriter(id) {
    const modulePath = path.resolve(__dirname, '../out/services/accountStorage.js');
    const source = `
        const storage = require(${JSON.stringify(modulePath)});
        const id = ${JSON.stringify(id)};
        for (let version = 1; version <= 5; version++) {
            storage.mergeAccounts([{
                id,
                email: id + '@example.com',
                token: {
                    access_token: 'access-' + id + '-' + version,
                    refresh_token: 'refresh-' + id,
                    expires_in: 3600,
                    expiry_timestamp: version,
                    token_type: 'Bearer'
                },
                created_at: 1,
                last_used: version,
                priority: 0
            }]);
        }
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', source], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${id} failed (${code}): ${stderr}`)));
    });
}

(async () => {
try {
    assert.strictEqual(storage.hasAccountStorage(), false, '全新目录不应被识别为已有存储');

    storage.mutateAccounts(() => [account('a', 'a@example.com'), account('b', 'b@example.com')]);
    assert.strictEqual(storage.hasAccountStorage(), true);

    // 模拟旧窗口持有两账号快照，另一个进程已经新增第三个账号。
    const staleSnapshot = storage.readAccounts();
    storage.mergeAccounts([account('c', 'c@example.com', 2)]);
    staleSnapshot[0] = account('a', 'a@example.com', 3);
    const merged = storage.mergeAccounts(staleSnapshot);
    assert.deepStrictEqual(merged.map(item => item.id).sort(), ['a', 'b', 'c'], '旧快照不得删掉新账号');

    // 更旧的配额和 token 不得覆盖更新数据。
    const afterOldUpdate = storage.mergeAccounts([account('a', 'a@example.com', 2)]);
    const savedA = afterOldUpdate.find(item => item.id === 'a');
    assert.strictEqual(savedA.token.expiry_timestamp, 3);
    assert.strictEqual(savedA.quota.last_updated, 3);

    // 多个真实 Node 进程同时写入不同账号，最终必须全部保留且主文件始终可解析。
    const workerIds = ['worker-1', 'worker-2', 'worker-3', 'worker-4'];
    await Promise.all(workerIds.map(runConcurrentWriter));
    const afterConcurrentWrites = storage.readAccounts();
    for (const id of workerIds) {
        assert(afterConcurrentWrites.some(item => item.id === id), `并发写入丢失账号 ${id}`);
    }

    // 主文件截断时应从 latest 备份读取，且不能返回空数组。
    fs.writeFileSync(storage.getStoragePath(), '[{"broken":');
    assert.strictEqual(storage.readAccounts().length, 7, '主文件损坏时应读取备份');

    // 下一次修改会在锁内用备份恢复主文件。
    storage.mergeAccounts([account('d', 'd@example.com', 4)]);
    assert.strictEqual(JSON.parse(fs.readFileSync(storage.getStoragePath(), 'utf8')).length, 8);

    // 主文件与备份同时损坏时必须显式报错，绝不能伪装成零账号。
    fs.writeFileSync(storage.getStoragePath(), '{bad');
    fs.writeFileSync(path.join(testDirectory, 'accounts.latest.json'), '{bad');
    assert.throws(() => storage.readAccounts(), /均损坏/);

    console.log('account storage regression tests passed');
} finally {
    fs.rmSync(testDirectory, { recursive: true, force: true });
}
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
