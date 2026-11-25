// Pricing records hold micro-USD per token. The repository ships no real prices: a paid run must supply a verified
// record with its source and retrieval date. Tests use records whose provider is explicitly fictional.
const RATE_KEYS = [
    'inputMicrosPerToken',
    'outputMicrosPerToken',
    'cacheWriteMicrosPerToken',
    'cacheReadMicrosPerToken',
];
const REQUIRED = ['provider', 'modelId', 'source', 'retrievedAt', 'separatelyBilledFeatures', ...RATE_KEYS];

export class PricingError extends Error {
    code = 'UNBOUNDED_CHARGE';
}

export function assertPricingRecord(record) {
    for (const key of REQUIRED)
        if (record?.[key] === undefined) throw new PricingError(`Pricing record is missing ${key}`);
    for (const key of RATE_KEYS)
        if (!(Number.isFinite(record[key]) && record[key] >= 0))
            throw new PricingError(`Pricing rate ${key} is invalid`);
    if (!Array.isArray(record.separatelyBilledFeatures))
        throw new PricingError('separatelyBilledFeatures must be a list');
    return record;
}

// The most a single request could cost. Every input token is priced at the dearest input rate, and reasoning tokens
// are assumed to bill as output inside the enforced output limit. A feature billed separately has no bound here, so
// a strict budget refuses it rather than guessing.
export function maxChargeMicros(record, { inputTokensBound, maxOutputTokens, features = [] }) {
    assertPricingRecord(record);
    if (!(Number.isSafeInteger(inputTokensBound) && inputTokensBound >= 0))
        throw new PricingError('The input token bound is unknown');
    if (!(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 0))
        throw new PricingError('The output token limit is unknown');
    const unpriced = features.filter(f => record.separatelyBilledFeatures.includes(f));
    if (unpriced.length) throw new PricingError(`Separately billed features cannot be bounded: ${unpriced.join(', ')}`);
    const inputRate = Math.max(
        record.inputMicrosPerToken,
        record.cacheWriteMicrosPerToken,
        record.cacheReadMicrosPerToken,
    );
    return Math.ceil(inputTokensBound * inputRate + maxOutputTokens * record.outputMicrosPerToken);
}

export function chargeFromUsageMicros(record, usage) {
    const count = key => {
        const value = usage?.[key] ?? 0;
        if (!(Number.isSafeInteger(value) && value >= 0)) throw new PricingError(`Bad usage value ${key}`);
        return value;
    };
    return Math.ceil(
        count('inputTokens') * record.inputMicrosPerToken +
            count('outputTokens') * record.outputMicrosPerToken +
            count('cacheWriteTokens') * record.cacheWriteMicrosPerToken +
            count('cacheReadTokens') * record.cacheReadMicrosPerToken,
    );
}

export const MOCK_PRICING = Object.freeze({
    provider: 'mock',
    modelId: 'scripted-v1',
    source: 'mock provider: makes no network request and has no cost',
    retrievedAt: 'not-applicable',
    separatelyBilledFeatures: Object.freeze([]),
    inputMicrosPerToken: 0,
    outputMicrosPerToken: 0,
    cacheWriteMicrosPerToken: 0,
    cacheReadMicrosPerToken: 0,
});
