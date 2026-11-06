import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runLab, STOP_TARGET_MS, assignParticipants, preflightBlockers } from '../../../lab/controller/controller.js';
import { pidAlive, verifyIntegrity } from '../../../lab/controller/finalize.js';
import { resolveLabConfig } from '../../../lab/config/load.js';
import { readEvents } from '../../../lab/events/log.js';
import { FAKE_PRICING, mockConfig, resolveMock, tempDir } from '../fixtures/helpers.js';

const eventsOf = result => readEvents(path.join(result.runDir, 'events.jsonl')).events;
const run = (t, overrides = {}, options = {}) =>
    runLab({ resolved: resolveMock(overrides), runsDir: tempDir(t), env: options.env ?? {}, ...options });

test('one command completes an honest offline run with no spending', async t => {
    const result = await run(t);
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.reason, 'deadline');
    assert.equal(result.validity.valid, true);
    assert.equal(result.score.points, 100);
    assert.equal(result.score.evidenceClass, 'mock', 'mock evidence stays labelled as mock');
    assert.equal(result.spending.settledMicros, 0);
    assert.equal(result.spending.unsettledExposureMicros, 0);
    assert.equal(result.spending.providerRequests, 0);
    assert.ok(result.spending.mockRequests > 0);
});

test('every required artifact exists, is redacted and passes its hash check', async t => {
    const result = await run(t, {}, { env: { ANTHROPIC_API_KEY: 'sk-shouldnotappearanywhere' } });
    for (const name of [
        'manifest.json',
        'resolved-config.json',
        'events.jsonl',
        'score.json',
        'usage.json',
        'report.md',
        'cleanup.json',
        'integrity.json',
    ])
        assert.ok(existsSync(path.join(result.runDir, name)), name);
    assert.deepEqual(verifyIntegrity(result.runDir), { ok: true, problems: [] });
    const manifest = JSON.parse(readFileSync(path.join(result.runDir, 'manifest.json'), 'utf8'));
    for (const key of [
        'runId',
        'execution',
        'validity',
        'code',
        'environment',
        'scenario',
        'configHash',
        'model',
        'limits',
        'policy',
        'assignmentSeed',
        'participants',
        'pricing',
        'timing',
        'spending',
        'artifactCompleteness',
    ])
        assert.ok(manifest[key] !== undefined, key);
    assert.deepEqual(manifest.interventions, []);
    assert.deepEqual(manifest.approvals, []);
    for (const name of ['manifest.json', 'events.jsonl', 'resolved-config.json', 'report.md'])
        assert.doesNotMatch(readFileSync(path.join(result.runDir, name), 'utf8'), /sk-shouldnotappearanywhere/, name);
});

