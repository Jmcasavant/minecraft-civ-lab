import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Durable spending ledger. All amounts are integer microdollars. Admission is always checked against
// settled + reserved + ambiguous, inside BEGIN IMMEDIATE, so concurrent processes cannot both pass the same check.
//
// Reservation states:
//   reserved   request admitted, outcome not known yet; counts in full against the caps
//   ambiguous  timeout, malformed reply or controller crash; the provider may have billed, so liability is retained
//   settled    provider-reported usage recorded; counts at the settled amount
//   released   the provider definitely did not bill (the request was never sent, or it was refused unbilled)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id TEXT PRIMARY KEY,
    cap_micros INTEGER NOT NULL CHECK (cap_micros >= 0)
);
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
    cap_micros INTEGER NOT NULL CHECK (cap_micros >= 0),
    max_requests INTEGER NOT NULL CHECK (max_requests >= 0),
    closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reservations (
    reservation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    actor_id TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved','ambiguous','settled','released')),
    max_micros INTEGER NOT NULL CHECK (max_micros >= 0),
    settled_micros INTEGER,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_run ON reservations(run_id, state);
CREATE TABLE IF NOT EXISTS ledger_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    micros INTEGER,
    note TEXT,
    at TEXT NOT NULL
);
`;

const LIABILITY = `COALESCE(SUM(CASE
    WHEN state IN ('reserved','ambiguous') THEN max_micros
    WHEN state = 'settled' THEN settled_micros
    ELSE 0 END), 0)`;

export class LedgerError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export class Ledger {
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

    #history(id, state, micros, note) {
        this.#db
            .prepare('INSERT INTO ledger_history (reservation_id, state, micros, note, at) VALUES (?, ?, ?, ?, ?)')
            .run(id, state, micros ?? null, note ?? null, this.now());
    }

    // Caps are immutable once opened: raising a cap needs a new campaign id, so a restart cannot reset spending.
    openRun({ runId, campaignId, runCapMicros, campaignCapMicros, maxRequests }) {
        return this.#tx(() => {
            const campaign = this.#db.prepare('SELECT cap_micros FROM campaigns WHERE campaign_id = ?').get(campaignId);
            if (!campaign)
                this.#db
                    .prepare('INSERT INTO campaigns (campaign_id, cap_micros) VALUES (?, ?)')
                    .run(campaignId, campaignCapMicros);
            else if (campaign.cap_micros !== campaignCapMicros)
                throw new LedgerError('CAP_CHANGED', `Campaign ${campaignId} already has a different cap`);
            const run = this.#db.prepare('SELECT cap_micros, max_requests FROM runs WHERE run_id = ?').get(runId);
            if (!run)
                this.#db
                    .prepare('INSERT INTO runs (run_id, campaign_id, cap_micros, max_requests) VALUES (?, ?, ?, ?)')
                    .run(runId, campaignId, runCapMicros, maxRequests);
            else if (run.cap_micros !== runCapMicros || run.max_requests !== maxRequests)
                throw new LedgerError('CAP_CHANGED', `Run ${runId} already has different limits`);
        });
    }

    closeRun(runId) {
        this.#db.prepare('UPDATE runs SET closed = 1 WHERE run_id = ?').run(runId);
    }

    // Atomic admission. Returns { ok: true } or { ok: false, code }; repeating an id returns the first outcome.
    reserve({ reservationId, runId, actorId, model, maxMicros }) {
        if (!Number.isSafeInteger(maxMicros) || maxMicros < 0)
            throw new LedgerError('UNBOUNDED', 'A reservation needs a bounded non-negative maximum');
        return this.#tx(() => {
            const existing = this.#db
                .prepare('SELECT state FROM reservations WHERE reservation_id = ?')
                .get(reservationId);
            if (existing) return { ok: true, duplicate: true, state: existing.state };
            const run = this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
            if (!run) return { ok: false, code: 'unknown_run' };
            if (run.closed) return { ok: false, code: 'run_closed' };
            const used = this.#db
                .prepare(`SELECT ${LIABILITY} AS micros, COUNT(*) AS requests FROM reservations WHERE run_id = ?`)
                .get(runId);
            if (used.requests >= run.max_requests) return { ok: false, code: 'request_limit' };
            if (used.micros + maxMicros > run.cap_micros) return { ok: false, code: 'run_budget' };
            const campaign = this.#db
                .prepare(
                    `SELECT c.cap_micros AS cap, (SELECT ${LIABILITY} FROM reservations r JOIN runs x ON r.run_id = x.run_id
                     WHERE x.campaign_id = c.campaign_id) AS micros FROM campaigns c WHERE c.campaign_id = ?`,
                )
                .get(run.campaign_id);
            if (campaign.micros + maxMicros > campaign.cap) return { ok: false, code: 'campaign_budget' };
            const at = this.now();
            this.#db
                .prepare(
                    `INSERT INTO reservations (reservation_id, run_id, actor_id, model, state, max_micros, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`,
                )
                .run(reservationId, runId, actorId, model, maxMicros, at, at);
            this.#history(reservationId, 'reserved', maxMicros);
            return { ok: true };
        });
    }

    #move(id, allowedFrom, state, { micros = null, note = null } = {}) {
        return this.#tx(() => {
            const row = this.#db
                .prepare('SELECT state, settled_micros FROM reservations WHERE reservation_id = ?')
                .get(id);
            if (!row) throw new LedgerError('UNKNOWN_RESERVATION', `Unknown reservation ${id}`);
            if (row.state === state && (state !== 'settled' || row.settled_micros === micros))
                return { duplicate: true };
            if (!allowedFrom.includes(row.state))
                throw new LedgerError('BAD_TRANSITION', `Reservation ${id}: ${row.state} cannot become ${state}`);
            this.#db
                .prepare(
                    `UPDATE reservations SET state = ?, settled_micros = ?, note = COALESCE(?, note), updated_at = ?
                     WHERE reservation_id = ?`,
                )
                .run(state, micros, note, this.now(), id);
            this.#history(id, state, micros, note);
            return {};
        });
    }

    // A settled amount above the reservation stays visible as an overrun; it is never clipped to the maximum.
    settle(id, micros, { note } = {}) {
        if (!Number.isSafeInteger(micros) || micros < 0) throw new LedgerError('BAD_AMOUNT', 'Bad settlement amount');
        return this.#move(id, ['reserved', 'ambiguous'], 'settled', { micros, note });
    }

    release(id, { note } = {}) {
        return this.#move(id, ['reserved'], 'released', { note });
    }

    markAmbiguous(id, { note } = {}) {
        return this.#move(id, ['reserved'], 'ambiguous', { note });
    }

    // Called before any new request after a controller start: whatever was in flight when a controller died has an
    // unknown outcome, so its liability is retained.
    recoverInFlight({ exceptRunIds = [] } = {}) {
        return this.#tx(() => {
            const rows = this.#db
                .prepare(`SELECT reservation_id, run_id FROM reservations WHERE state = 'reserved'`)
                .all();
            const moved = [];
            for (const row of rows) {
                if (exceptRunIds.includes(row.run_id)) continue;
                this.#db
                    .prepare(
                        `UPDATE reservations SET state = 'ambiguous', note = 'controller_recovery', updated_at = ?
                         WHERE reservation_id = ?`,
                    )
                    .run(this.now(), row.reservation_id);
                this.#history(row.reservation_id, 'ambiguous', null, 'controller_recovery');
                moved.push(row.reservation_id);
            }
            return moved;
        });
    }

    // At finalization: whatever is still open for this run keeps its liability instead of disappearing with the run.
    retainOpen(runId, note = 'run_ended_in_flight') {
        return this.#tx(() => {
            const rows = this.#db
                .prepare(`SELECT reservation_id FROM reservations WHERE run_id = ? AND state = 'reserved'`)
                .all(runId);
            for (const row of rows) {
                this.#db
                    .prepare(
                        `UPDATE reservations SET state = 'ambiguous', note = ?, updated_at = ? WHERE reservation_id = ?`,
                    )
                    .run(note, this.now(), row.reservation_id);
                this.#history(row.reservation_id, 'ambiguous', null, note);
            }
            return rows.length;
        });
    }

    #totals(where, param) {
        const row = this.#db
            .prepare(
                `SELECT
                   COALESCE(SUM(CASE WHEN state = 'settled' THEN settled_micros ELSE 0 END), 0) AS settled,
                   COALESCE(SUM(CASE WHEN state = 'reserved' THEN max_micros ELSE 0 END), 0) AS reserved,
                   COALESCE(SUM(CASE WHEN state = 'ambiguous' THEN max_micros ELSE 0 END), 0) AS ambiguous,
                   COALESCE(SUM(CASE WHEN state = 'settled' AND settled_micros > max_micros
                                     THEN settled_micros - max_micros ELSE 0 END), 0) AS overrun,
                   COUNT(*) AS requests
                 FROM reservations r JOIN runs x ON r.run_id = x.run_id WHERE ${where}`,
            )
            .get(param);
        return {
            settledMicros: row.settled,
            reservedMicros: row.reserved,
            ambiguousMicros: row.ambiguous,
            overrunMicros: row.overrun,
            unsettledExposureMicros: row.reserved + row.ambiguous,
            requests: row.requests,
        };
    }

    runTotals(runId) {
        return this.#totals('r.run_id = ?', runId);
    }

    campaignTotals(campaignId) {
        return this.#totals('x.campaign_id = ?', campaignId);
    }

    reservation(id) {
        return this.#db.prepare('SELECT * FROM reservations WHERE reservation_id = ?').get(id) ?? null;
    }
}
