import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createActionGate, reconcileUnfinishedActions } from '../../../lab/adapter/action-gate.js';
import { createMockWorld } from '../../../lab/adapter/mock-world.js';
import { ControlStore, TRANSITIONS } from '../../../lab/controller/store.js';
import { EventLog, readEvents, sequenceGaps } from '../../../lab/events/log.js';
import { hashOf } from '../../../lab/lib/util.js';
import { tempDir } from '../fixtures/helpers.js';

function setup(
    t,
    { worldFaults, allow = ['gather', 'craft', 'place', 'deposit', 'eat', 'stop_action', 'mock_hang'] } = {},
) {
    const dir = tempDir(t);
    const store = new ControlStore(path.join(dir, 'control.sqlite'));
    store.createRun({ runId: 'r', configHash: 'h', runDir: dir });
    const log = new EventLog({ runId: 'r', file: path.join(dir, 'events.jsonl') });
    t.after(() => {
        log.close();
        store.close();
    });
    const world = createMockWorld({ runId: 'r', participants: ['a', 'b'], log, actionMs: 5, faults: worldFaults });
    const records = [];
    const gate = createActionGate({
        runId: 'r',
        allowlist: allow,
        world,
        store,
        record: (type, payload) => records.push({ type, ...payload }),
        settleTimeoutMs: 500,
    });
    let n = 0;
    const request = (actor, tool, args = {}, extra = {}) => ({
        schemaVersion: '1',
        runId: 'r',
        actionId: `act-${++n}`,
        expectedObservationSeq: world.observe(actor).observationSeq,
        tool,
        args,
        deadlineMonotonicMs: performance.now() + 5000,
        ...extra,
    });
    return { dir, store, log, world, gate, records, request };
}

test('success requires an observed postcondition, and evidence is attached', async t => {
    const { gate, request } = setup(t);
    const result = await gate.submit('a', request('a', 'gather', { block: 'oak_log', count: 2 }));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.actorId, 'a');
    assert.equal(result.observedDelta.inventory.oak_log, 2);
    assert.ok(result.evidenceIds.length >= 2);
});

test('breaking a log without collecting it is partial progress', async t => {
    const { gate, request } = setup(t, { worldFaults: { gatherNoPickup: 1 } });
    const result = await gate.submit('a', request('a', 'gather', { block: 'oak_log', count: 1 }));
    assert.equal(result.status, 'partial');
    assert.equal(result.failureCode, 'broken_not_collected');
});

test('identity spoof: a request naming another actor is rejected', async t => {
    const { gate, request, records, world } = setup(t);
    const result = await gate.submit('a', { ...request('a', 'gather', { block: 'oak_log' }), actorId: 'b' });
    assert.equal(result.failureCode, 'invalid_request');
    assert.equal(result.actorId, 'a');
    assert.deepEqual(world.observe('b').inventory, {});
    assert.ok(records.some(r => r.type === 'security.rejected'));
});

test('another run id is rejected', async t => {
    const { gate, request } = setup(t);
    assert.equal((await gate.submit('a', request('a', 'gather', {}, { runId: 'other' }))).failureCode, 'run_mismatch');
});

test('an unknown or forbidden tool never executes', async t => {
    const { gate, request, records } = setup(t);
    for (const tool of ['run_shell', 'compute_js', 'shared_exec', 'workspace_write', 'not_a_tool']) {
        const result = await gate.submit('a', request('a', tool));
        assert.equal(result.failureCode, 'tool_forbidden', tool);
    }
    assert.equal(records.filter(r => r.type === 'action.started').length, 0);
});

test('repeated action request: one physical execution, same result', async t => {
    const { gate, request, world } = setup(t);
    const req = request('a', 'gather', { block: 'oak_log', count: 1 });
    const [first, second] = await Promise.all([gate.submit('a', req), gate.submit('a', req)]);
    const third = await gate.submit('a', req);
    assert.deepEqual(first, second);
    assert.deepEqual(first, third);
    assert.equal(world.observe('a').inventory.oak_log, 1);
});

test('an action id reused with different content is refused', async t => {
    const { gate, request } = setup(t);
    const req = request('a', 'gather', { block: 'oak_log' });
    await gate.submit('a', req);
    assert.equal(
        (await gate.submit('a', { ...req, args: { block: 'sweet_berry_bush' } })).failureCode,
        'action_id_conflict',
    );
});

test('an action id reused with different content while the first is running is refused', async t => {
    const { gate, request, world } = setup(t);
    const req = request('a', 'gather', { block: 'oak_log', count: 1 });
    const running = gate.submit('a', req);
    const conflicting = await gate.submit('a', { ...req, tool: 'craft', args: { item: 'stick' } });
    assert.equal(conflicting.failureCode, 'action_id_conflict');
    assert.equal(conflicting.status, 'failed');
    assert.equal((await running).status, 'succeeded');
    assert.equal(world.observe('a').inventory.oak_log, 1);
});

test('one body action per bot, while another bot is unaffected', async t => {
    const { gate, request } = setup(t);
    const hanging = gate.submit('a', request('a', 'mock_hang'));
    await new Promise(r => setTimeout(r, 10));
    const busy = request('a', 'gather', { block: 'oak_log' });
    assert.equal((await gate.submit('a', busy)).failureCode, 'body_busy');
    assert.equal((await gate.submit('b', request('b', 'gather', { block: 'oak_log' }))).status, 'succeeded');
    await gate.submit('a', request('a', 'stop_action'));
    await hanging;
});