test('the report leads with the result and states plainly that this is a mock', async t => {
    const result = await run(t);
    const report = readFileSync(result.reportPath, 'utf8');
    const head = report.slice(0, 900);
    assert.match(head, /MOCK RUN/);
    assert.match(head, /Execution:\*\* COMPLETED/);
    assert.match(head, /Validity:\*\* valid/);
    assert.match(head, /Spending:\*\*/);
    assert.match(head, /Biggest blocker:\*\*/);
    assert.match(report, /## Timeline/);
    assert.doesNotMatch(head, /\bauthoritative evidence\b/);
});

test('ready barrier: everyone joins before the clock starts, and no one acts earlier', async t => {
    const result = await run(t, { agents: 4 });
    const events = eventsOf(result);
    const clock = events.findIndex(e => e.type === 'world.clock_start');
    const joins = events.map((e, i) => (e.type === 'player.join' ? i : -1)).filter(i => i >= 0);
    assert.equal(joins.length, 4);
    assert.ok(joins.every(i => i < clock));
    const firstAction = events.findIndex(e => e.type === 'action.started');
    assert.ok(firstAction > clock);
    assert.equal(events.filter(e => e.type === 'run.state' && e.payload.state === 'RUNNING').length, 1);
});

test('the terminal snapshot is taken with the team still connected', async t => {
    const events = eventsOf(await run(t));
    const terminal = events.find(e => e.type === 'terminal.snapshot');
    assert.ok(terminal.payload.players.every(p => p.connected));
    const quits = events.filter(e => e.type === 'player.quit');
    assert.equal(quits.length, 2);
    assert.ok(quits.every(q => q.collectorSeq > terminal.collectorSeq));
});

test('a false claim does not change the independent score', async t => {
    const result = await run(t, {}, { hooks: { workerBehavior: { all: 'claim_only' } } });
    assert.equal(result.state, 'COMPLETED', 'a poor result is still a valid run');
    assert.equal(result.score.points, 0);
    assert.equal(result.score.primaryCompletion, false);
    const claims = eventsOf(result).filter(e => e.type === 'agent.claim');
    assert.equal(claims.length, 2);
    assert.ok(claims.every(c => c.evidenceQuality === 'claim'));
    assert.equal(result.score.integrity.ignoredNonAuthoritativeEvents > 0, true);
});

test('an honest team that also boasts keeps exactly its earned score', async t => {
    const result = await run(t, {}, { hooks: { workerBehavior: { all: 'false_claim' } } });
    assert.equal(result.score.points, 100);
});

test('identity spoof and forbidden tools from a live worker process are rejected', async t => {
    const participants = assignParticipants(2, 1);
    const [attacker, victim] = participants;
    const result = await run(t, {}, { hooks: { workerBehavior: { [attacker]: 'spoof' }, spoofActor: victim } });
    const events = eventsOf(result);
    const rejected = events
        .filter(e => e.type === 'security.rejected' && e.actorId === attacker)
        .map(e => e.payload.kind);
    assert.deepEqual(rejected.sort(), ['invalid_action_request', 'run_mismatch', 'tool_forbidden']);
    assert.equal(events.filter(e => e.type === 'action.started' && e.payload.actionId?.startsWith('spoof')).length, 0);
    assert.equal(events.filter(e => e.type === 'action.started' && e.payload.tool === 'run_shell').length, 0);
    assert.equal(result.score.points, 100, 'the victim and the attacker keep only what they earned');
    assert.equal(result.state, 'COMPLETED', 'a refused attempt is logged, not a breach');
});

test('a worker holds no secrets and cannot read, write or spawn outside its permissions', async t => {
    const dir = tempDir(t);
    const forbiddenFile = path.join(dir, 'other-agent-notes.txt');
    writeFileSync(forbiddenFile, 'private');
    const reports = [];
    await runLab({
        resolved: resolveMock({ agents: 1 }),
        runsDir: tempDir(t),
        env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            ANTHROPIC_API_KEY: 'sk-parentsecret12345',
            OPENAI_API_KEY: 'sk-parentsecret67890',
            AGENT_SANDBOX: 'local',
            MC_HOST: 'evil.example',
        },
        hooks: {
            workerBehavior: { all: 'probe' },
            forbiddenFile,
            onWorkerReport: (actor, report) => reports.push(report),
        },
    });
    const { probe } = reports.find(r => r.kind === 'boundary_probe');
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AGENT_SANDBOX', 'MC_HOST', 'LAB_WORKER_TOKEN'])
        assert.ok(!probe.envKeys.includes(name), name);
    assert.equal(probe.readForbiddenFile, 'ERR_ACCESS_DENIED');
    assert.equal(probe.writeForbiddenFile, 'ERR_ACCESS_DENIED');
    assert.equal(probe.spawnProcess, 'ERR_ACCESS_DENIED');
    assert.equal(existsSync(`${forbiddenFile}.written-by-worker`), false);
});

