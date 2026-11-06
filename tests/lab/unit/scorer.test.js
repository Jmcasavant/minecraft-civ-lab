import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scoreRun } from '../../../lab/evaluator/score.js';
import { loadScenario } from '../../../lab/scenarios.js';
import { number, settlementEvents, TEAM, terminalOf } from '../fixtures/settlement-world.js';

const scenario = loadScenario('settlement-60-v0.1');
const score = (events, evidenceClass = 'authoritative') =>
    scoreRun({ scenario, events, participants: TEAM, evidenceClass });
const scoreEdit = edit => score(settlementEvents({ edit }));
const comp = (result, id) => result.components.find(c => c.id === id);
const expectOutcome = (result, id, outcome, reason) => {
    const c = comp(result, id);
    assert.equal(c.outcome, outcome, `${id}: ${c.reasons.join('; ')}`);
    if (reason) assert.match(c.reasons.join(' '), reason);
    if (outcome !== 'pass' && !['tools', 'infrastructure'].includes(id)) assert.equal(c.points, 0);
};
const blocksOf = draft => terminalOf(draft).blocks;

test('positive fixture: all components pass for 100 points', () => {
    const result = score(settlementEvents());
    for (const c of result.components) assert.equal(c.outcome, 'pass', `${c.id}: ${c.reasons.join('; ')}`);
    assert.equal(result.points, 100);
    assert.equal(result.maxPoints, 100);
    assert.equal(result.primaryCompletion, true);
    for (const c of result.components) {
        assert.ok(c.predicateVersion);
        assert.ok(c.evidenceIds.length > 0, `${c.id} names evidence`);
    }
});

test('the score table matches the handoff: 20, 20, 15, 25 and 20 points', () => {
    const max = id => comp(score(settlementEvents()), id).maxPoints;
    assert.equal(max('shelter.enclosure') + max('shelter.entered'), 20);
    assert.equal(max('tools'), 20);
    assert.equal(max('infrastructure'), 15);
    assert.equal(max('crops.cells') + max('crops.cycles'), 25);
    assert.equal(max('food.reserve') + max('team.functioning'), 20);
});

test('scoring is pure: the same evidence yields the same score', () => {
    assert.deepEqual(score(settlementEvents()), score(settlementEvents()));
});

test('frozen tables exist in the pinned game data, with matching nutrition', () => {
    const data = createRequire(import.meta.url)('minecraft-data')('1.21.6');
    for (const [item, units] of Object.entries(scenario.foodReserve.nutrition))
        assert.equal(data.foodsByName[item]?.foodPoints, units, item);
    for (const name of ['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chicken'])
        assert.equal(Object.hasOwn(scenario.foodReserve.nutrition, name), false, name);
    for (const item of scenario.pickaxes) assert.ok(data.itemsByName[item], item);
    for (const block of [
        ...scenario.shelter.safeFullBlocks,
        ...scenario.shelter.doors,
        ...scenario.crops.blocks,
        ...scenario.stations,
    ])
        assert.ok(data.blocksByName[block], block);
});

// False success claims
test('agent claims, however confident, change nothing', () => {
    const honest = score(settlementEvents());
    const claims = number(
        [
            { type: 'shelter.enter', actorId: TEAM[0], payload: { via: 'door' } },
            { type: 'terminal.snapshot', actorId: TEAM[0], payload: { players: [], blocks: {} } },
            { type: 'agent.claim', actorId: TEAM[0], payload: { text: 'We built a shelter' } },
        ],
        { source: 'agent-agent-a', evidenceQuality: 'claim' },
    );
    const withClaims = [...settlementEvents(), ...claims.map(e => ({ ...e, collectorSeq: e.collectorSeq + 100000 }))];
    const result = score(withClaims);
    assert.equal(result.points, honest.points);
    assert.equal(result.integrity.ignoredNonAuthoritativeEvents, 3);
    const onlyClaims = score(claims);
    assert.equal(onlyClaims.points, 0);
    assert.equal(onlyClaims.integrity.terminalSnapshot, false);
});

