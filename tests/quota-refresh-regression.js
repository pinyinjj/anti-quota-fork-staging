const assert = require('assert');
const network = require('../out/services/networkService');
const storage = require('../out/services/accountStorage');

const originalRequestHttps = network.requestHttps;
const originalReadAccounts = storage.readAccounts;
const originalMergeAccounts = storage.mergeAccounts;
const originalLog = console.log;
const originalError = console.error;

const endpoints = [
    'daily-cloudcode-pa.sandbox.googleapis.com',
    'daily-cloudcode-pa.googleapis.com',
    'cloudcode-pa.googleapis.com',
];
const resetTime = '2026-10-22T12:00:00Z';
const nextWeek = '2026-10-29T12:00:00Z';

function quotaGroup(name, fiveHour, weekly) {
    return {
        displayName: name,
        buckets: [
            { bucketId: '5h', remainingFraction: fiveHour, resetTime },
            { bucketId: 'weekly', remainingFraction: weekly, resetTime: nextWeek },
        ],
    };
}

function quotaSummary(groups) {
    return { groups };
}

function createAccount() {
    const models = [
        { name: 'claude', displayName: 'Claude Sonnet', percentage: 18, reset_time: 'old', weekly_percentage: 42, weekly_reset_time: 'old-week' },
        { name: 'gemini-pro', displayName: 'Gemini 3 Pro', percentage: 22, reset_time: 'old', weekly_percentage: 37, weekly_reset_time: 'old-week' },
        { name: 'gemini-flash', displayName: 'Gemini 3 Flash', percentage: 22, reset_time: 'old', weekly_percentage: 37, weekly_reset_time: 'old-week' },
    ];
    return {
        id: 'test-account',
        email: 'test@example.com',
        token: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            expires_in: 3600,
            expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
            token_type: 'Bearer',
        },
        quota: { models, last_updated: 1234567890 },
        created_at: 1,
        last_used: 1,
    };
}

function response(status, data) {
    return { status, body: JSON.stringify(data) };
}

(async () => {
    let passed = false;
    try {
        let accounts = [createAccount()];
        let summaryMode = 'partial';
        network.requestHttps = async (url, options, body) => {
            const target = new URL(url);
            const requestBody = JSON.parse(String(body || '{}'));
            if (target.pathname.endsWith(':loadCodeAssist')) {
                return response(200, { cloudaicompanionProject: 'test-project' });
            }
            if (target.pathname.endsWith(':fetchAvailableModels')) {
                return response(200, { models: {
                    'claude-sonnet': { quotaInfo: { remainingFraction: 1, resetTime } },
                    'gemini-3-pro-high': { quotaInfo: { remainingFraction: 1, resetTime } },
                    'gemini-3-flash': { quotaInfo: { remainingFraction: 1, resetTime } },
                } });
            }
            if (target.pathname.endsWith(':retrieveUserQuotaSummary')) {
                const index = endpoints.indexOf(target.hostname);
                if (summaryMode === 'partial') {
                    return response(200, quotaSummary([quotaGroup('Claude', 0.8, 0.6)]));
                }
                if (index === 0) return response(200, quotaSummary([quotaGroup('Claude', 0.8, 0.6)]));
                if (index === 1) return response(200, quotaSummary([quotaGroup('Gemini', 0.35, 0.12)]));
                return response(503, {});
            }
            throw new Error(`Unexpected test request: ${target.hostname}${target.pathname}`);
        };
        storage.readAccounts = () => accounts;
        storage.mergeAccounts = updated => {
            accounts = updated;
            return accounts;
        };
        console.log = () => {};
        console.error = () => {};

        const accountService = require('../out/services/accountService');
        const previousQuota = JSON.parse(JSON.stringify(accounts[0].quota));

        await assert.rejects(
            accountService.fetchAccountQuota('test-account'),
            /只返回部分数据.*Gemini 5小时额度.*Gemini 周额度/,
            '缺少已有 Gemini 窗口时刷新必须失败'
        );
        assert.deepStrictEqual(accounts[0].quota, previousQuota, '部分响应不得覆盖旧额度或刷新时间');

        const refreshResult = await accountService.refreshAccountQuotasSequentially(
            ['test-account'],
            accountService.fetchAccountQuota
        );
        assert.deepStrictEqual(refreshResult, { success: 0, failed: 1 }, '部分响应必须计入刷新失败数');
        assert.deepStrictEqual(accounts[0].quota, previousQuota, '批量刷新失败也必须保留旧快照');

        summaryMode = 'complementary';
        accountService.invalidateCache();
        const updatedQuota = await accountService.fetchAccountQuota('test-account');
        assert.deepStrictEqual(
            updatedQuota.models.map(model => [model.name, model.percentage, model.weekly_percentage]),
            [['claude', 80, 60], ['gemini-pro', 35, 12], ['gemini-flash', 35, 12]],
            '跨端点互补结果应写入完整的新额度'
        );
        assert(updatedQuota.last_updated > previousQuota.last_updated, '完整响应成功后才更新刷新时间');
        passed = true;
    } finally {
        network.requestHttps = originalRequestHttps;
        storage.readAccounts = originalReadAccounts;
        storage.mergeAccounts = originalMergeAccounts;
        console.log = originalLog;
        console.error = originalError;
        if (passed) originalLog('Quota refresh regression checks passed');
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