test('operator stop: admission closes at once and workers are gone inside the target', async t => {
    let actionRefused;
    const result = await run(
        t,
        { runtime: { durationSeconds: 60 } },
        {
            hooks: {
                onRunning: ({ requestEnd, gate }) =>
                    setTimeout(async () => {
                        requestEnd('operator_stop');
                        await new Promise(resolve => setTimeout(resolve, 1));
                        actionRefused = gate.revoked;
                    }, 150),
            },
        },
    );
    assert.equal(result.state, 'ABORTED');
    assert.equal(result.reason, 'operator_stop');
    assert.equal(actionRefused, 'operator_stop');
    assert.ok(result.stopTiming.workerTerminationMs < STOP_TARGET_MS, `${result.stopTiming.workerTerminationMs} ms`);
    assert.equal(result.cleanup.workersGone, true);
    assert.equal(result.score.integrity.terminalSnapshot, false, 'an emergency stop does not fake a final state');
    for (const c of result.score.components) assert.equal(c.outcome, 'unsupported');
});

for (const behavior of ['ignore_shutdown', 'spin'])
    test(`a worker that will not stop (${behavior}) is killed inside the target`, async t => {
        const workers = [];
        const result = await run(
            t,
            { runtime: { durationSeconds: 60 } },
            {
                hooks: {
                    workerBehavior: { all: behavior },
                    onRunning: ({ requestEnd, workers: live }) => {
                        for (const w of live.values()) workers.push(w.child.pid);
                        setTimeout(() => requestEnd('operator_stop'), 200);
                    },
                },
            },
        );
        assert.equal(result.stopTiming.forcedKills, 2);
        assert.ok(
            result.stopTiming.workerTerminationMs < STOP_TARGET_MS,
            `${result.stopTiming.workerTerminationMs} ms`,
        );
        assert.ok(workers.every(pid => !pidAlive(pid)));
    });

test('a missing terminal snapshot at the deadline makes the run invalid', async t => {
    const result = await run(t, {}, { hooks: { skipTerminal: true } });
    assert.equal(result.state, 'INVALID');
    assert.match(result.validity.reason, /missing terminal snapshot/);
    assert.equal(result.score.primaryCompletion, false);
});

test('budget rejection blocks new requests, keeps terminal evidence and is a valid outcome', async t => {
    const pricing = { ...FAKE_PRICING, provider: 'mock', modelId: 'scripted-v1' };
    const result = await run(t, { runtime: { durationSeconds: 30 } }, { pricing });
    assert.equal(result.reason, 'budget_exhausted');
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.score.integrity.terminalSnapshot, true);
    assert.equal(result.spending.requests, 0);
    assert.ok(eventsOf(result).some(e => e.type === 'broker.rejected' && e.payload.code === 'run_budget'));
});

test('a bad worker identity at the barrier makes the run invalid before any gameplay', async t => {
    const [first] = assignParticipants(2, 1);
    const result = await run(t, { runtime: { durationSeconds: 30 } }, { hooks: { badToken: { [first]: true } } });
    assert.equal(result.state, 'INVALID');
    assert.equal(result.reason, 'integrity_breach');
    assert.equal(eventsOf(result).filter(e => e.type === 'action.started').length, 0);
    assert.equal(result.score, null);
});

test('a CLI transport tool attempt ends the whole run as invalid', async t => {
    const provider = {
        name: 'mock',
        invoke: async () => {
            throw Object.assign(new Error('Claude CLI attempted tool Bash'), { kind: 'policy_violation' });
        },
    };
    const result = await run(t, { runtime: { durationSeconds: 30 } }, { provider });
    assert.equal(result.state, 'INVALID');
    assert.equal(result.reason, 'integrity_breach');
});

test('a worker crash is recorded and the rest of the run carries on', async t => {
    const [first] = assignParticipants(2, 1);
    const result = await run(t, {}, { hooks: { workerBehavior: { [first]: 'crash' } } });
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.score.primaryCompletion, false);
    const crash = eventsOf(result).filter(
        e => e.type === 'worker.crash' || (e.type === 'worker.report' && e.actorId === first),
    );
    assert.ok(crash.length > 0);
});