test('mock evidence never counts as authoritative', () => {
    const draft = [];
    settlementEvents({ edit: d => draft.push(...d) });
    const mock = number(draft, { source: 'mock-server', evidenceQuality: 'mock' });
    assert.equal(score(mock, 'authoritative').points, 0);
    assert.equal(score(mock, 'mock').evidenceClass, 'mock');
    assert.equal(score(settlementEvents(), 'mock').points, 0);
});

test('a source claiming paper with the wrong quality is ignored', () => {
    const forged = settlementEvents().map(e => ({ ...e, evidenceQuality: 'claim' }));
    assert.equal(score(forged).points, 0);
});

// Shelter
test('an incomplete roof fails the enclosure', () => {
    const result = scoreEdit(d => (blocksOf(d)['2,66,2'] = { name: 'air' }));
    expectOutcome(result, 'shelter.enclosure', 'fail', /Roof gap/);
    assert.equal(result.points, 85);
    assert.equal(result.primaryCompletion, false);
});

test('a roof made of decoration fails', () => {
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['1,66,1'] = { name: 'torch' })),
        'shelter.enclosure',
        'fail',
        /Roof gap/,
    );
});

test('a hole in a wall fails', () => {
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['0,65,4'] = { name: 'air' })),
        'shelter.enclosure',
        'fail',
        /Wall gap/,
    );
});

test('a lava floor and a flooded interior fail', () => {
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['1,63,1'] = { name: 'lava' })),
        'shelter.enclosure',
        'fail',
        /Unsafe floor/,
    );
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['1,64,1'] = { name: 'water', light: 12 })),
        'shelter.enclosure',
        'fail',
        /holds water/,
    );
});

test('a disconnected door, with no way to stand outside it, fails', () => {
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['1,65,-2'] = { name: 'stone' })),
        'shelter.enclosure',
        'fail',
        /No operable door/,
    );
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['1,63,-2'] = { name: 'air' })),
        'shelter.enclosure',
        'fail',
        /No operable door/,
    );
});

test('no door at all, a malformed door and an iron door all fail', () => {
    expectOutcome(
        scoreEdit(d => {
            blocksOf(d)['1,64,-1'] = { name: 'oak_planks' };
            blocksOf(d)['1,65,-1'] = { name: 'oak_planks' };
        }),
        'shelter.enclosure',
        'fail',
        /No operable door/,
    );
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['1,65,-1'] = { name: 'oak_door', half: 'lower' })),
        'shelter.enclosure',
        'fail',
        /Malformed door/,
    );
    expectOutcome(
        scoreEdit(d => {
            blocksOf(d)['1,64,-1'] = { name: 'iron_door', half: 'lower' };
            blocksOf(d)['1,65,-1'] = { name: 'iron_door', half: 'upper' };
        }),
        'shelter.enclosure',
        'fail',
    );
});

test('too small and oversized regions fail', () => {
    const resize = max => d => {
        const reg = d.find(e => e.payload?.kind === 'shelter');
        reg.payload = { ...reg.payload, max };
    };
    expectOutcome(scoreEdit(resize({ x: 2, y: 65, z: 3 })), 'shelter.enclosure', 'fail', /too small/);
    expectOutcome(scoreEdit(resize({ x: 40, y: 65, z: 3 })), 'shelter.enclosure', 'fail', /inspection bound/);
});

test('low light fails, and unknown light or an unknown cell is unsupported', () => {
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['0,64,0'] = { name: 'air', light: 3 })),
        'shelter.enclosure',
        'fail',
        /Light 3/,
    );
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['0,64,0'] = { name: 'air' })),
        'shelter.enclosure',
        'unsupported',
        /No light level/,
    );
    expectOutcome(
        scoreEdit(d => delete blocksOf(d)['0,63,0']),
        'shelter.enclosure',
        'unsupported',
        /no data/,
    );
});

test('entry by teleport, or a member who never entered, loses the entry points', () => {
    const teleport = scoreEdit(d => (d.find(e => e.type === 'shelter.enter').payload = { via: 'teleport' }));
    expectOutcome(teleport, 'shelter.entered', 'fail', /Never entered/);
    assert.equal(teleport.points, 95);
});

