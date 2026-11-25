import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statfsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createActionGate, reconcileUnfinishedActions } from '../adapter/action-gate.js';
import { createMockWorld } from '../adapter/mock-world.js';
import { assertAllowlistSafe } from '../adapter/tool-policy.js';
import { buildWorkerEnv } from '../adapter/upstream.js';
import { createBroker } from '../broker/broker.js';
import { Ledger } from '../broker/ledger.js';
import { createMockProvider } from '../broker/mock-provider.js';
import { MOCK_PRICING } from '../broker/pricing.js';
import { hasScorer } from '../evaluator/score.js';
import { EventLog } from '../events/log.js';
import { LAB_ROOT, redact, usdToMicros, writeDurable } from '../lib/util.js';
import { codeIdentity, finalizeRun, isUpstreamAncestor, pidAlive } from './finalize.js';
import { ControlStore, TERMINAL_STATES } from './store.js';

const WORKER_DIR = path.join(LAB_ROOT, 'adapter');
const WORKER_PATH = path.join(WORKER_DIR, 'mock-worker.cjs');
const MIN_NODE = [22, 19];
const MOCK_REQUEST_CEILING = 20000;
const MAX_RPC_PER_WORKER = 50000;
const MAX_LOG_BYTES = 1024 * 1024;
const BUDGET_CODES = new Set(['run_budget', 'campaign_budget', 'request_limit']);
export const STOP_TARGET_MS = 5000;

export const controlPath = runsDir => path.join(runsDir, 'control.sqlite');
export const ledgerPath = runsDir => path.join(runsDir, 'ledger.sqlite');

export function preflightBlockers(resolved) {
    const { config, scenario } = resolved;
    const blockers = [];
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]))
        blockers.push(`Node ${process.version} is older than ${MIN_NODE.join('.')}`);
    if (config.mode === 'paid')
        blockers.push(
            'Paid mode is not available: no provider transport is implemented and no operator approval record exists',
        );
    if (config.mode === 'subscription')
        blockers.push(
            'Subscription runs are not available yet: the bounded model loop over real game tools (M2/M3) is not built and no run has been approved. lab:transport-check tests the CLI login on its own.',
        );
    if (config.mode === 'mock' && scenario.scorer !== 'tool-qualification')
        blockers.push(`The mock adapter cannot play ${scenario.id}; its predicates are tested with fixtures only`);
    if (!hasScorer(scenario.scorer)) blockers.push(`No scorer for ${scenario.scorer}`);
    if (scenario.requiredAgents && scenario.requiredAgents !== config.agents)
        blockers.push(`Scenario ${scenario.id} needs ${scenario.requiredAgents} agents`);
    try {
        assertAllowlistSafe([...scenario.tools]);
    } catch (error) {
        blockers.push(error.message);
    }
    if (config.runtime.upstreamCommit && !isUpstreamAncestor(config.runtime.upstreamCommit))
        blockers.push(`Pinned upstream commit ${config.runtime.upstreamCommit} is not an ancestor of HEAD`);
    if (!existsSync(WORKER_PATH)) blockers.push('Worker entry point is missing');
    return blockers;
}

