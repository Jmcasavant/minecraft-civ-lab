import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Tasks, facts and resource reservations for the structured condition. The service owns its database; agents reach it
// only through `forActor`, whose actor comes from the authenticated channel. It holds promises about the world, not the
// world: a reservation cannot stop a chest being emptied, so stock must be rechecked when an action runs.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    description TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    criterion TEXT NOT NULL,
    status TEXT NOT NULL,
    owner TEXT,
    lease_expires_ms INTEGER,
    last_progress_ms INTEGER,
    revision INTEGER NOT NULL,
    evidence TEXT NOT NULL,
    blocker TEXT,
    wait_until_ms INTEGER,
    created_by TEXT NOT NULL,
    PRIMARY KEY (run_id, task_id)
);
CREATE TABLE IF NOT EXISTS applied_requests (
    run_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    request_id TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (run_id, actor, request_id)
);
CREATE TABLE IF NOT EXISTS facts (
    run_id TEXT NOT NULL,
    fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    value TEXT NOT NULL,
    source_agent TEXT NOT NULL,
    evidence_ref TEXT,
    observation_tick INTEGER NOT NULL,
    expires_tick INTEGER,
    status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock (
    run_id TEXT NOT NULL,
    container TEXT NOT NULL,
    item TEXT NOT NULL,
    observed_quantity INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    observed_by TEXT NOT NULL,
    observed_tick INTEGER NOT NULL,
    PRIMARY KEY (run_id, container, item)
);
CREATE TABLE IF NOT EXISTS reservations (
    run_id TEXT NOT NULL,
    reservation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    container TEXT NOT NULL,
    item TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL
);
`;

const TASK_STATES = new Set(['open', 'claimed', 'running', 'blocked', 'submitted', 'verified', 'failed', 'cancelled']);
const OWNED = new Set(['claimed', 'running']);
const AGENT_SETTABLE = new Set(['running', 'blocked', 'submitted', 'failed']);
export const DEFAULT_TIMINGS = Object.freeze({ leaseMs: 120000, heartbeatMs: 30000, noProgressMs: 300000 });

const denied = (code, extra = {}) => ({ ok: false, code, ...extra });

export class CoordinationService {
    #db;
    constructor({ file, runId, now = () => Date.now(), timings = DEFAULT_TIMINGS, roster }) {
        mkdirSync(path.dirname(file), { recursive: true });
        this.#db = new DatabaseSync(file);
        this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000;');
        this.#db.exec(SCHEMA);
        this.runId = runId;
        this.now = now;
        this.timings = timings;
        this.roster = new Set(roster);
    }

    close() {
        this.#db.close();
    }

    #tx(fn) {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.#db.exec('COMMIT');
            return value;
        } catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    #task(taskId) {
        const row = this.#db.prepare('SELECT * FROM tasks WHERE run_id = ? AND task_id = ?').get(this.runId, taskId);
        return row ? { ...row, dependencies: JSON.parse(row.dependencies), evidence: JSON.parse(row.evidence) } : null;
    }

    #save(task) {
        this.#db
            .prepare(
                `UPDATE tasks SET status = ?, owner = ?, lease_expires_ms = ?, last_progress_ms = ?, revision = ?,
                 evidence = ?, blocker = ?, wait_until_ms = ? WHERE run_id = ? AND task_id = ?`,
            )
            .run(
                task.status,
                task.owner,
                task.lease_expires_ms,
                task.last_progress_ms,
                task.revision,
                JSON.stringify(task.evidence),
                task.blocker,
                task.wait_until_ms,
                this.runId,
                task.task_id,
            );
    }

    // Reclaims lapsed leases, and tasks that only heartbeat without fresh evidence. Reassignment bumps the revision,
    // which is what fences out the previous owner.
    #sweep() {
        const now = this.now();
        const rows = this.#db
            .prepare(`SELECT task_id FROM tasks WHERE run_id = ? AND status IN ('claimed','running')`)
            .all(this.runId);
        for (const { task_id } of rows) {
            const task = this.#task(task_id);
            const waiting = task.wait_until_ms && now < task.wait_until_ms;
            const stalled = !waiting && now - task.last_progress_ms > this.timings.noProgressMs;
            if (now <= task.lease_expires_ms && !stalled) continue;
            task.status = stalled ? 'blocked' : 'open';
            task.blocker = stalled ? `No fresh evidence from ${task.owner}` : null;
            task.owner = null;
            task.lease_expires_ms = null;
            task.wait_until_ms = null;
            task.revision++;
            this.#save(task);
        }
    }

    #idempotent(actor, requestId, fn) {
        return this.#tx(() => {
            this.#sweep();
            if (requestId) {
                const prior = this.#db
                    .prepare('SELECT result FROM applied_requests WHERE run_id = ? AND actor = ? AND request_id = ?')
                    .get(this.runId, actor, requestId);
                if (prior) return JSON.parse(prior.result);
            }
            const result = fn();
            if (requestId)
                this.#db
                    .prepare('INSERT INTO applied_requests (run_id, actor, request_id, result) VALUES (?, ?, ?, ?)')
                    .run(this.runId, actor, requestId, JSON.stringify(result));
            return result;
        });
    }

    // Checks a tool admission that claims to act for a task: only the current owner holding the current revision passes.
    checkFence(actor, taskId, revision) {
        return this.#tx(() => {
            this.#sweep();
            const task = this.#task(taskId);
            if (!task) return denied('unknown_task');
            if (task.owner !== actor || task.revision !== revision || !OWNED.has(task.status))
                return denied('stale_fence', { currentRevision: task.revision, owner: task.owner });
            return { ok: true };
        });
    }

    forActor(actor) {
        if (!this.roster.has(actor)) throw new Error(`${actor} is not on this run's roster`);
        return Object.freeze({
            taskCreate: ({ taskId, description, dependencies = [], criterion, requestId }) =>
                this.#idempotent(actor, requestId, () => {
                    if (!/^[A-Za-z0-9:_-]{1,64}$/.test(taskId ?? '')) return denied('invalid_task_id');
                    if (!description || !criterion) return denied('invalid_task');
                    if (dependencies.length > 16) return denied('too_many_dependencies');
                    if (this.#task(taskId)) return denied('task_exists');
                    this.#db
                        .prepare(
                            `INSERT INTO tasks (run_id, task_id, description, dependencies, criterion, status, revision, evidence, created_by)
                             VALUES (?, ?, ?, ?, ?, 'open', 1, '[]', ?)`,
                        )
                        .run(
                            this.runId,
                            taskId,
                            String(description).slice(0, 1000),
                            JSON.stringify(dependencies),
                            String(criterion).slice(0, 1000),
                            actor,
                        );
                    return { ok: true, taskId, revision: 1 };
                }),
            taskList: () =>
                this.#tx(() => {
                    this.#sweep();
                    return this.#db
                        .prepare('SELECT task_id FROM tasks WHERE run_id = ? ORDER BY task_id')
                        .all(this.runId)
                        .map(row => this.#task(row.task_id));
                }),
            taskClaim: ({ taskId, expectedRevision, requestId }) =>
                this.#idempotent(actor, requestId, () => {
                    const task = this.#task(taskId);
                    if (!task) return denied('unknown_task');
                    if (task.revision !== expectedRevision)
                        return denied('stale_revision', { currentRevision: task.revision });
                    if (task.status !== 'open')
                        return denied('not_claimable', { status: task.status, owner: task.owner });
                    const waitingOn = task.dependencies.filter(id => this.#task(id)?.status !== 'verified');
                    if (waitingOn.length) return denied('dependencies_unmet', { waitingOn });
                    const now = this.now();
                    task.status = 'claimed';
                    task.owner = actor;
                    task.lease_expires_ms = now + this.timings.leaseMs;
                    task.last_progress_ms = now;
                    task.revision++;
                    this.#save(task);
                    return { ok: true, taskId, revision: task.revision, leaseExpiresMs: task.lease_expires_ms };
                }),
            taskUpdate: ({ taskId, revision, status, evidence = [], blocker, waitUntilMs, requestId }) =>
                this.#idempotent(actor, requestId, () => {
                    const task = this.#task(taskId);
                    if (!task) return denied('unknown_task');
                    if (task.owner !== actor || task.revision !== revision)
                        return denied('stale_fence', { currentRevision: task.revision, owner: task.owner });
                    if (status !== undefined && (!TASK_STATES.has(status) || !AGENT_SETTABLE.has(status)))
                        return denied('status_not_allowed', { status });
                    const now = this.now();
                    task.lease_expires_ms = now + this.timings.leaseMs;
                    if (evidence.length) {
                        task.evidence = [...task.evidence, ...evidence.map(String)].slice(-64);
                        task.last_progress_ms = now;
                    }
                    task.wait_until_ms = waitUntilMs ?? task.wait_until_ms;
                    if (status) task.status = status;
                    if (blocker !== undefined) task.blocker = blocker;
                    if (status === 'blocked' || status === 'failed' || status === 'submitted') {
                        task.lease_expires_ms = null;
                        if (status !== 'submitted') task.owner = null;
                    }
                    task.revision++;
                    this.#save(task);
                    return { ok: true, taskId, revision: task.revision };
                }),
            taskRelease: ({ taskId, revision, requestId }) =>
                this.#idempotent(actor, requestId, () => {
                    const task = this.#task(taskId);
                    if (!task) return denied('unknown_task');
                    if (task.owner !== actor || task.revision !== revision)
                        return denied('stale_fence', { currentRevision: task.revision });
                    task.status = 'open';
                    task.owner = null;
                    task.lease_expires_ms = null;
                    task.wait_until_ms = null;
                    task.revision++;
                    this.#save(task);
                    return { ok: true, taskId, revision: task.revision };
                }),
            // The way back from `blocked`, which has no owner. Any member can reopen once the blocker has cleared, and the
            // revision check stops two members acting on the same stale view. `failed` stays final.
            taskReopen: ({ taskId, revision, requestId }) =>
                this.#idempotent(actor, requestId, () => {
                    const task = this.#task(taskId);
                    if (!task) return denied('unknown_task');
                    if (task.revision !== revision) return denied('stale_revision', { currentRevision: task.revision });
                    if (task.status !== 'blocked') return denied('not_reopenable', { status: task.status });
                    task.status = 'open';
                    task.blocker = null;
                    task.wait_until_ms = null;
                    task.revision++;
                    this.#save(task);
                    return { ok: true, taskId, revision: task.revision };
                }),
            // Agents can only report. There is no parameter here that could mark a claim verified.
            factPublish: ({ subject, value, evidenceRef = null, observationTick, expiresTick = null }) =>
                this.#tx(() => {
                    if (!subject || value === undefined || !Number.isInteger(observationTick))
                        return denied('invalid_fact');
                    const text = JSON.stringify(value);
                    const others = this.#db
                        .prepare(
                            `SELECT fact_id, value FROM facts WHERE run_id = ? AND subject = ? AND status IN ('reported','verified')`,
                        )
                        .all(this.runId, subject);
                    const conflict = others.some(f => f.value !== text);
                    if (conflict)
                        this.#db
                            .prepare(
                                `UPDATE facts SET status = 'disputed' WHERE run_id = ? AND subject = ? AND status IN ('reported','verified')`,
                            )
                            .run(this.runId, subject);
                    const inserted = this.#db
                        .prepare(
                            `INSERT INTO facts (run_id, subject, value, source_agent, evidence_ref, observation_tick, expires_tick, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        )
                        .run(
                            this.runId,
                            String(subject).slice(0, 200),
                            text,
                            actor,
                            evidenceRef,
                            observationTick,
                            expiresTick,
                            conflict ? 'disputed' : 'reported',
                        );
                    return {
                        ok: true,
                        factId: Number(inserted.lastInsertRowid),
                        status: conflict ? 'disputed' : 'reported',
                    };
                }),
            // History is kept, including contradictions and expired entries, so nothing is overwritten into certainty.
            factQuery: ({ subject, currentTick }) =>
                this.#db
                    .prepare('SELECT * FROM facts WHERE run_id = ? AND subject = ? ORDER BY fact_id')
                    .all(this.runId, subject)
                    .map(f => ({
                        ...f,
                        value: JSON.parse(f.value),
                        status: f.expires_tick !== null && currentTick > f.expires_tick ? 'expired' : f.status,
                    })),
            stockObserve: ({ container, item, quantity, observedTick }) =>
                this.#tx(() => {
                    if (!Number.isInteger(quantity) || quantity < 0) return denied('invalid_quantity');
                    const row = this.#db
                        .prepare('SELECT revision FROM stock WHERE run_id = ? AND container = ? AND item = ?')
                        .get(this.runId, container, item);
                    const revision = (row?.revision ?? 0) + 1;
                    this.#db
                        .prepare(
                            `INSERT OR REPLACE INTO stock (run_id, container, item, observed_quantity, revision, observed_by, observed_tick)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        )
                        .run(this.runId, container, item, quantity, revision, actor, observedTick);
                    return { ok: true, revision };
                }),
            resourceReserve: ({ container, item, quantity, stockRevision }) =>
                this.#tx(() => {
                    if (!Number.isInteger(quantity) || quantity <= 0) return denied('invalid_quantity');
                    const stock = this.#db
                        .prepare('SELECT * FROM stock WHERE run_id = ? AND container = ? AND item = ?')
                        .get(this.runId, container, item);
                    if (!stock) return denied('unknown_stock');
                    if (stock.revision !== stockRevision)
                        return denied('stale_stock', { currentRevision: stock.revision });
                    const held = this.#db
                        .prepare(
                            `SELECT COALESCE(SUM(quantity), 0) AS held FROM reservations
                             WHERE run_id = ? AND container = ? AND item = ? AND status = 'active'`,
                        )
                        .get(this.runId, container, item).held;
                    if (held + quantity > stock.observed_quantity)
                        return denied('insufficient_stock', { available: stock.observed_quantity - held });
                    const inserted = this.#db
                        .prepare(
                            `INSERT INTO reservations (run_id, container, item, quantity, owner, status) VALUES (?, ?, ?, ?, ?, 'active')`,
                        )
                        .run(this.runId, container, item, quantity, actor);
                    return { ok: true, reservationId: Number(inserted.lastInsertRowid) };
                }),
            resourceRelease: ({ reservationId }) =>
                this.#tx(() => {
                    const row = this.#db
                        .prepare('SELECT owner, status FROM reservations WHERE run_id = ? AND reservation_id = ?')
                        .get(this.runId, reservationId);
                    if (!row) return denied('unknown_reservation');
                    if (row.owner !== actor) return denied('not_owner');
                    if (row.status !== 'active') return { ok: true, duplicate: true };
                    this.#db
                        .prepare(`UPDATE reservations SET status = 'released' WHERE run_id = ? AND reservation_id = ?`)
                        .run(this.runId, reservationId);
                    return { ok: true };
                }),
        });
    }

    // Controller-side only, never exposed to a worker.
    verifier() {
        return Object.freeze({
            verifyFact: factId =>
                this.#db
                    .prepare(`UPDATE facts SET status = 'verified' WHERE run_id = ? AND fact_id = ?`)
                    .run(this.runId, factId),
            verifyTask: taskId =>
                this.#tx(() => {
                    const task = this.#task(taskId);
                    if (task?.status !== 'submitted') return denied('not_submitted');
                    task.status = 'verified';
                    task.owner = null;
                    task.revision++;
                    this.#save(task);
                    return { ok: true };
                }),
        });
    }
}