// Tools
test('each member needs their own usable approved pickaxe', () => {
    const strip = actor => d => {
        const p = terminalOf(d).players.find(x => x.actorId === actor);
        p.inventory = p.inventory.filter(i => i.item !== 'stone_pickaxe');
    };
    const one = scoreEdit(strip('agent-b'));
    expectOutcome(one, 'tools', 'fail', /agent-b/);
    assert.equal(comp(one, 'tools').points, 15);
    const hoarded = scoreEdit(d => {
        for (const actor of ['agent-b', 'agent-c', 'agent-d']) strip(actor)(d);
        terminalOf(d).players[0].inventory.push({ item: 'stone_pickaxe', count: 3, durabilityRemaining: 100 });
    });
    assert.equal(comp(hoarded, 'tools').points, 5, 'one holder cannot cover other members');
});

test('a wooden pickaxe, a broken one or a name that only looks right does not qualify', () => {
    for (const bad of [
        { item: 'wooden_pickaxe', count: 1, durabilityRemaining: 50 },
        { item: 'stone_pickaxe', count: 1, durabilityRemaining: 0 },
        { item: 'stone_pickaxe_replica', count: 1, durabilityRemaining: 50 },
    ]) {
        const result = scoreEdit(d => {
            const p = terminalOf(d).players[0];
            p.inventory = [...p.inventory.filter(i => i.item !== 'stone_pickaxe'), bad];
        });
        assert.equal(comp(result, 'tools').points, 15, bad.item);
    }
});

// Infrastructure
test('fixture stations without a recorded team placement are ineligible', () => {
    const result = scoreEdit(d =>
        d.splice(
            d.findIndex(e => e.type === 'block.change' && e.payload.to === 'furnace'),
            1,
        ),
    );
    expectOutcome(result, 'infrastructure', 'fail', /furnace/);
    assert.equal(comp(result, 'infrastructure').points, 10);
});

test('a station that was removed, walled in or placed outside the area earns nothing', () => {
    assert.equal(
        comp(
            scoreEdit(d => (blocksOf(d)['10,64,10'] = { name: 'air' })),
            'infrastructure',
        ).points,
        10,
    );
    assert.equal(
        comp(
            scoreEdit(d => (blocksOf(d)['12,65,11'] = { name: 'stone' })),
            'infrastructure',
        ).points,
        10,
    );
    const outside = scoreEdit(d => {
        const reg = d.find(e => e.payload?.kind === 'settlement');
        reg.payload = { ...reg.payload, max: { x: 11, y: 70, z: 40 } };
    });
    assert.equal(comp(outside, 'infrastructure').points, 5);
});

test('repeatedly replacing one station still counts it once', () => {
    const result = scoreEdit(d => {
        d.forEach(e => {
            if (e.type === 'block.change' && e.payload.to !== 'crafting_table')
                e.payload = { ...e.payload, to: 'crafting_table', pos: { x: 10, y: 64, z: 10 } };
        });
    });
    assert.equal(comp(result, 'infrastructure').points, 5);
});

// Crops
const cycleEdit = fn => d =>
    fn(
        d.filter(e => e.type.startsWith('crop.') || (e.type === 'item.pickup' && e.correlateTo)),
        d,
    );

test('natural crops with no team planting do not count', () => {
    const result = scoreEdit(d => {
        for (let i = d.length - 1; i >= 0; i--)
            if (d[i].type === 'crop.plant' && d[i].payload.pos.x === 37) d.splice(i, 1);
    });
    expectOutcome(result, 'crops.cells', 'fail', /14 of 16/);
});

test('a cell with no water or poor light is not eligible', () => {
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['30,63,30'] = { name: 'farmland', moisture: 0 })),
        'crops.cells',
        'fail',
        /15 of 16/,
    );
    expectOutcome(
        scoreEdit(d => (blocksOf(d)['31,64,30'] = { name: 'wheat', light: 4 })),
        'crops.cells',
        'fail',
        /15 of 16/,
    );
});

test('planting without harvesting earns cell credit but no cycle credit', () => {
    const result = scoreEdit(d => {
        for (let i = d.length - 1; i >= 0; i--) if (['crop.harvest', 'crop.mature'].includes(d[i].type)) d.splice(i, 1);
    });
    expectOutcome(result, 'crops.cells', 'pass');
    expectOutcome(result, 'crops.cycles', 'fail', /0 of 8/);
});

