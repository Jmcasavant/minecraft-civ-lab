import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createBroker } from '../../../lab/broker/broker.js';
import { Ledger } from '../../../lab/broker/ledger.js';
import { createMockProvider, scriptedDecision } from '../../../lab/broker/mock-provider.js';
import { FAKE_PRICING, tempDir } from '../fixtures/helpers.js';

const CONFIG = {
    model: { provider: 'fake-paid', id: 'fake-model-1', maxOutputTokens: 10, maxConcurrentRequestsPerAgent: 1 },
    limits: { maxModelRetries: 1 },
};
// One request costs at most 100 input tokens x 2 + 10 output tokens x 5 = 250 micros.
const REQUEST = n => ({ requestId: `q${n}`, observation: {}, inputTokensBound: 100 });

function setup(
    t,
    { faults = [], capMicros = 10000, config = CONFIG, maxRequests = 100, provider, requestTimeoutMs = 50 } = {},
) {
    const ledger = new Ledger(path.join(tempDir(t), 'ledger.sqlite'));
    t.after(() => ledger.close());
    ledger.openRun({ runId: 'r', campaignId: 'c', runCapMicros: capMicros, campaignCapMicros: capMicros, maxRequests });
    const inner = provider ?? createMockProvider({ faults, model: 'fake-model-1' });
    const events = [];
    const broker = createBroker({
        runId: 'r',
        ledger,
        provider: { ...inner, name: 'fake-paid', invoke: args => inner.invoke(args) },
        pricing: FAKE_PRICING,
        config,
        requestTimeoutMs,
        record: (type, payload) => events.push({ type, ...payload }),
    });
    return { ledger, broker, inner, events };
}

test('a successful request reserves first and then settles from usage', async t => {
    const { broker, ledger, events } = setup(t);
    const reply = await broker.request('agent-a', REQUEST(1));
    assert.equal(reply.ok, true);
    assert.deepEqual(
        events.map(e => e.type),
        ['broker.reserved', 'broker.settled'],
    );
    assert.equal(ledger.runTotals('r').settledMicros, 10 * 1 + 5 * 5);
    assert.equal(ledger.runTotals('r').unsettledExposureMicros, 0);
});

test('the reply says whether the provider itself reported the model', async t => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 };
    const answering = modelVerified => ({
        invoke: async () => ({ model: 'fake-model-1', modelVerified, usage, decision: { done: true, text: '' } }),
    });
    const verified = await setup(t, { provider: answering(true) }).broker.request('agent-a', REQUEST(1));
    assert.equal(verified.modelVerified, true);
    const echoed = await setup(t, { provider: answering(false) }).broker.request('agent-a', REQUEST(1));
    assert.equal(echoed.ok, true);
    assert.equal(echoed.modelVerified, false);
});

test('a worker cannot choose an endpoint, model or key', async t => {
    const { broker, inner } = setup(t);
    for (const field of ['baseUrl', 'model', 'apiKey', 'maxOutputTokens']) {
        const reply = await broker.request('agent-a', { ...REQUEST(1), [field]: 'x' });
        assert.equal(reply.code, 'invalid_request', field);
    }
    assert.equal(inner.calls, 0);
});

test('an unbounded request or separately billed feature is refused before any call', async t => {
    const { broker, inner } = setup(t);
    assert.equal((await broker.request('a', { requestId: 'x', observation: {} })).code, 'invalid_request');
    assert.equal((await broker.request('a', { ...REQUEST(2), features: ['web_search'] })).code, 'unbounded_charge');
    assert.equal(inner.calls, 0);
});

test('budget refusal happens before the provider is called', async t => {
    const { broker, inner } = setup(t, { capMicros: 100 });
    assert.equal((await broker.request('a', REQUEST(1))).code, 'run_budget');
    assert.equal(inner.calls, 0);
});

test('ambiguous timeout: liability is retained and the retry cannot double-spend available budget', async t => {
    const { broker, ledger, inner } = setup(t, { faults: ['timeout', 'timeout'], capMicros: 300 });
    const reply = await broker.request('a', REQUEST(1));
    assert.equal(inner.calls, 1, 'the retry was refused because the first attempt still holds its budget');
    assert.equal(reply.code, 'run_budget');
    assert.equal(ledger.runTotals('r').ambiguousMicros, 250);
});

