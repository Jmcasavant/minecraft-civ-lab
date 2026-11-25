import { performance } from 'node:perf_hooks';
import { validate } from '../lib/schema.js';
import { hashOf, labSchema } from '../lib/util.js';

const REQUEST_SCHEMA = labSchema('action-request');
const RESULT_SCHEMA = labSchema('action-result');
const NON_BODY_TOOLS = new Set(['stop_action']);

// The lab-side admission boundary for every gameplay action. actorId is supplied by the trusted channel and is not a
// field of the request, so a request naming another agent fails validation instead of being honoured.
export function createActionGate({
    runId,
    allowlist,
    world,
    store,
    now = () => performance.now(),
    record = () => {},
    toolTimeoutMs = 10000,
    settleTimeoutMs = 2000,
}) {
    const allowed = new Set(allowlist);
    const active = new Map();
    const inFlight = new Map();
    let revoked = null;

    const result = (actorId, actionId, fields) => ({
        schemaVersion: '1',
        runId,
        actionId: String(actionId ?? 'invalid'),
        actorId,
        startedTick: world.tick(),
        finishedTick: world.tick(),
        observedDelta: {},
        evidenceIds: [],
        retryable: false,
        ...fields,
    });
    const refuse = (actorId, actionId, failureCode, extra = {}) => {
        record('action.refused', { actorId, actionId: actionId ?? null, failureCode });
        return result(actorId, actionId, { status: 'failed', failureCode, ...extra });
    };

    async function execute(actorId, request) {
        const { actionId, tool, args } = request;
        const controller = new AbortController();
        const remaining = Math.min(toolTimeoutMs, request.deadlineMonotonicMs - now());
        const timer = setTimeout(() => controller.abort(new Error('deadline')), Math.max(0, remaining));
        const entry = { actionId, controller, done: null };
        active.set(actorId, entry);
        record('action.started', { actorId, actionId, tool });
        const work = (async () => {
            let outcome;
            try {
                const raw = await world.execute(actorId, tool, args, controller.signal, actionId);
                outcome = result(actorId, actionId, raw);
            } catch (error) {
                // The body may have changed before the failure, so this is reported as uncertain, never as "nothing happened".
                outcome = result(actorId, actionId, {
                    status: 'partial',
                    failureCode: 'outcome_uncertain',
                    suggestedRecovery: 'Reobserve before repeating this action.',
                });
            }
            clearTimeout(timer);
            const errors = validate(RESULT_SCHEMA, outcome);
            if (errors.length)
                outcome = result(actorId, actionId, {
                    status: 'partial',
                    failureCode: 'invalid_tool_result',
                    retryable: false,
                });
            store.finishAction({ runId, actorId, actionId, result: outcome });
            if (active.get(actorId) === entry) active.delete(actorId);
            record('action.finished', {
                actorId,
                actionId,
                tool,
                status: outcome.status,
                failureCode: outcome.failureCode ?? null,
                evidenceIds: outcome.evidenceIds,
            });
            return outcome;
        })();
        entry.done = work;
        return work;
    }

    return {
        async submit(actorId, request) {
            const actionId = request?.actionId;
            if (revoked) return refuse(actorId, actionId, 'admission_revoked', { retryable: false });
            const errors = validate(REQUEST_SCHEMA, request);
            if (errors.length) {
                record('security.rejected', { actorId, kind: 'invalid_action_request', errors: errors.slice(0, 5) });
                return refuse(actorId, actionId, 'invalid_request');
            }
            if (request.runId !== runId) {
                record('security.rejected', { actorId, kind: 'run_mismatch' });
                return refuse(actorId, actionId, 'run_mismatch');
            }
            if (!allowed.has(request.tool)) {
                record('security.rejected', { actorId, kind: 'tool_forbidden', tool: request.tool });
                return refuse(actorId, actionId, 'tool_forbidden');
            }
            const key = `${actorId}:${actionId}`;
            const requestHash = hashOf({ tool: request.tool, args: request.args });
            const running = inFlight.get(key);
            if (running)
                return running.requestHash === requestHash
                    ? running.work
                    : refuse(actorId, actionId, 'action_id_conflict');
            const prior = store.admitAction({ runId, actorId, actionId, requestHash });
            if (prior) {
                if (prior.request_hash !== requestHash) return refuse(actorId, actionId, 'action_id_conflict');
                if (prior.state === 'finished') return JSON.parse(prior.result);
                return refuse(actorId, actionId, 'outcome_uncertain', {
                    status: 'partial',
                    suggestedRecovery:
                        'An earlier attempt with this id has no recorded result. Reobserve instead of repeating it.',
                });
            }
            const finishRefusal = (code, extra) => {
                const refused = refuse(actorId, actionId, code, extra);
                store.finishAction({ runId, actorId, actionId, result: refused });
                return refused;
            };
            if (now() > request.deadlineMonotonicMs) return finishRefusal('deadline_passed', { retryable: true });
            if (request.tool === 'stop_action') {
                const current = active.get(actorId);
                current?.controller.abort(new Error('cancelled'));
                await current?.done;
                const stopped = result(actorId, actionId, {
                    status: 'succeeded',
                    observedDelta: { cancelled: current?.actionId ?? null },
                });
                store.finishAction({ runId, actorId, actionId, result: stopped });
                return stopped;
            }
            if (!world.hasTool(request.tool))
                return finishRefusal('tool_unavailable', {
                    suggestedRecovery: 'This adapter does not implement that tool.',
                });
            if (request.expectedObservationSeq !== world.observationSeq(actorId))
                return finishRefusal('stale_observation', {
                    retryable: true,
                    suggestedRecovery: 'Refresh the observation, reevaluate, then issue a new attempt.',
                });
            if (!NON_BODY_TOOLS.has(request.tool) && active.has(actorId))
                return finishRefusal('body_busy', {
                    retryable: true,
                    suggestedRecovery: 'Wait for or cancel the current action.',
                });
            const work = execute(actorId, request);
            inFlight.set(key, { requestHash, work });
            try {
                return await work;
            } finally {
                inFlight.delete(key);
            }
        },
        // Blocks new admissions at once, then cancels and waits for whatever is still running.
        async revoke(reason) {
            revoked ??= reason;
            const running = [...active.values()];
            for (const entry of running) entry.controller.abort(new Error(reason));
            const settled = await Promise.race([
                Promise.allSettled(running.map(entry => entry.done)).then(() => true),
                new Promise(resolve => setTimeout(() => resolve(false), settleTimeoutMs)),
            ]);
            return { cancelled: running.length, settled };
        },
        get revoked() {
            return revoked;
        },
        activeAction: actorId => active.get(actorId)?.actionId ?? null,
    };
}

// After a controller restart, an admitted action with no result may or may not have happened physically.
export function reconcileUnfinishedActions(store, runId) {
    const rows = store.unfinishedActions(runId);
    for (const row of rows)
        store.finishAction({
            runId,
            actorId: row.actor_id,
            actionId: row.action_id,
            result: {
                schemaVersion: '1',
                runId,
                actionId: row.action_id,
                actorId: row.actor_id,
                status: 'partial',
                failureCode: 'outcome_uncertain',
                startedTick: 0,
                finishedTick: 0,
                observedDelta: {},
                evidenceIds: [],
                retryable: false,
                suggestedRecovery: 'The controller stopped during this action. Its physical outcome is unknown.',
            },
        });
    return rows.length;
}