test('immature harvests do not satisfy cycle credit', () => {
    const result = scoreEdit(
        cycleEdit(events => {
            events.find(e => e.type === 'crop.harvest').payload.mature = false;
        }),
    );
    expectOutcome(result, 'crops.cycles', 'fail', /7 of 8/);
});

test('a harvest with no attributable collection does not count', () => {
    const result = scoreEdit(d => {
        const i = d.findIndex(e => e.type === 'item.pickup' && e.correlateTo);
        d.splice(i, 1);
    });
    expectOutcome(result, 'crops.cycles', 'fail', /7 of 8/);
});

test('a harvest with no replant does not complete a cycle', () => {
    const result = scoreEdit(d => {
        const harvest = d.findIndex(e => e.type === 'crop.harvest');
        const replant = d.findIndex((e, i) => i > harvest && e.type === 'crop.plant');
        d.splice(replant, 1);
    });
    expectOutcome(result, 'crops.cycles', 'fail', /7 of 8/);
});

test('repeated pickups cannot inflate cycle credit', () => {
    const result = scoreEdit(d => {
        const pickup = d.find(e => e.type === 'item.pickup' && e.correlateTo);
        const at = d.indexOf(pickup);
        for (let n = 0; n < 20; n++) d.splice(at, 0, { ...pickup });
        const harvests = d.filter(e => e.type === 'crop.harvest').slice(1);
        for (const harvest of harvests) d.splice(d.indexOf(harvest), 1);
    });
    expectOutcome(result, 'crops.cycles', 'fail', /1 of 8/);
});

test('a harvest by an outsider breaks the chain', () => {
    const result = scoreEdit(d => (d.find(e => e.type === 'crop.harvest').actorId = 'visitor'));
    expectOutcome(result, 'crops.cycles', 'fail', /7 of 8/);
});

// Food
test('a transfer between inventory and chest cannot raise the total', () => {
    const moved = scoreEdit(d => {
        for (const e of d) {
            if (!['world.sample', 'terminal.snapshot'].includes(e.type)) continue;
            const players = e.payload.players.map(p => ({
                ...p,
                inventory: p.inventory.filter(i => i.item !== 'bread'),
            }));
            e.payload = {
                ...e.payload,
                players,
                containers: [{ pos: { x: 14, y: 64, z: 10 }, items: [{ item: 'bread', count: 20 }] }],
            };
        }
    });
    expectOutcome(moved, 'food.reserve', 'pass');
});

test('reporting the same chest twice counts it once', () => {
    const result = scoreEdit(d => {
        for (const e of d) {
            if (!['world.sample', 'terminal.snapshot'].includes(e.type)) continue;
            const players = e.payload.players.map(p => ({
                ...p,
                inventory: p.inventory.filter(i => i.item !== 'bread'),
            }));
            const chest = { pos: { x: 14, y: 64, z: 10 }, items: [{ item: 'bread', count: 9 }] };
            e.payload = { ...e.payload, players, containers: [chest, chest, chest] };
        }
    });
    // Nine bread is 45 units. Counting the chest three times would be 135 and would wrongly pass.
    expectOutcome(result, 'food.reserve', 'fail', /Reserve 45 at cutoff is below 80/);
});

test('food in an unregistered chest and unsafe food are excluded', () => {
    const swap =
        (build, kept = []) =>
        d => {
            for (const e of d) {
                if (!['world.sample', 'terminal.snapshot'].includes(e.type)) continue;
                const players = e.payload.players.map(p => ({
                    ...p,
                    inventory: [...p.inventory.filter(i => i.item !== 'bread'), ...kept],
                }));
                e.payload = { ...e.payload, players, containers: build() };
            }
        };
    expectOutcome(
        scoreEdit(swap(() => [{ pos: { x: 99, y: 64, z: 99 }, items: [{ item: 'bread', count: 64 }] }])),
        'food.reserve',
        'fail',
    );
    expectOutcome(scoreEdit(swap(() => [], [{ item: 'rotten_flesh', count: 64 }])), 'food.reserve', 'fail');
});

test('a dead participant does not contribute to the reserve', () => {
    const result = scoreEdit(d => {
        for (const e of d) {
            if (e.type !== 'terminal.snapshot') continue;
            e.payload = {
                ...e.payload,
                players: e.payload.players.map(p => (p.actorId === TEAM[0] ? p : { ...p, alive: false })),
            };
        }
    });
    expectOutcome(result, 'food.reserve', 'fail', /Reserve 25 at cutoff/);
});