test('a retry after an ambiguous timeout gets its own reservation', async t => {
    const { broker, ledger, inner } = setup(t, { faults: ['timeout'] });
    assert.equal((await broker.request('a', REQUEST(1))).ok, true);
    assert.equal(inner.calls, 2);
    const totals = ledger.runTotals('r');
    assert.equal(totals.ambiguousMicros, 250);
    assert.equal(totals.settledMicros, 35);
});

test('a malformed reply is liability, not success', async t => {
    const { broker, ledger } = setup(t, { faults: ['malformed', 'malformed'] });
    const reply = await broker.request('a', REQUEST(1));
    assert.equal(reply.code, 'provider_failed');
    assert.equal(ledger.runTotals('r').ambiguousMicros, 500);
});

test('a request that was definitely not sent is released and retried within the limit', async t => {
    const { broker, ledger, inner } = setup(t, { faults: ['refused', 'rate_limit'] });
    const reply = await broker.request('a', REQUEST(1));
    assert.equal(reply.code, 'provider_failed');
    assert.equal(inner.calls, 2, 'one try plus one retry');
    assert.equal(ledger.runTotals('r').unsettledExposureMicros, 0);
});

test('a substituted model is never returned to the agent', async t => {
    const { broker, ledger } = setup(t, { provider: createMockProvider({ model: 'other-model' }) });
    const reply = await broker.request('a', REQUEST(1));
    assert.equal(reply.code, 'model_mismatch');
    assert.equal(reply.decision, undefined);
    assert.equal(ledger.runTotals('r').ambiguousMicros, 250);
});

test('per-agent concurrency is limited, and other agents are unaffected', async t => {
    const { broker } = setup(t, { faults: ['timeout'], requestTimeoutMs: 80 });
    const first = broker.request('a', REQUEST(1));
    const second = await broker.request('a', REQUEST(2));
    assert.equal(second.code, 'concurrency_limit');
    assert.equal((await broker.request('b', REQUEST(3))).ok, true);
    await first;
});

test('a request id cannot be replayed', async t => {
    const { broker } = setup(t);
    await broker.request('a', REQUEST(1));
    assert.equal((await broker.request('a', REQUEST(1))).code, 'duplicate_request');
});

test('revocation blocks new requests and aborts open ones', async t => {
    const { broker, ledger } = setup(t, { faults: ['timeout'], requestTimeoutMs: 5000 });
    const open = broker.request('a', REQUEST(1));
    await new Promise(r => setTimeout(r, 20));
    broker.revoke('operator_stop');
    assert.equal((await open).code, 'admission_revoked');
    assert.equal((await broker.request('b', REQUEST(2))).code, 'admission_revoked');
    assert.equal(ledger.runTotals('r').ambiguousMicros, 250);
});

test('a broker refuses a provider or price that does not match the config', t => {
    assert.throws(
        () => setup(t, { config: { ...CONFIG, model: { ...CONFIG.model, provider: 'other' } } }),
        /No approved provider/,
    );
    assert.throws(() => setup(t, { config: { ...CONFIG, model: { ...CONFIG.model, id: 'other' } } }), /pricing record/);
});

test('the scripted provider plays the qualification plan from observations alone', () => {
    let inv = {};
    const completed = [];
    let logs = 0;
    const seen = [];
    for (let i = 0; i < 40; i++) {
        const d = scriptedDecision({ inventory: inv, completed, logsCollected: logs });
        if (d.done) break;
        seen.push(d.tool);
        const add = (k, n) => (inv = { ...inv, [k]: (inv[k] ?? 0) + n });
        if (d.tool === 'gather' && d.args.block === 'oak_log') (add('oak_log', 4), (logs = 4));
        else if (d.tool === 'gather') add('sweet_berries', 1);
        else if (d.tool === 'craft' && d.args.item === 'oak_planks') (add('oak_log', -1), add('oak_planks', 4));
        else if (d.tool === 'craft' && d.args.item === 'crafting_table')
            (add('oak_planks', -4), add('crafting_table', 1));
        else if (d.tool === 'craft') (add('oak_planks', -8), add('chest', 1));
        else if (d.tool === 'place')
            (add(d.args.block, -1), completed.push(d.args.block === 'chest' ? 'chest_placed' : 'table_placed'));
        else if (d.tool === 'deposit') (add('oak_planks', -1), completed.push('deposited'));
        else if (d.tool === 'eat') (add('sweet_berries', -1), completed.push('ate'));
    }
    for (const tool of ['gather', 'craft', 'place', 'deposit', 'eat']) assert.ok(seen.includes(tool), tool);
    assert.ok(completed.includes('ate'));
});
