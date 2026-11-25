import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { assertValid } from '../lib/schema.js';
import { labSchema, redact } from '../lib/util.js';

const EVENT_SCHEMA = labSchema('event');

// Append-only run event stream, written only by the controller. Workers have no path to this file; anything they say
// arrives through their channel and is stored with evidenceQuality "claim" or "operational".
export class EventLog {
    #seqBySource = new Map();
    #collectorSeq = 0;
    #fd;
    #origin = performance.now();
    constructor({ runId, file, now = () => new Date().toISOString() }) {
        this.runId = runId;
        this.file = file;
        this.now = now;
        this.#fd = openSync(file, 'a', 0o600);
    }

    elapsedMs() {
        return Math.max(0, Math.floor(performance.now() - this.#origin));
    }

    // The world and action clocks start here, at the ready barrier.
    resetOrigin() {
        this.#origin = performance.now();
    }

    emit({
        source,
        type,
        actorId = null,
        correlationId = null,
        payload = {},
        evidenceQuality,
        tick = null,
        sourceSeq,
    }) {
        const seq = sourceSeq ?? (this.#seqBySource.get(source) ?? 0) + 1;
        this.#seqBySource.set(source, Math.max(seq, this.#seqBySource.get(source) ?? 0));
        const event = {
            schemaVersion: '1',
            runId: this.runId,
            eventId: `${source}-${String(seq).padStart(8, '0')}`,
            source,
            sourceSeq: seq,
            collectorSeq: ++this.#collectorSeq,
            tick,
            elapsedMs: this.elapsedMs(),
            utc: this.now(),
            type,
            actorId,
            correlationId,
            payload: redact(payload),
            evidenceQuality,
        };
        assertValid(EVENT_SCHEMA, event, 'event');
        appendFileSync(this.#fd, `${JSON.stringify(event)}\n`);
        return event;
    }

    close() {
        fsyncSync(this.#fd);
        closeSync(this.#fd);
    }
}

// A torn final line after a crash is reported rather than silently dropped; it may mean evidence was lost.
export function readEvents(file) {
    if (!existsSync(file)) return { events: [], malformed: 0 };
    const events = [];
    let malformed = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            assertValid(EVENT_SCHEMA, event, 'event');
            events.push(event);
        } catch {
            malformed++;
        }
    }
    return { events, malformed };
}

export function sequenceGaps(events) {
    const bySource = new Map();
    for (const event of events) {
        if (!bySource.has(event.source)) bySource.set(event.source, []);
        bySource.get(event.source).push(event.sourceSeq);
    }
    const gaps = [];
    for (const [source, seqs] of bySource) {
        const sorted = [...seqs].sort((a, b) => a - b);
        let expected = 1;
        for (const seq of sorted) {
            if (seq === expected - 1) gaps.push({ source, duplicate: seq });
            else if (seq > expected) gaps.push({ source, missingFrom: expected, missingTo: seq - 1 });
            expected = Math.max(expected, seq + 1);
        }
    }
    return gaps;
}
