import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Ledger } from '../../../lab/broker/ledger.js';
import { maxChargeMicros, chargeFromUsageMicros } from '../../../lab/broker/pricing.js';
import { FAKE_PRICING, FIXTURES, tempDir } from '../fixtures/helpers.js';

function open(t, caps = {}) {
    const file = path.join(tempDir(t), 'ledger.sqlite');
    const ledger = new Ledger(file);
    t.after(() => {
        try {
            ledger.close();
        } catch {}
    });
    ledger.openRun({
        runId: 'r',
        campaignId: 'c',
        runCapMicros: 1000,
        campaignCapMicros: 1500,
        maxRequests: 100,
        ...caps,
    });
    return { ledger, file };
}
const reserve = (ledger, id, maxMicros, runId = 'r') =>
    ledger.reserve({ reservationId: id, runId, actorId: 'a', model: 'm', maxMicros });

test('outstanding reservations count against the cap before they settle', t => {
    const { ledger } = open(t);
    assert.equal(reserve(ledger, 'a', 600).ok, true);
    assert.deepEqual(reserve(ledger, 'b', 500), { ok: false, code: 'run_budget' });
    assert.equal(reserve(ledger, 'c', 400).ok, true);
});

test('settling frees the unused part of a reservation', t => {
    const { ledger } = open(t);
    reserve(ledger, 'a', 900);
    ledger.settle('a', 100);
    assert.equal(reserve(ledger, 'b', 900).ok, true);
    assert.equal(ledger.runTotals('r').settledMicros, 100);
    assert.equal(ledger.runTotals('r').reservedMicros, 900);
});

test('an ambiguous timeout keeps its full liability until reconciled', t => {
    const { ledger } = open(t);
    reserve(ledger, 'a', 900);
    ledger.markAmbiguous('a', { note: 'timeout' });
    assert.equal(ledger.runTotals('r').unsettledExposureMicros, 900);
    assert.equal(reserve(ledger, 'retry', 200).code, 'run_budget');
    assert.throws(() => ledger.release('a'), /cannot become released/);
    ledger.settle('a', 50);
    assert.equal(reserve(ledger, 'after', 200).ok, true);
});

test('a definite non-billing releases the reservation', t => {
    const { ledger } = open(t);
    reserve(ledger, 'a', 900);
    ledger.release('a', { note: 'not_sent' });
    assert.equal(ledger.runTotals('r').unsettledExposureMicros, 0);
    assert.equal(reserve(ledger, 'b', 1000).ok, true);
});

test('repeating an id reserves once, and a settlement cannot change', t => {
    const { ledger } = open(t);
    reserve(ledger, 'a', 600);
    assert.equal(reserve(ledger, 'a', 600).duplicate, true);
    assert.equal(ledger.runTotals('r').reservedMicros, 600);
    ledger.settle('a', 10);
    assert.equal(ledger.settle('a', 10).duplicate, true);
    assert.throws(() => ledger.settle('a', 11), /cannot become settled/);
});

test('an overrun stays visible instead of being clipped to the reservation', t => {
    const { ledger } = open(t);
    reserve(ledger, 'a', 100);
    ledger.settle('a', 400);
    const totals = ledger.runTotals('r');
    assert.equal(totals.settledMicros, 400);
    assert.equal(totals.overrunMicros, 300);
});

test('the campaign cap applies across runs', t => {
    const { ledger } = open(t);
    ledger.openRun({ runId: 'r2', campaignId: 'c', runCapMicros: 1000, campaignCapMicros: 1500, maxRequests: 100 });
    assert.equal(reserve(ledger, 'a', 1000).ok, true);
    assert.equal(reserve(ledger, 'b', 600, 'r2').code, 'campaign_budget');
    assert.equal(reserve(ledger, 'c', 500, 'r2').ok, true);
    assert.equal(ledger.campaignTotals('c').unsettledExposureMicros, 1500);
});