test('a provider timeout keeps its liability in the run totals and report', async t => {
    const result = await run(t, {}, { hooks: { providerFaults: ['timeout'], requestTimeoutMs: 100 } });
    assert.ok(eventsOf(result).some(e => e.type === 'broker.ambiguous'));
    assert.equal(result.state, 'COMPLETED');
});

test('world and session reset: a second run inherits nothing from the first', async t => {
    const runsDir = tempDir(t);
    const resolved = resolveMock();
    const first = await runLab({ resolved, runsDir, env: {} });
    const second = await runLab({ resolved, runsDir, env: {} });
    assert.notEqual(first.runId, second.runId);
    assert.notEqual(first.runDir, second.runDir);
    const pickups = eventsOf(second).filter(e => e.type === 'item.pickup' && e.payload.item === 'oak_log');
    assert.equal(pickups.length, 8, 'both agents collected their logs again from nothing');
    const firstActions = eventsOf(second)
        .filter(e => e.type === 'action.finished')
        .map(e => e.payload.actionId);
    assert.ok(firstActions.includes('act-1'), 'action ids from run one do not replay as duplicates');
    assert.equal(second.score.points, 100);
});

test('paid mode cannot start, and no provider is called', async t => {
    let calls = 0;
    const raw = mockConfig({
        mode: 'paid',
        campaignId: 'pilot',
        runtime: {
            paperBuild: 1,
            serverImageDigest: `sha256:${'0'.repeat(64)}`,
            fixtureId: 'f',
            fixtureSha256: '0'.repeat(64),
        },
        model: { provider: 'fake-paid', id: 'fake-model-1', pricingRecord: 'fake.json' },
        limits: { runBudgetUsd: 5, campaignBudgetUsd: 5, maxProviderRequests: 10 },
    });
    const resolved = resolveLabConfig(raw, { env: {} });
    const result = await runLab({
        resolved,
        runsDir: tempDir(t),
        env: {},
        provider: { name: 'fake-paid', invoke: async () => void calls++ },
    });
    assert.equal(result.state, 'ABORTED');
    assert.equal(result.reason, 'preflight_failed');
    assert.equal(calls, 0);
    assert.equal(result.spending.requests, 0);
});

test('subscription mode is blocked until it is built and approved', () => {
    const resolved = resolveLabConfig(
        mockConfig({
            mode: 'subscription',
            campaignId: 'pilot',
            model: { provider: 'claude-cli', id: 'x' },
            limits: { maxProviderRequests: 5 },
        }),
        { env: {} },
    );
    assert.match(preflightBlockers(resolved).join(' '), /not available yet/);
});

test('the mock adapter refuses to pretend it can play Settlement-60', () => {
    const resolved = resolveMock({ scenario: 'settlement-60-v0.1', agents: 4 });
    assert.match(preflightBlockers(resolved).join(' '), /cannot play settlement-60-v0.1/);
});

test('participant assignment is recorded and follows the seed', () => {
    assert.deepEqual(assignParticipants(4, 7), assignParticipants(4, 7));
    assert.deepEqual([...assignParticipants(4, 7)].sort(), ['agent-a', 'agent-b', 'agent-c', 'agent-d']);
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => assignParticipants(4, seed).join()));
    assert.ok(orders.size > 1);
});

// Blocked on infrastructure, and reported as blocked rather than passed. See docs/SECURITY.md.
test(
    'secret/network boundary: no route from a worker to the host, LAN, metadata or internet',
    {
        skip: 'NOT QUALIFIED: needs the disposable Linux VM. Node --permission on this version does not restrict network access.',
    },
    () => {},
);
test(
    'no operator privileges: admin commands and forbidden mutations fail on a real server',
    { skip: 'BLOCKED: needs a Paper server (M2), which needs the operator to accept the Minecraft EULA.' },
    () => {},
);
