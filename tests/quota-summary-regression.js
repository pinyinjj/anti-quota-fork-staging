const assert = require('assert');
const {
    findMissingQuotaData,
    mergeQuotaSummaries,
} = require('../out/services/quotaSummaryService');

const claude = {
    fiveHour: { percentage: 80, resetTime: '2026-10-22T12:00:00Z' },
    weekly: { percentage: 65, resetTime: '2026-10-29T12:00:00Z' },
};
const gemini = {
    fiveHour: { percentage: 35, resetTime: '2026-10-22T12:30:00Z' },
    weekly: { percentage: 12, resetTime: '2026-10-29T12:30:00Z' },
};

const merged = mergeQuotaSummaries([
    { claude },
    { gemini },
]);
assert.deepStrictEqual(merged, { claude, gemini }, '多个端点的互补额度窗口应合并');

const laterClaude = {
    fiveHour: { percentage: 10, resetTime: 'later' },
    weekly: { percentage: 20, resetTime: 'later' },
};
assert.deepStrictEqual(
    mergeQuotaSummaries([{ claude }, { claude: laterClaude }]).claude,
    claude,
    '较早端点已经提供的窗口应保持优先级'
);
assert.strictEqual(mergeQuotaSummaries([null, undefined]), null);

const previousModels = [
    { name: 'claude', displayName: 'Claude Sonnet', weekly_percentage: 65 },
    { name: 'gemini-pro', displayName: 'Gemini 3 Pro', weekly_percentage: 12 },
    { name: 'gemini-flash', displayName: 'Gemini 3 Flash', weekly_percentage: 12 },
];
const currentModels = previousModels.map(({ name, displayName }) => ({ name, displayName }));
assert.deepStrictEqual(findMissingQuotaData(currentModels, merged, previousModels), [], '完整响应应通过窗口校验');
assert.deepStrictEqual(
    findMissingQuotaData(currentModels, { claude }, previousModels),
    ['Gemini 5小时额度', 'Gemini 周额度'],
    '仅返回 Claude 时必须标记 Gemini 窗口缺失'
);
assert.deepStrictEqual(
    findMissingQuotaData(currentModels, { claude, gemini: { fiveHour: gemini.fiveHour } }, previousModels),
    ['Gemini 周额度'],
    '旧缓存已有周额度但本次未返回周窗口时必须标记刷新不完整'
);
assert.deepStrictEqual(
    findMissingQuotaData(currentModels.slice(0, 2), merged, previousModels),
    ['Gemini 3 Flash 模型'],
    '本次模型列表缺少已有模型时必须标记刷新不完整'
);
assert.deepStrictEqual(
    findMissingQuotaData([{ name: 'gemini-pro', displayName: 'Gemini 3 Pro' }], { gemini: { fiveHour: gemini.fiveHour } }),
    [],
    '从未缓存过周额度的新账号不应因可选周窗口缺失而失败'
);

console.log('Quota summary regression checks passed');
