export interface ParsedQuotaBucket {
    percentage: number;
    resetTime: string;
}

export interface ParsedQuotaSummary {
    claude?: ParsedQuotaWindows;
    gemini?: ParsedQuotaWindows;
}

export interface ParsedQuotaWindows {
    fiveHour?: ParsedQuotaBucket;
    weekly?: ParsedQuotaBucket;
}

function isValidFraction(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function bucketIdentityText(bucket: any): string {
    return [
        bucket?.bucketId,
        bucket?.window,
        bucket?.displayName,
    ].filter(Boolean).join(' ').toLowerCase();
}

function hasFiveHourMarker(text: string): boolean {
    return text.includes('5h')
        || /(^|\W)5\s*-?\s*h(our)?s?($|\W)/i.test(text)
        || text.includes('five hour')
        || text.includes('session');
}

function hasWeeklyMarker(text: string): boolean {
    return text.includes('week') || text.includes('7d') || text.includes('7 day');
}

function isFiveHourBucket(bucket: any): boolean {
    const identity = bucketIdentityText(bucket);
    if (hasWeeklyMarker(identity)) return false;
    if (hasFiveHourMarker(identity)) return true;

    // description 可能同时提到周额度和“5-hour limit”，只能在语义单一时兜底。
    const description = String(bucket?.description || '').toLowerCase();
    return hasFiveHourMarker(description) && !hasWeeklyMarker(description);
}

function isWeeklyBucket(bucket: any): boolean {
    const identity = bucketIdentityText(bucket);
    if (hasFiveHourMarker(identity)) return false;
    if (hasWeeklyMarker(identity)) return true;

    const description = String(bucket?.description || '').toLowerCase();
    return hasWeeklyMarker(description) && !hasFiveHourMarker(description);
}

function parseBucket(bucket: any): ParsedQuotaBucket {
    return {
        percentage: Math.round(bucket.remainingFraction * 100),
        resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : '',
    };
}

function selectBuckets(group: any): ParsedQuotaWindows | null {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const valid = buckets.filter((bucket: any) => isValidFraction(bucket?.remainingFraction));
    if (valid.length === 0) return null;

    let fiveHour = valid.find((bucket: any) => isFiveHourBucket(bucket));
    let weekly = valid.find((bucket: any) => isWeeklyBucket(bucket));

    // 某些后端不返回 window/bucketId。此时只能按重置时间推断：
    // 较近的是 5 小时窗口，较远的是周窗口。绝不能把已识别的周桶回退成 5 小时桶。
    const dated = valid
        .map((bucket: any) => ({ bucket, resetAt: Date.parse(bucket?.resetTime || '') }))
        .filter((item: any) => Number.isFinite(item.resetAt))
        .sort((a: any, b: any) => a.resetAt - b.resetAt);
    if (!fiveHour && dated.length > 0 && (!weekly || dated[0].bucket !== weekly)) {
        fiveHour = dated[0].bucket;
    }
    if (!weekly && dated.length > 1) {
        weekly = dated[dated.length - 1].bucket;
    }

    const parsed: ParsedQuotaWindows = {};
    if (fiveHour) parsed.fiveHour = parseBucket(fiveHour);
    if (weekly) parsed.weekly = parseBucket(weekly);
    return parsed.fiveHour || parsed.weekly ? parsed : null;
}

/**
 * 将 retrieveUserQuotaSummary 的共享配额桶转换为插件现有的两类模型池。
 * Claude 与 GPT 共用一池；Gemini Pro 与 Flash 共用另一池。
 */
export function parseQuotaSummary(data: any): ParsedQuotaSummary | null {
    if (!Array.isArray(data?.groups)) return null;

    const parsed: ParsedQuotaSummary = {};
    for (const group of data.groups) {
        const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
        const text = [
            group?.displayName,
            group?.description,
            ...buckets.flatMap((bucket: any) => [bucket?.bucketId, bucket?.displayName]),
        ].filter(Boolean).join(' ').toLowerCase();
        const windows = selectBuckets(group);
        if (!windows) continue;

        if (text.includes('claude') || text.includes('gpt') || text.includes('3p') || text.includes('third party')) {
            parsed.claude = windows;
        } else if (text.includes('gemini')) {
            parsed.gemini = windows;
        }
    }

    return parsed.claude || parsed.gemini ? parsed : null;
}