// Seeded so directory order and spawn assignment are recorded and repeatable rather than accidental.
export function assignParticipants(count, seed = 0) {
    const names = ['agent-a', 'agent-b', 'agent-c', 'agent-d'].slice(0, count);
    let state = (seed >>> 0) + 1;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const order = [...names];
    for (let i = order.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

// Runs before anything else on every controller start. A run whose controller died is never resumed: it is closed as
// ABORTED and whatever was in flight keeps its liability until reconciled.
export function recoverInterrupted({ store, ledger }) {
    const open = store.openRuns();
    const live = open.filter(
        run => run.controller_pid && run.controller_pid !== process.pid && pidAlive(run.controller_pid),
    );
    const dead = open.filter(run => !live.includes(run));
    ledger.recoverInFlight({ exceptRunIds: live.map(run => run.run_id) });
    const recovered = [];
    for (const run of dead) {
        const snapshotFile = path.join(run.run_dir, 'resolved-config.json');
        const snapshot = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : null;
        reconcileUnfinishedActions(store, run.run_id);
        if (!['STOPPING', 'FINALIZING'].includes(run.state))
            store.transition(run.run_id, 'STOPPING', { detail: 'controller_failure', reason: 'controller_failure' });
        store.transition(run.run_id, 'FINALIZING', { reason: 'controller_failure' });
        const result = finalizeRun({
            runId: run.run_id,
            runDir: run.run_dir,
            snapshot,
            reason: 'controller_failure',
            ledger,
            store,
            participants: snapshot?.participants ?? [],
            mode: snapshot?.config?.mode ?? 'unknown',
            extra: {
                provenance: 'recovered after controller failure',
                evidenceClass: snapshot?.evidenceClass ?? 'mock',
            },
        });
        store.transition(run.run_id, result.state, { reason: 'controller_failure' });
        recovered.push({ runId: run.run_id, state: result.state });
    }
    return recovered;
}

function spawnWorker({ actorId, runId, workspace, logDir, token, parentEnv, behavior, hooks, farFutureDeadlineMs }) {
    const options = {
        runId,
        behavior: behavior ?? 'normal',
        farFutureDeadlineMs,
        forbiddenFile: hooks.forbiddenFile,
        spoofActor: hooks.spoofActor,
    };
    const child = fork(WORKER_PATH, [JSON.stringify(options)], {
        cwd: workspace,
        env: buildWorkerEnv(parentEnv, { LAB_WORKER_TOKEN: token }),
        execArgv: ['--permission', `--allow-fs-read=${WORKER_DIR}${path.sep}*`],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
    });
    const out = createWriteStream(path.join(logDir, `${actorId}.log`), { mode: 0o600 });
    let written = 0;
    const capture = chunk => {
        if (written >= MAX_LOG_BYTES) return;
        written += chunk.length;
        out.write(chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - (written - chunk.length))));
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('exit', () => out.end());
    return child;
}

export async function runLab({ resolved, runsDir, env = process.env, provider, pricing, hooks = {}, onCreated }) {
    const { config, scenario, configHash } = resolved;
    mkdirSync(runsDir, { recursive: true });
    const store = new ControlStore(controlPath(runsDir));
    const ledger = new Ledger(ledgerPath(runsDir));
    const recovered = recoverInterrupted({ store, ledger });

    const stamp = new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14);
    const runId = `run-${stamp}-${randomBytes(3).toString('hex')}`;
    const runDir = path.resolve(runsDir, runId);
    mkdirSync(path.join(runDir, 'logs'), { recursive: true });
    store.createRun({ runId, configHash, runDir, controllerPid: process.pid });
    const log = new EventLog({ runId, file: path.join(runDir, 'events.jsonl') });
    const operational = (type, payload = {}, actorId = null) =>
        log.emit({ source: 'controller', type, payload, actorId, evidenceQuality: 'operational' });
    const moveTo = (state, options) => {
        store.transition(runId, state, options);
        operational('run.state', { state, ...(options?.detail ? { detail: options.detail } : {}) });
    };
    onCreated?.({ runId, runDir });

    const participants = assignParticipants(config.agents, config.assignmentSeed);
    const snapshot = { config, configHash, scenario, participants, evidenceClass: 'mock' };
    writeDurable(path.join(runDir, 'resolved-config.json'), `${JSON.stringify(redact(snapshot), null, 2)}\n`);
    const code = codeIdentity();

    let endReason = null;
    let endDetail = null;
    let signalEnd;
    const ended = new Promise(resolve => (signalEnd = resolve));
    const requestEnd = (reason, detail) => {
        if (endReason) return;
        endReason = reason;
        endDetail = detail ?? null;
        signalEnd();
    };

    const workers = new Map();
    let world, gate, broker;
    let barrierPassed = false;
    let stopTiming = null;
    const finishUp = async () => {
        const stopStart = performance.now();
        moveTo('STOPPING', { detail: endReason, reason: endReason });
        if (endDetail) operational('run.stop_detail', { detail: endDetail });
        // Admission closes first, for every kind of stop.
        const revoked = await gate?.revoke(endReason);
        broker?.revoke(endReason);
        const normalEnd = endReason === 'deadline' || endReason === 'budget_exhausted';
        if (normalEnd && world && barrierPassed && !hooks.skipTerminal) world.captureTerminal();
        const stopWorkers = async () => {
            for (const worker of workers.values()) worker.expectExit = true;
            for (const { child } of workers.values()) if (child.connected) child.send({ type: 'shutdown' }, () => {});
            const alive = () =>
                [...workers.values()].filter(w => w.child.exitCode === null && w.child.signalCode === null);
            const grace = hooks.stopGraceMs ?? 1000;
            const until = performance.now() + grace;
            while (alive().length && performance.now() < until) await new Promise(r => setTimeout(r, 20));
            const forced = alive();
            for (const { child } of forced) child.kill('SIGKILL');
            await Promise.all(
                [...workers.values()].map(({ exited }) =>
                    Promise.race([exited, new Promise(r => setTimeout(r, 3000))]),
                ),
            );
            return forced.map(w => w.actorId);
        };
        const forced = await stopWorkers();
        world?.disconnectAll();
        stopTiming = {
            workerTerminationMs: Math.round(performance.now() - stopStart),
            forcedKills: forced.length,
            forcedActors: forced,
            actionsCancelled: revoked?.cancelled ?? 0,
            actionsSettled: revoked?.settled ?? true,
        };
        operational('run.stopped', stopTiming);
        moveTo('FINALIZING');
        log.close();
        const result = finalizeRun({
            runId,
            runDir,
            snapshot,
            reason: endReason,
            ledger,
            store,
            stopTiming,
            participants,
            mode: config.mode,
            extra: {
                code,
                assignment: participants,
                evidenceClass: world?.evidenceClass ?? 'mock',
                pricing: { source: MOCK_PRICING.source, retrievedAt: MOCK_PRICING.retrievedAt },
            },
        });
        store.transition(runId, result.state, { reason: endReason });
        return { runId, runDir, recovered, ...result, stopTiming };
    };

    const finish = async () => {
        try {
            return await finishUp();
        } finally {
            store.close();
            ledger.close();
        }
    };

    moveTo('PREFLIGHT');
    const blockers = preflightBlockers(resolved);
    const free = statfsSync(runsDir);
    if (free.bavail * free.bsize < 100 * 1024 * 1024) blockers.push('Less than 100 MB of free disk');
    if (code.dirty) operational('run.dirty_tree', { head: code.head, diffSha256: code.diffSha256 });
    if (blockers.length) {
        operational('run.preflight_failed', { blockers });
        requestEnd('preflight_failed', blockers.join('; '));
        return finish();
    }
    moveTo('PREPARED');

    // Fresh per-run state only: nothing here is read from an earlier run.
    ledger.openRun({
        runId,
        campaignId: config.campaignId ?? 'mock-offline',
        runCapMicros: usdToMicros(config.limits.runBudgetUsd),
        campaignCapMicros: usdToMicros(config.limits.campaignBudgetUsd),
        maxRequests: config.mode === 'mock' ? MOCK_REQUEST_CEILING : config.limits.maxProviderRequests,
    });
    world = createMockWorld({ runId, participants, log, faults: hooks.worldFaults, actionMs: hooks.actionMs });
    gate = createActionGate({
        runId,
        allowlist: scenario.tools,
        world,
        store,
        toolTimeoutMs: scenario.toolTimeoutMs,
        record: (type, payload) => operational(type, payload, payload.actorId ?? null),
    });
    broker = createBroker({
        runId,
        ledger,
        provider: provider ?? createMockProvider({ faults: hooks.providerFaults }),
        pricing: pricing ?? MOCK_PRICING,
        config,
        requestTimeoutMs: hooks.requestTimeoutMs ?? 30000,
        record: (type, payload) => {
            operational(type, payload, payload.actorId ?? null);
            if (type === 'broker.rejected' && BUDGET_CODES.has(payload.code))
                requestEnd('budget_exhausted', payload.code);
            if (type === 'broker.rejected' && payload.code === 'transport_policy_violation')
                requestEnd('integrity_breach', payload.message);
        },
    });

    moveTo('READY');
    const farFutureDeadlineMs = performance.now() + config.runtime.durationSeconds * 1000 + 60000;
    const helloed = new Set();
    let allHello;
    const helloWait = new Promise(resolve => (allHello = resolve));

    const handleRpc = async (worker, { id, method, params }) => {
        worker.rpcCount++;
        let result;
        if (worker.rpcCount > MAX_RPC_PER_WORKER) {
            if (worker.rpcCount === MAX_RPC_PER_WORKER + 1)
                operational('security.rejected', { kind: 'rpc_flood' }, worker.actorId);
            result = { denied: true };
        } else if (!barrierPassed || gate.revoked) result = { denied: true, failureCode: 'admission_revoked' };
        else if (method === 'observe') result = world.observe(worker.actorId);
        else if (method === 'model') result = await broker.request(worker.actorId, params);
        else if (method === 'action') result = await gate.submit(worker.actorId, params);
        else if (method === 'claim') {
            log.emit({
                source: `agent-${worker.actorId}`,
                type: 'agent.claim',
                actorId: worker.actorId,
                payload: { text: String(params?.text ?? '').slice(0, 2000) },
                evidenceQuality: 'claim',
            });
            result = { recorded: true };
        } else if (method === 'report') {
            operational('worker.report', { ...params }, worker.actorId);
            hooks.onWorkerReport?.(worker.actorId, params);
            result = { recorded: true };
        } else {
            operational(
                'security.rejected',
                { kind: 'unknown_rpc', method: String(method).slice(0, 40) },
                worker.actorId,
            );
            result = { denied: true, failureCode: 'unknown_method' };
        }
        if (worker.child.connected) worker.child.send({ type: 'rpc.result', id, result }, () => {});
    };

    participants.forEach(actorId => {
        const workspace = path.join(runDir, 'workspaces', actorId);
        mkdirSync(workspace, { recursive: true });
        const token = randomBytes(24).toString('hex');
        const child = spawnWorker({
            actorId,
            runId,
            workspace,
            logDir: path.join(runDir, 'logs'),
            token,
            parentEnv: env,
            behavior: hooks.workerBehavior?.[actorId] ?? hooks.workerBehavior?.all,
            hooks,
            farFutureDeadlineMs,
        });
        store.registerWorker(runId, actorId, child.pid);
        const exited = new Promise(resolve => child.once('exit', resolve));
        const worker = { actorId, child, exited, rpcCount: 0, expectExit: false };
        workers.set(actorId, worker);
        // The actor is bound to this channel. Nothing in a message can change which agent it speaks for.
        child.on('message', message => {
            if (message?.type === 'hello') {
                const presented = hooks.badToken?.[actorId] ? 'forged' : message.token;
                if (presented !== token || helloed.has(actorId)) {
                    operational('security.identity_breach', { kind: 'bad_or_duplicate_hello' }, actorId);
                    requestEnd('integrity_breach', `Bad identity from worker ${actorId}`);
                    return;
                }
                helloed.add(actorId);
                if (helloed.size === participants.length) allHello();
            } else if (message?.type === 'rpc') void handleRpc(worker, message);
            else if (message?.type === 'crash')
                operational('worker.crash', { message: String(message.message).slice(0, 300) }, actorId);
        });
        child.once('exit', (exitCode, signal) => {
            operational('worker.exit', { exitCode, signal, unexpected: !worker.expectExit }, actorId);
        });
        child.once('error', error => operational('worker.error', { code: error.code ?? 'unknown' }, actorId));
    });

    const stopPoll = setInterval(() => {
        const request = store.stopRequest(runId);
        if (request) requestEnd(request.reason);
    }, 50);

    const readyTimer = setTimeout(
        () => requestEnd('startup_failed', 'Workers did not report ready in time'),
        hooks.readyTimeoutMs ?? 15000,
    );
    await Promise.race([helloWait, ended]);
    clearTimeout(readyTimer);
    let deadlineTimer;
    if (!endReason) {
        for (const actorId of participants) world.join(actorId);
        // The single ready barrier: the world clock starts once, then every worker is released in the same turn, so
        // nobody gets free work the way upstream's staggered start would give the first agent.
        world.startClock();
        barrierPassed = true;
        moveTo('RUNNING');
        deadlineTimer = setTimeout(() => requestEnd('deadline'), config.runtime.durationSeconds * 1000);
        for (const { child } of workers.values()) child.send({ type: 'start' });
        hooks.onRunning?.({ runId, runDir, workers, gate, broker, world, requestEnd });
    }
    await ended;
    clearTimeout(deadlineTimer);
    clearInterval(stopPoll);
    return finish();
}

export function openStores(runsDir) {
    return { store: new ControlStore(controlPath(runsDir)), ledger: new Ledger(ledgerPath(runsDir)) };
}

export const isTerminal = state => TERMINAL_STATES.includes(state);
