import { validate } from '../lib/schema.js';
import { chargeFromUsageMicros, maxChargeMicros, PricingError } from './pricing.js';

// What a worker may ask for. Endpoints, models, keys and token limits are not in this shape, so an agent cannot choose
// them: unknown fields are refused rather than dropped.
const REQUEST_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['requestId', 'observation', 'inputTokensBound'],
    properties: {
        requestId: { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,128}$' },
        observation: { type: 'object' },
        inputTokensBound: { type: 'integer', minimum: 0 },
        features: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    },
};

export const MAX_INPUT_TOKENS_BOUND = 400_000;

export function createBroker({
    runId,
    ledger,
    provider,
    pricing,
    config,
    record = () => {},
    requestTimeoutMs = 30000,
}) {
    if (!provider || provider.name !== config.model.provider)
        throw new Error(`No approved provider transport for ${config.model.provider}`);
    if (pricing.provider !== config.model.provider || pricing.modelId !== config.model.id)
        throw new Error('The pricing record does not match the configured model');
    const inFlight = new Map();
    const controllers = new Set();
    const seen = new Set();
    let revoked = null;

    function reject(actorId, requestId, code, message) {
        record('broker.rejected', { actorId, requestId, code, message });
        return { ok: false, code, message };
    }

    async function attempt({ actorId, request, reservationId, maxMicros }) {
        const admission = ledger.reserve({
            reservationId,
            runId,
            actorId,
            model: `${config.model.provider}/${config.model.id}`,
            maxMicros,
        });
        if (!admission.ok)
            return { terminal: reject(actorId, request.requestId, admission.code, 'Spending admission refused') };
        record('broker.reserved', { actorId, requestId: request.requestId, reservationId, maxMicros });
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const reply = await provider.invoke({
                model: config.model.id,
                maxOutputTokens: config.model.maxOutputTokens,
                observation: request.observation,
                signal: controller.signal,
            });
            if (reply.model !== config.model.id) {
                // No silent substitution: the reply is withheld and the liability retained until reconciled.
                ledger.markAmbiguous(reservationId, { note: `model_mismatch:${reply.model}` });
                return {
                    terminal: reject(actorId, request.requestId, 'model_mismatch', `Provider returned ${reply.model}`),
                };
            }
            let charge;
            try {
                if (reply.malformed || !reply.usage) throw new PricingError('The reply has no usable usage data');
                charge = chargeFromUsageMicros(pricing, reply.usage);
            } catch (error) {
                ledger.markAmbiguous(reservationId, { note: 'malformed_reply' });
                record('broker.ambiguous', { actorId, reservationId, reason: 'malformed_reply' });
                return { retry: 'malformed_reply' };
            }
            ledger.settle(reservationId, charge);
            record('broker.settled', {
                actorId,
                reservationId,
                micros: charge,
                usage: reply.usage,
                model: reply.model,
            });
            // Codex's stream names no model, so its reply.model is the requested id and model_mismatch cannot fire for it.
            return {
                terminal: {
                    ok: true,
                    decision: reply.decision,
                    model: reply.model,
                    modelVerified: reply.modelVerified === true,
                    usage: reply.usage,
                },
            };
        } catch (error) {
            if (error.kind === 'policy_violation') {
                // The CLI tried something outside a model reply. The reply is withheld and retrying could repeat it.
                ledger.markAmbiguous(reservationId, { note: 'policy_violation' });
                return { terminal: reject(actorId, request.requestId, 'transport_policy_violation', error.message) };
            }
            if (error.auth) {
                ledger.release(reservationId, { note: 'auth_required' });
                return { terminal: reject(actorId, request.requestId, 'auth_required', error.message) };
            }
            if (error.kind === 'not_sent' || error.kind === 'not_billed') {
                ledger.release(reservationId, { note: error.kind });
                record('broker.released', { actorId, reservationId, reason: error.kind });
                return { retry: error.kind };
            }
            // A timeout or unknown failure does not prove the request went unbilled.
            ledger.markAmbiguous(reservationId, { note: error.kind ?? 'unknown_failure' });
            record('broker.ambiguous', { actorId, reservationId, reason: error.kind ?? 'unknown_failure' });
            return { retry: error.kind ?? 'unknown_failure' };
        } finally {
            clearTimeout(timer);
            controllers.delete(controller);
        }
    }

    return {
        // actorId comes from the authenticated worker channel, never from the request body.
        async request(actorId, request) {
            const requestId = request?.requestId;
            const errors = validate(REQUEST_SCHEMA, request);
            if (errors.length) return reject(actorId, requestId, 'invalid_request', errors.join('; '));
            if (revoked) return reject(actorId, requestId, 'admission_revoked', revoked);
            const key = `${actorId}:${requestId}`;
            if (seen.has(key)) return reject(actorId, requestId, 'duplicate_request', 'Request id already used');
            if (request.inputTokensBound > MAX_INPUT_TOKENS_BOUND)
                return reject(actorId, requestId, 'input_too_large', 'Input bound exceeds the ceiling');
            const active = inFlight.get(actorId) ?? 0;
            if (active >= config.model.maxConcurrentRequestsPerAgent)
                return reject(actorId, requestId, 'concurrency_limit', 'Too many concurrent requests');
            let maxMicros;
            try {
                maxMicros = maxChargeMicros(pricing, {
                    inputTokensBound: request.inputTokensBound,
                    maxOutputTokens: config.model.maxOutputTokens,
                    features: request.features ?? [],
                });
            } catch (error) {
                return reject(actorId, requestId, 'unbounded_charge', error.message);
            }
            seen.add(key);
            inFlight.set(actorId, active + 1);
            try {
                const retries = config.limits.maxModelRetries;
                let last = 'not_attempted';
                for (let n = 0; n <= retries; n++) {
                    if (revoked) return reject(actorId, requestId, 'admission_revoked', revoked);
                    // Each attempt is its own reservation, so a retry can never reuse budget a timed-out attempt holds.
                    const outcome = await attempt({
                        actorId,
                        request,
                        reservationId: `${runId}:${key}:${n}`,
                        maxMicros,
                    });
                    if (outcome.terminal) return outcome.terminal;
                    last = outcome.retry;
                }
                return reject(actorId, requestId, 'provider_failed', `Retries exhausted: ${last}`);
            } finally {
                inFlight.set(actorId, (inFlight.get(actorId) ?? 1) - 1);
            }
        },
        revoke(reason) {
            revoked ??= reason;
            for (const controller of controllers) controller.abort();
        },
        get revoked() {
            return revoked;
        },
    };
}
