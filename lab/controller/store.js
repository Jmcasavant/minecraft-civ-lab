import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TRANSITIONS = Object.freeze({
    CREATED: ['PREFLIGHT', 'STOPPING'],
    PREFLIGHT: ['PREPARED', 'STOPPING'],
    PREPARED: ['READY', 'STOPPING'],
    READY: ['RUNNING', 'STOPPING'],
    RUNNING: ['STOPPING'],
    STOPPING: ['FINALIZING'],
    FINALIZING: ['COMPLETED', 'ABORTED', 'INVALID'],
    COMPLETED: [],
    ABORTED: [],
    INVALID: [],
});
export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'ABORTED', 'INVALID']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    run_dir TEXT NOT NULL,
    controller_pid INTEGER,
    termination_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transitions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stop_requests (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
    reason TEXT NOT NULL,
    requested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    actor_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    PRIMARY KEY (run_id, actor_id)
);
CREATE TABLE IF NOT EXISTS actions (
    run_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('admitted','finished')),
    result TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, actor_id, action_id)
);
`;

export class ControlStore {
    #db;
    constructor(file, { now = () => new Date().toISOString() } = {}) {
        mkdirSync(path.dirname(file), { recursive: true });
        this.#db = new DatabaseSync(file);
        this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 15000;');
        this.#db.exec(SCHEMA);
        this.now = now;
    }

    close() {
        this.#db.close();
    }

    createRun({ runId, configHash, runDir, controllerPid }) {
        const at = this.now();
        this.#db
            .prepare(
                `INSERT INTO runs (run_id, state, config_hash, run_dir, controller_pid, created_at, updated_at)
                 VALUES (?, 'CREATED', ?, ?, ?, ?, ?)`,
            )
            .run(runId, configHash, runDir, controllerPid ?? null, at, at);
        this.#db
            .prepare(`INSERT INTO transitions (run_id, from_state, to_state, at) VALUES (?, NULL, 'CREATED', ?)`)
            .run(runId, at);
    }

    run(runId) {
        return this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) ?? null;
    }

    listRuns() {
        return this.#db.prepare('SELECT * FROM runs ORDER BY created_at, run_id').all();
    }

    openRuns() {
        const marks = TERMINAL_STATES.map(() => '?').join(',');
        return this.#db.prepare(`SELECT * FROM runs WHERE state NOT IN (${marks})`).all(...TERMINAL_STATES);
    }

    transitions(runId) {
        return this.#db.prepare('SELECT * FROM transitions WHERE run_id = ? ORDER BY seq').all(runId);
    }

    // Compare-and-swap, durable before it returns. Asking for the state a run is already in is a no-op.
    transition(runId, to, { detail, reason } = {}) {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.#db.prepare('SELECT state FROM runs WHERE run_id = ?').get(runId);
            if (!row) throw new Error(`Unknown run ${runId}`);
            if (row.state === to) {
                this.#db.exec('COMMIT');
                return { changed: false, state: to };
            }
            if (!TRANSITIONS[row.state]?.includes(to)) throw new Error(`Illegal transition ${row.state} -> ${to}`);
            const at = this.now();
            this.#db
                .prepare(
                    `UPDATE runs SET state = ?, updated_at = ?, termination_reason = COALESCE(?, termination_reason)
                     WHERE run_id = ?`,
                )
                .run(to, at, reason ?? null, runId);
            this.#db
                .prepare('INSERT INTO transitions (run_id, from_state, to_state, detail, at) VALUES (?, ?, ?, ?, ?)')
                .run(runId, row.state, to, detail ?? null, at);
            this.#db.exec('COMMIT');
            return { changed: true, state: to };
        } catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    requestStop(runId, reason = 'operator_stop') {
        this.#db
            .prepare('INSERT OR IGNORE INTO stop_requests (run_id, reason, requested_at) VALUES (?, ?, ?)')
            .run(runId, reason, this.now());
    }

    stopRequest(runId) {
        return this.#db.prepare('SELECT * FROM stop_requests WHERE run_id = ?').get(runId) ?? null;
    }

    registerWorker(runId, actorId, pid) {
        this.#db
            .prepare('INSERT OR REPLACE INTO workers (run_id, actor_id, pid) VALUES (?, ?, ?)')
            .run(runId, actorId, pid);
    }

    workers(runId) {
        return this.#db.prepare('SELECT * FROM workers WHERE run_id = ?').all(runId);
    }

    // Returns the existing row when this action id was already admitted, so a transport retry cannot run it twice.
    admitAction({ runId, actorId, actionId, requestHash }) {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const existing = this.#db
                .prepare('SELECT * FROM actions WHERE run_id = ? AND actor_id = ? AND action_id = ?')
                .get(runId, actorId, actionId);
            if (!existing)
                this.#db
                    .prepare(
                        `INSERT INTO actions (run_id, actor_id, action_id, request_hash, state, updated_at)
                         VALUES (?, ?, ?, ?, 'admitted', ?)`,
                    )
                    .run(runId, actorId, actionId, requestHash, this.now());
            this.#db.exec('COMMIT');
            return existing ?? null;
        } catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    finishAction({ runId, actorId, actionId, result }) {
        this.#db
            .prepare(
                `UPDATE actions SET state = 'finished', result = ?, updated_at = ?
                 WHERE run_id = ? AND actor_id = ? AND action_id = ?`,
            )
            .run(JSON.stringify(result), this.now(), runId, actorId, actionId);
    }

    unfinishedActions(runId) {
        return this.#db.prepare(`SELECT * FROM actions WHERE run_id = ? AND state = 'admitted'`).all(runId);
    }
}