test('the request ceiling applies even at zero cost', t => {
    const { ledger } = open(t, { runCapMicros: 0, campaignCapMicros: 0, maxRequests: 2 });
    assert.equal(reserve(ledger, 'a', 0).ok, true);
    assert.equal(reserve(ledger, 'b', 0).ok, true);
    assert.equal(reserve(ledger, 'c', 0).code, 'request_limit');
});

test('a closed run admits nothing, and a cap cannot be changed by reopening', t => {
    const { ledger } = open(t);
    assert.throws(
        () =>
            ledger.openRun({
                runId: 'r',
                campaignId: 'c',
                runCapMicros: 9999,
                campaignCapMicros: 1500,
                maxRequests: 100,
            }),
        /different limits/,
    );
    assert.throws(
        () => ledger.openRun({ runId: 'x', campaignId: 'c', runCapMicros: 1, campaignCapMicros: 9999, maxRequests: 1 }),
        /different cap/,
    );
    ledger.closeRun('r');
    assert.equal(reserve(ledger, 'a', 1).code, 'run_closed');
});

test('spending survives a restart, and in-flight requests become retained liability', t => {
    const { ledger, file } = open(t);
    reserve(ledger, 'settled', 100);
    ledger.settle('settled', 70);
    reserve(ledger, 'inflight', 800);
    ledger.close();
    const reopened = new Ledger(file);
    t.after(() => reopened.close());
    assert.deepEqual(reopened.recoverInFlight(), ['inflight']);
    const totals = reopened.runTotals('r');
    assert.equal(totals.settledMicros, 70);
    assert.equal(totals.ambiguousMicros, 800);
    assert.equal(reserve(reopened, 'next', 200).code, 'run_budget');
    assert.equal(reserve(reopened, 'small', 130).ok, true);
});

test('concurrent spend: separate processes never exceed the admission ceiling', async t => {
    const dir = tempDir(t);
    const file = path.join(dir, 'ledger.sqlite');
    const ledger = new Ledger(file);
    ledger.openRun({ runId: 'race', campaignId: 'c', runCapMicros: 1000, campaignCapMicros: 1000, maxRequests: 1000 });
    const startAt = Date.now() + 1200;
    const runs = await Promise.all(
        ['p1', 'p2', 'p3', 'p4'].map(
            name =>
                new Promise((resolve, reject) => {
                    let out = '';
                    const child = spawn(process.execPath, [
                        '--disable-warning=ExperimentalWarning',
                        path.join(FIXTURES, 'reserve-worker.mjs'),
                        'ledger',
                        file,
                        name,
                        String(startAt),
                        '20',
                        '100',
                    ]);
                    child.stdout.on('data', d => (out += d));
                    child.on('close', code =>
                        code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`)),
                    );
                }),
        ),
    );
    const admitted = runs.flat().filter(Boolean).length;
    assert.equal(admitted, 10, 'exactly cap / reservation size');
    assert.equal(ledger.runTotals('race').reservedMicros, 1000);
    ledger.close();
});

test('the maximum charge is conservative, and unknown bounds are refused', () => {
    assert.equal(maxChargeMicros(FAKE_PRICING, { inputTokensBound: 100, maxOutputTokens: 10 }), 100 * 2 + 10 * 5);
    assert.throws(() => maxChargeMicros(FAKE_PRICING, { maxOutputTokens: 10 }), /input token bound/);
    assert.throws(
        () => maxChargeMicros(FAKE_PRICING, { inputTokensBound: 10, maxOutputTokens: 1, features: ['web_search'] }),
        /cannot be bounded/,
    );
    assert.throws(
        () => maxChargeMicros({ ...FAKE_PRICING, source: undefined }, { inputTokensBound: 1, maxOutputTokens: 1 }),
        /missing source/,
    );
    assert.equal(chargeFromUsageMicros(FAKE_PRICING, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 10 }), 21);
    assert.throws(() => chargeFromUsageMicros(FAKE_PRICING, { inputTokens: -1 }), /Bad usage/);
});