test('one low sample fails the reserve, and missing samples are unsupported', () => {
    const low = scoreEdit(d => {
        const sample = d.find(e => e.type === 'world.sample' && e.payload.second === 3300);
        sample.payload = { ...sample.payload, players: sample.payload.players.map(p => ({ ...p, inventory: [] })) };
    });
    expectOutcome(low, 'food.reserve', 'fail', /second 3300/);
    const missing = scoreEdit(d =>
        d.splice(
            d.findIndex(e => e.type === 'world.sample' && e.payload.second === 3300),
            1,
        ),
    );
    expectOutcome(missing, 'food.reserve', 'unsupported', /1 samples missing/);
    expectOutcome(missing, 'team.functioning', 'unsupported', /1 samples missing/);
});

// Functioning team
test('a death or a logout in the final window fails, and earlier deaths do not', () => {
    const death = at => d =>
        d.splice(d.length - 1, 0, { type: 'player.death', actorId: TEAM[0], payload: {}, elapsedMs: at });
    expectOutcome(scoreEdit(death(3100000)), 'team.functioning', 'fail', /1 deaths/);
    expectOutcome(scoreEdit(death(100000)), 'team.functioning', 'pass');
    const logout = scoreEdit(d => {
        const sample = d.find(e => e.type === 'world.sample' && e.payload.second === 3500);
        sample.payload = {
            ...sample.payload,
            players: sample.payload.players.map(p => (p.actorId === TEAM[1] ? { ...p, connected: false } : p)),
        };
    });
    expectOutcome(logout, 'team.functioning', 'fail', /agent-b not connected/);
});

test('hunger and health limits apply at samples and at the cutoff', () => {
    const atSample = scoreEdit(d => {
        const sample = d.find(e => e.type === 'world.sample' && e.payload.second === 3500);
        sample.payload = { ...sample.payload, players: sample.payload.players.map(p => ({ ...p, food: 5 })) };
    });
    expectOutcome(atSample, 'team.functioning', 'fail', /food 5/);
    const atCutoff = key => value =>
        scoreEdit(d => {
            const t = terminalOf(d);
            t.players[0] = { ...t.players[0], [key]: value };
        });
    expectOutcome(atCutoff('food')(11), 'team.functioning', 'fail');
    expectOutcome(atCutoff('health')(9), 'team.functioning', 'fail');
    expectOutcome(atCutoff('food')(12), 'team.functioning', 'pass');
});

// Evidence integrity
test('a missing terminal snapshot cannot produce success', () => {
    const result = scoreEdit(d =>
        d.splice(
            d.findIndex(e => e.type === 'terminal.snapshot'),
            1,
        ),
    );
    assert.equal(result.primaryCompletion, false);
    assert.equal(result.points, 0);
    assert.equal(result.integrity.terminalSnapshot, false);
    for (const c of result.components) assert.equal(c.outcome, 'unsupported', c.id);
});

test('a critical sequence gap marks event-based criteria unsupported and is never smoothed over', () => {
    const events = settlementEvents();
    events.splice(10, 3);
    const result = score(events);
    assert.equal(result.primaryCompletion, false);
    assert.equal(result.integrity.sequenceGaps.length, 1);
    for (const id of [
        'shelter.entered',
        'infrastructure',
        'crops.cells',
        'crops.cycles',
        'food.reserve',
        'team.functioning',
    ])
        expectOutcome(result, id, 'unsupported', /Sequence gaps/);
    expectOutcome(result, 'tools', 'pass');
    expectOutcome(result, 'shelter.enclosure', 'pass');
});

test('duplicated evidence is reported as a gap rather than double counted', () => {
    const events = settlementEvents();
    const result = score([...events, { ...events[5], collectorSeq: events.at(-1).collectorSeq + 1 }]);
    assert.ok(result.integrity.sequenceGaps.some(g => g.duplicate));
    assert.equal(result.primaryCompletion, false);
});

