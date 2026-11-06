import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CoordinationService } from '../../../lab/coordination/service.js';
import { FIXTURES, tempDir } from '../fixtures/helpers.js';

const ROSTER = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];

function setup(t, runId = 'r') {
    const file = path.join(tempDir(t), 'coord.sqlite');
    const clock = { now: 1000 };
    const service = new CoordinationService({ file, runId, roster: ROSTER, now: () => clock.now });
    t.after(() => service.close());
    return { service, clock, file, a: service.forActor('agent-a'), b: service.forActor('agent-b') };
}
const makeTask = (api, taskId = 't1', extra = {}) =>
    api.taskCreate({ taskId, description: 'mine stone', criterion: 'ten cobblestone in chest', ...extra });

test('an actor outside the roster gets no handle', t => {
    const { service } = setup(t);
    assert.throws(() => service.forActor('intruder'), /not on this run's roster/);
});

test('claiming is compare-and-swap: one owner, and the loser learns why', t => {
    const { a, b } = setup(t);
    makeTask(a);
    assert.equal(a.taskClaim({ taskId: 't1', expectedRevision: 1 }).ok, true);
    assert.equal(b.taskClaim({ taskId: 't1', expectedRevision: 1 }).code, 'stale_revision');
    assert.equal(b.taskClaim({ taskId: 't1', expectedRevision: 2 }).code, 'not_claimable');
});

test('task race: separate processes claiming at once yield one owner', async t => {
    const { a, file, service } = setup(t, 'race');
    makeTask(a, 'contested');
    const startAt = Date.now() + 1000;
    const results = await Promise.all(
        ROSTER.map(
            name =>
                new Promise((resolve, reject) => {
                    let out = '';
                    const child = spawn(process.execPath, [
                        '--disable-warning=ExperimentalWarning',
                        path.join(FIXTURES, 'reserve-worker.mjs'),
                        'claim',
                        file,
                        name,
                        String(startAt),
                        ...ROSTER,
                    ]);
                    child.stdout.on('data', d => (out += d));
                    child.on('close', code =>
                        code === 0 ? resolve(JSON.parse(out)[0]) : reject(new Error(`exit ${code}`)),
                    );
                }),
        ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.ok(ROSTER.includes(service.forActor('agent-a').taskList()[0].owner));
});

test('a blocked task can be reopened by any member and claimed again', t => {
    const { a, b } = setup(t);
    makeTask(a);
    const claim = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    const blocked = a.taskUpdate({ taskId: 't1', revision: claim.revision, status: 'blocked', blocker: 'no stone' });
    assert.equal(b.taskClaim({ taskId: 't1', expectedRevision: blocked.revision }).code, 'not_claimable');
    const reopened = b.taskReopen({ taskId: 't1', revision: blocked.revision });
    assert.equal(reopened.ok, true);
    const [task] = b.taskList();
    assert.equal(task.status, 'open');
    assert.equal(task.blocker, null);
    assert.equal(b.taskClaim({ taskId: 't1', expectedRevision: reopened.revision }).ok, true);
});

test('a task blocked by the no-progress sweep can be reopened, which frees its dependents', t => {
    const { a, b, clock, service } = setup(t);
    makeTask(a);
    makeTask(a, 't2', { dependencies: ['t1'] });
    const first = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    let revision = first.revision;
    // Heartbeats keep the lease alive without evidence, so the sweep blocks the task on no progress.
    for (let n = 0; n < 4; n++) {
        clock.now += 100000;
        revision = a.taskUpdate({ taskId: 't1', revision }).revision;
    }
    clock.now += 1;
    const stuck = b.taskList().find(task => task.task_id === 't1');
    assert.equal(stuck.status, 'blocked');
    const reopened = b.taskReopen({ taskId: 't1', revision: stuck.revision });
    const claimed = b.taskClaim({ taskId: 't1', expectedRevision: reopened.revision });
    const submitted = b.taskUpdate({ taskId: 't1', revision: claimed.revision, status: 'submitted' });
    assert.equal(submitted.ok, true);
    service.verifier().verifyTask('t1');
    assert.equal(b.taskClaim({ taskId: 't2', expectedRevision: 1 }).ok, true);
});

test('reopening is fenced and only applies to blocked tasks', t => {
    const { a, b } = setup(t);
    makeTask(a);
    assert.equal(b.taskReopen({ taskId: 'nope', revision: 1 }).code, 'unknown_task');
    assert.equal(b.taskReopen({ taskId: 't1', revision: 1 }).code, 'not_reopenable');
    const claim = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    assert.equal(b.taskReopen({ taskId: 't1', revision: claim.revision }).code, 'not_reopenable');
    const blocked = a.taskUpdate({ taskId: 't1', revision: claim.revision, status: 'blocked' });
    assert.equal(b.taskReopen({ taskId: 't1', revision: claim.revision }).code, 'stale_revision');
    const once = b.taskReopen({ taskId: 't1', revision: blocked.revision, requestId: 'r1' });
    assert.deepEqual(b.taskReopen({ taskId: 't1', revision: blocked.revision, requestId: 'r1' }), once);
    assert.equal(a.taskReopen({ taskId: 't1', revision: blocked.revision }).code, 'stale_revision');
});

test('a failed task stays failed: it cannot be reopened', t => {
    const { a, b } = setup(t);
    makeTask(a);
    const claim = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    const failed = a.taskUpdate({ taskId: 't1', revision: claim.revision, status: 'failed' });
    assert.equal(b.taskReopen({ taskId: 't1', revision: failed.revision }).code, 'not_reopenable');
});

test('lease expiry: a new owner can claim, and the stale owner is fenced', t => {
    const { a, b, clock, service } = setup(t);
    makeTask(a);
    const claim = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    clock.now += 120001;
    const [open] = b.taskList();
    assert.equal(open.status, 'open');
    assert.equal(open.owner, null);
    const taken = b.taskClaim({ taskId: 't1', expectedRevision: open.revision });
    assert.equal(taken.ok, true);
    assert.equal(a.taskUpdate({ taskId: 't1', revision: claim.revision, evidence: ['late'] }).code, 'stale_fence');
    assert.equal(a.taskRelease({ taskId: 't1', revision: claim.revision }).code, 'stale_fence');
    assert.equal(service.checkFence('agent-a', 't1', claim.revision).code, 'stale_fence');
    assert.equal(service.checkFence('agent-b', 't1', taken.revision).ok, true);
});

test('heartbeats alone cannot keep a task forever', t => {
    const { a, clock } = setup(t);
    makeTask(a);
    let { revision } = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    for (let i = 0; i < 11; i++) {
        clock.now += 30000;
        const beat = a.taskUpdate({ taskId: 't1', revision });
        if (!beat.ok) break;
        revision = beat.revision;
    }
    const [task] = a.taskList();
    assert.equal(task.status, 'blocked');
    assert.match(task.blocker, /No fresh evidence/);
    assert.equal(task.owner, null);
});

test('fresh evidence keeps a task, and a declared wait is honoured until it ends', t => {
    const { a, clock } = setup(t);
    makeTask(a);
    let { revision } = a.taskClaim({ taskId: 't1', expectedRevision: 1 });
    for (let i = 0; i < 20; i++) {
        clock.now += 30000;
        revision = a.taskUpdate({ taskId: 't1', revision, evidence: [`event-${i}`] }).revision;
    }
    assert.equal(a.taskList()[0].owner, 'agent-a');
    revision = a.taskUpdate({ taskId: 't1', revision, waitUntilMs: clock.now + 400000 }).revision;
    for (let i = 0; i < 12; i++) {
        clock.now += 30000;
        revision = a.taskUpdate({ taskId: 't1', revision }).revision;
    }
    assert.equal(a.taskList()[0].owner, 'agent-a');
    clock.now += 700000;
    assert.notEqual(a.taskList()[0].owner, 'agent-a');
});

test('duplicate requests are idempotent', t => {
    const { a } = setup(t);
    const first = makeTask(a, 't1', { requestId: 'create-1' });
    assert.deepEqual(makeTask(a, 't1', { requestId: 'create-1' }), first);
    assert.equal(makeTask(a, 't1').code, 'task_exists');
    const claim = a.taskClaim({ taskId: 't1', expectedRevision: 1, requestId: 'claim-1' });
    assert.deepEqual(a.taskClaim({ taskId: 't1', expectedRevision: 1, requestId: 'claim-1' }), claim);
    const update = a.taskUpdate({ taskId: 't1', revision: claim.revision, evidence: ['e1'], requestId: 'u-1' });
    assert.deepEqual(
        a.taskUpdate({ taskId: 't1', revision: claim.revision, evidence: ['e1'], requestId: 'u-1' }),
        update,
    );
    assert.deepEqual(a.taskList()[0].evidence, ['e1']);
});

test('an agent cannot verify its own work, and dependencies must be verified first', t => {
    const { a, b, service } = setup(t);
    makeTask(a, 'first');
    makeTask(a, 'second', { dependencies: ['first'] });
    assert.equal(b.taskClaim({ taskId: 'second', expectedRevision: 1 }).code, 'dependencies_unmet');
    const claim = a.taskClaim({ taskId: 'first', expectedRevision: 1 });
    assert.equal(
        a.taskUpdate({ taskId: 'first', revision: claim.revision, status: 'verified' }).code,
        'status_not_allowed',
    );
    a.taskUpdate({ taskId: 'first', revision: claim.revision, status: 'submitted', evidence: ['e'] });
    assert.equal(b.taskClaim({ taskId: 'second', expectedRevision: 1 }).code, 'dependencies_unmet');
    assert.equal(service.verifier().verifyTask('first').ok, true);
    assert.equal(b.taskClaim({ taskId: 'second', expectedRevision: 1 }).ok, true);
});

test('runs are isolated in a shared database', t => {
    const { a, file } = setup(t, 'run-1');
    makeTask(a);
    const other = new CoordinationService({ file, runId: 'run-2', roster: ROSTER });
    t.after(() => other.close());
    assert.deepEqual(other.forActor('agent-a').taskList(), []);
    assert.equal(other.forActor('agent-a').taskClaim({ taskId: 't1', expectedRevision: 1 }).code, 'unknown_task');
});

test('facts are only ever reported by agents, with contradictions and history preserved', t => {
    const { a, b, service } = setup(t);
    const first = a.factPublish({ subject: 'mining', value: 'failed once with this tool', observationTick: 100 });
    assert.equal(first.status, 'reported');
    assert.equal(a.factPublish({ subject: 'x', value: 1, observationTick: 1, status: 'verified' }).status, 'reported');
    b.factPublish({ subject: 'mining', value: 'mining works', observationTick: 200 });
    const facts = a.factQuery({ subject: 'mining', currentTick: 200 });
    assert.deepEqual(
        facts.map(f => f.status),
        ['disputed', 'disputed'],
    );
    assert.deepEqual(
        facts.map(f => f.source_agent),
        ['agent-a', 'agent-b'],
    );
    const chest = a.factPublish({ subject: 'chest', value: 'at spawn', observationTick: 1, expiresTick: 50 });
    assert.equal(a.factQuery({ subject: 'chest', currentTick: 51 })[0].status, 'expired');
    service.verifier().verifyFact(chest.factId);
    assert.equal(a.factQuery({ subject: 'chest', currentTick: 10 })[0].status, 'verified');
});

test('reservation race: accepted quantities never exceed observed stock', async t => {
    const { a, file, service } = setup(t, 'race');
    assert.equal(a.stockObserve({ container: 'chest', item: 'bread', quantity: 10, observedTick: 1 }).revision, 1);
    const startAt = Date.now() + 1000;
    const results = await Promise.all(
        ROSTER.map(
            name =>
                new Promise((resolve, reject) => {
                    let out = '';
                    const child = spawn(process.execPath, [
                        '--disable-warning=ExperimentalWarning',
                        path.join(FIXTURES, 'reserve-worker.mjs'),
                        'reserve',
                        file,
                        name,
                        String(startAt),
                        ...ROSTER,
                    ]);
                    child.stdout.on('data', d => (out += d));
                    child.on('close', code =>
                        code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`)),
                    );
                }),
        ),
    );
    assert.equal(results.flat().filter(Boolean).length, 3, '3 x 3 fits in 10; a fourth would not');
    assert.equal(
        service
            .forActor('agent-b')
            .resourceReserve({ container: 'chest', item: 'bread', quantity: 2, stockRevision: 1 }).code,
        'insufficient_stock',
    );
});

test('stale stock forces revalidation, and releasing frees quantity for its owner only', t => {
    const { a, b } = setup(t);
    a.stockObserve({ container: 'c', item: 'bread', quantity: 4, observedTick: 1 });
    const held = a.resourceReserve({ container: 'c', item: 'bread', quantity: 4, stockRevision: 1 });
    assert.equal(held.ok, true);
    b.stockObserve({ container: 'c', item: 'bread', quantity: 6, observedTick: 2 });
    assert.equal(
        a.resourceReserve({ container: 'c', item: 'bread', quantity: 1, stockRevision: 1 }).code,
        'stale_stock',
    );
    assert.equal(b.resourceRelease({ reservationId: held.reservationId }).code, 'not_owner');
    assert.equal(
        b.resourceReserve({ container: 'c', item: 'bread', quantity: 3, stockRevision: 2 }).code,
        'insufficient_stock',
    );
    a.resourceRelease({ reservationId: held.reservationId });
    assert.equal(b.resourceReserve({ container: 'c', item: 'bread', quantity: 3, stockRevision: 2 }).ok, true);
    assert.equal(
        a.resourceReserve({ container: 'nowhere', item: 'bread', quantity: 1, stockRevision: 1 }).code,
        'unknown_stock',
    );
});