test('cancellation clears the action, leaving the body usable', async t => {
    const { gate, request, world } = setup(t);
    const hanging = gate.submit('a', request('a', 'mock_hang'));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(world.isMoving('a'), true);
    const stop = await gate.submit('a', request('a', 'stop_action'));
    assert.equal(stop.status, 'succeeded');
    assert.equal((await hanging).status, 'cancelled');
    assert.equal(world.isMoving('a'), false);
    assert.equal(gate.activeAction('a'), null);
    assert.equal((await gate.submit('a', request('a', 'gather', { block: 'oak_log' }))).status, 'succeeded');
});

test('a stale observation is refused and can be retried after a refresh', async t => {
    const { gate, request, world } = setup(t);
    const req = request('a', 'gather', { block: 'oak_log' });
    world.observe('a');
    const result = await gate.submit('a', req);
    assert.equal(result.failureCode, 'stale_observation');
    assert.equal(result.retryable, true);
});

test('a past deadline is refused', async t => {
    const { gate, request } = setup(t);
    assert.equal(
        (await gate.submit('a', request('a', 'gather', { block: 'oak_log' }, { deadlineMonotonicMs: 1 }))).failureCode,
        'deadline_passed',
    );
});

test('revocation denies new actions immediately and cancels running ones', async t => {
    const { gate, request } = setup(t);
    const hanging = gate.submit('a', request('a', 'mock_hang'));
    await new Promise(r => setTimeout(r, 10));
    const revoke = gate.revoke('operator_stop');
    assert.equal(
        (await gate.submit('b', request('b', 'gather', { block: 'oak_log' }))).failureCode,
        'admission_revoked',
    );
    assert.deepEqual(await revoke, { cancelled: 1, settled: true });
    assert.equal((await hanging).status, 'cancelled');
});

test('an action with no recorded result after a restart reports uncertainty and never reruns', async t => {
    const { gate, request, store, world } = setup(t);
    const req = request('a', 'gather', { block: 'oak_log' });
    const requestHash = hashOf({ tool: req.tool, args: req.args });
    store.admitAction({ runId: 'r', actorId: 'a', actionId: req.actionId, requestHash });
    // Before reconciliation the retry already refuses to run, because the first attempt has no recorded result.
    assert.equal((await gate.submit('a', req)).failureCode, 'outcome_uncertain');
    assert.equal(reconcileUnfinishedActions(store, 'r'), 1);
    assert.equal(store.unfinishedActions('r').length, 0);
    const retried = await gate.submit('a', req);
    assert.equal(retried.status, 'partial');
    assert.equal(retried.failureCode, 'outcome_uncertain');
    assert.deepEqual(world.observe('a').inventory, {});
});

test('state machine: legal path, idempotent repeats and illegal jumps', t => {
    const dir = tempDir(t);
    const store = new ControlStore(path.join(dir, 'control.sqlite'));
    t.after(() => store.close());
    store.createRun({ runId: 'r', configHash: 'h', runDir: dir });
    assert.throws(() => store.transition('r', 'RUNNING'), /Illegal transition CREATED -> RUNNING/);
    for (const state of ['PREFLIGHT', 'PREPARED', 'READY', 'RUNNING', 'STOPPING', 'FINALIZING', 'COMPLETED'])
        assert.equal(store.transition('r', state).changed, true);
    assert.equal(store.transition('r', 'COMPLETED').changed, false);
    assert.throws(() => store.transition('r', 'RUNNING'), /Illegal/);
    assert.equal(store.transitions('r').length, 8);
    assert.deepEqual(TRANSITIONS.COMPLETED, []);
});

test('state transitions are durable across a reopened store', t => {
    const dir = tempDir(t);
    const file = path.join(dir, 'control.sqlite');
    const first = new ControlStore(file);
    first.createRun({ runId: 'r', configHash: 'h', runDir: dir, controllerPid: 1 });
    first.transition('r', 'PREFLIGHT');
    first.close();
    const second = new ControlStore(file);
    t.after(() => second.close());
    assert.equal(second.run('r').state, 'PREFLIGHT');
    assert.equal(second.openRuns().length, 1);
});

test('the event log validates envelopes, keeps per-source sequences and finds gaps', t => {
    const dir = tempDir(t);
    const file = path.join(dir, 'events.jsonl');
    const log = new EventLog({ runId: 'r', file });
    log.emit({ source: 'mock-server', type: 'a.b', evidenceQuality: 'mock' });
    log.emit({ source: 'controller', type: 'a.b', evidenceQuality: 'operational' });
    log.emit({ source: 'mock-server', type: 'a.c', evidenceQuality: 'mock' });
    assert.throws(() => log.emit({ source: 'x', type: 'BAD', evidenceQuality: 'mock' }), /Invalid event/);
    assert.throws(() => log.emit({ source: 'x', type: 'a.b', evidenceQuality: 'vibes' }), /Invalid event/);
    log.close();
    const { events, malformed } = readEvents(file);
    assert.equal(malformed, 0);
    assert.deepEqual(
        events.map(e => e.collectorSeq),
        [1, 2, 3],
    );
    assert.deepEqual(sequenceGaps(events), []);
    assert.deepEqual(sequenceGaps(events.filter(e => e.sourceSeq !== 1 || e.source !== 'mock-server')), [
        { source: 'mock-server', missingFrom: 1, missingTo: 1 },
    ]);
});

test('secrets in event payloads are redacted', t => {
    const dir = tempDir(t);
    const file = path.join(dir, 'events.jsonl');
    const log = new EventLog({ runId: 'r', file });
    log.emit({
        source: 's',
        type: 'a.b',
        evidenceQuality: 'operational',
        payload: { apiKey: 'abc', note: 'token sk-abcdefghijklmn here', count: 3 },
    });
    log.close();
    const [event] = readEvents(file).events;
    assert.equal(event.payload.apiKey, '[REDACTED]');
    assert.equal(event.payload.note, '[REDACTED]');
    assert.equal(event.payload.count, 3);
});