test('events after the cutoff are preserved but do not score', () => {
    const events = settlementEvents();
    const late = number([{ type: 'shelter.enter', actorId: TEAM[0], payload: { via: 'door' } }]).map(e => ({
        ...e,
        sourceSeq: events.at(-1).sourceSeq + 1,
        collectorSeq: events.at(-1).collectorSeq + 1,
        eventId: 'paper-late',
    }));
    const removedEntry = settlementEvents({
        edit: d =>
            d.splice(
                d.findIndex(e => e.type === 'shelter.enter'),
                1,
            ),
    });
    const result = score([
        ...removedEntry,
        {
            ...late[0],
            sourceSeq: removedEntry.at(-1).sourceSeq + 1,
            collectorSeq: removedEntry.at(-1).collectorSeq + 1,
        },
    ]);
    assert.equal(result.integrity.lateEvents, 1);
    expectOutcome(result, 'shelter.entered', 'fail', /agent-a/);
});

// Missing telemetry is not evidence
const withoutFields = (players, ...fields) =>
    players.map(p => Object.fromEntries(Object.entries(p).filter(([name]) => !fields.includes(name))));
const editStates = (d, change) => {
    for (const e of d)
        if (['world.sample', 'terminal.snapshot'].includes(e.type)) e.payload = { ...e.payload, ...change(e) };
};

test('missing vitals are unsupported, at samples and at the cutoff', () => {
    expectOutcome(
        scoreEdit(d => editStates(d, e => ({ players: withoutFields(e.payload.players, 'food', 'health') }))),
        'team.functioning',
        'unsupported',
    );
    expectOutcome(
        scoreEdit(d => (terminalOf(d).players = withoutFields(terminalOf(d).players, 'health'))),
        'team.functioning',
        'unsupported',
        /health/,
    );
    const oneSample = scoreEdit(d => {
        const sample = d.find(e => e.type === 'world.sample' && e.payload.second === 3500);
        sample.payload = { ...sample.payload, players: withoutFields(sample.payload.players, 'food') };
    });
    expectOutcome(oneSample, 'team.functioning', 'unsupported', /food/);
    expectOutcome(
        scoreEdit(d => (terminalOf(d).players = withoutFields(terminalOf(d).players, 'connected'))),
        'team.functioning',
        'unsupported',
    );
});

test('a known vitals failure still fails when other vitals are unknown', () => {
    const result = scoreEdit(d => {
        const t = terminalOf(d);
        t.players = t.players.map((p, i) => (i === 0 ? { ...p, food: 2 } : withoutFields([p], 'health')[0]));
    });
    expectOutcome(result, 'team.functioning', 'fail', /food 2/);
});

test('a snapshot with no player data is unsupported and does not crash', () => {
    const result = scoreEdit(d => delete terminalOf(d).players);
    for (const id of ['tools', 'food.reserve', 'team.functioning']) expectOutcome(result, id, 'unsupported');
});

test('unknown pickaxe data is unsupported, while a known missing pickaxe still fails', () => {
    const inventoryGone = scoreEdit(d => (terminalOf(d).players = withoutFields(terminalOf(d).players, 'inventory')));
    expectOutcome(inventoryGone, 'tools', 'unsupported');
    const noDurability = scoreEdit(d => {
        const p = terminalOf(d).players[0];
        p.inventory = p.inventory.map(i => (i.item === 'stone_pickaxe' ? { item: i.item, count: 1 } : i));
    });
    expectOutcome(noDurability, 'tools', 'unsupported', /durability/);
    const mixed = scoreEdit(d => {
        const [first, second] = terminalOf(d).players;
        first.inventory = first.inventory.filter(i => i.item !== 'stone_pickaxe');
        delete second.inventory;
    });
    expectOutcome(mixed, 'tools', 'fail', /agent-a/);
    assert.equal(comp(mixed, 'tools').points, 10);
});

test('crop cells missing from the snapshot are unsupported when they could change the verdict', () => {
    for (const edit of [
        d => delete blocksOf(d)['30,64,30'],
        d => delete blocksOf(d)['30,63,30'],
        d => (blocksOf(d)['30,63,30'] = { name: 'farmland' }),
        d => (blocksOf(d)['30,64,30'] = { name: 'wheat', age: 3 }),
    ])
        expectOutcome(scoreEdit(edit), 'crops.cells', 'unsupported', /1 unknown/);
});

test('crop cells stay a failure when unknown cells could not reach the threshold', () => {
    const result = scoreEdit(d => {
        blocksOf(d)['30,63,30'] = { name: 'farmland', moisture: 0 };
        delete blocksOf(d)['31,64,30'];
    });
    expectOutcome(result, 'crops.cells', 'fail', /14 of 16/);
    const notFarmland = scoreEdit(d => (blocksOf(d)['30,63,30'] = { name: 'dirt' }));
    expectOutcome(notFarmland, 'crops.cells', 'fail', /15 of 16/);
});

test('station cells missing from the snapshot are unsupported, not a failure', () => {
    expectOutcome(
        scoreEdit(d => delete blocksOf(d)['10,64,10']),
        'infrastructure',
        'unsupported',
        /crafting_table/,
    );
    expectOutcome(
        scoreEdit(d => delete blocksOf(d)['12,65,11']),
        'infrastructure',
        'unsupported',
        /furnace/,
    );
    const mixed = scoreEdit(d => {
        delete blocksOf(d)['10,64,10'];
        blocksOf(d)['12,64,10'] = { name: 'air' };
    });
    expectOutcome(mixed, 'infrastructure', 'fail', /furnace/);
    assert.equal(comp(mixed, 'infrastructure').points, 5);
});

test('unreadable food data is unsupported when it could change the verdict', () => {
    const noCounts = d =>
        editStates(d, e => ({
            players: e.payload.players.map(p => ({ ...p, inventory: [{ item: 'bread' }] })),
        }));
    expectOutcome(scoreEdit(noCounts), 'food.reserve', 'unsupported');
    const memberGone = scoreEdit(d => {
        editStates(d, e => ({
            players: e.payload.players
                .filter(p => p.actorId !== TEAM[0])
                .map(p => ({ ...p, inventory: [{ item: 'bread', count: 1 }] })),
        }));
    });
    expectOutcome(memberGone, 'food.reserve', 'unsupported');
    const enoughAnyway = scoreEdit(d => {
        editStates(d, e => ({ players: e.payload.players.filter(p => p.actorId !== TEAM[0]) }));
        terminalOf(d).players[0].inventory.push({ item: 'bread', count: 20 });
        for (const e of d)
            if (e.type === 'world.sample') e.payload.players[0].inventory = [{ item: 'bread', count: 20 }];
    });
    expectOutcome(enoughAnyway, 'food.reserve', 'pass');
});

// Only the team's own evidence counts
const emptyTeamFood = e => ({
    players: e.payload.players.map(p => ({ ...p, inventory: p.inventory.filter(i => i.item !== 'bread') })),
});

test("a visitor's food does not count toward the team's reserve", () => {
    const result = scoreEdit(d =>
        editStates(d, e => ({
            players: [
                ...emptyTeamFood(e).players,
                { actorId: 'visitor', alive: true, connected: true, inventory: [{ item: 'bread', count: 64 }] },
            ],
        })),
    );
    expectOutcome(result, 'food.reserve', 'fail');
});

test('a chest registered by a visitor does not count', () => {
    const result = scoreEdit(d => {
        d.splice(1, 0, {
            type: 'region.registered',
            actorId: 'visitor',
            payload: { kind: 'chest', pos: { x: 99, y: 64, z: 99 } },
        });
        editStates(d, e => ({
            ...emptyTeamFood(e),
            containers: [{ pos: { x: 99, y: 64, z: 99 }, items: [{ item: 'bread', count: 64 }] }],
        }));
    });
    expectOutcome(result, 'food.reserve', 'fail');
});

test("a visitor's death does not count against the team", () => {
    const death = actorId => d =>
        d.splice(d.length - 1, 0, { type: 'player.death', actorId, payload: {}, elapsedMs: 3100000 });
    expectOutcome(scoreEdit(death('visitor')), 'team.functioning', 'pass');
    expectOutcome(scoreEdit(death(TEAM[2])), 'team.functioning', 'fail', /1 deaths/);
});

test('primary completion needs every component, not just a high total', () => {
    const result = scoreEdit(d => (blocksOf(d)['0,66,0'] = { name: 'air' }));
    assert.equal(result.points, 85);
    assert.equal(result.primaryCompletion, false);
});
