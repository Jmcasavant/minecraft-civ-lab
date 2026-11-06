// Builds complete server evidence for a Settlement-60 run that should score 100/100. Tests then change one thing at a
// time. This is a hand-built fixture for the scorer; it does not show that the world can be played this way.
export const TEAM = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];
const key = (x, y, z) => `${x},${y},${z}`;

export function terminalBlocks() {
    const blocks = {};
    const put = (x, y, z, name, extra = {}) => (blocks[key(x, y, z)] = { name, ...extra });
    // Shelter: interior x 0..3, z 0..3, y 64..65.
    for (let x = 0; x <= 3; x++)
        for (let z = 0; z <= 3; z++) {
            put(x, 63, z, 'oak_planks');
            put(x, 66, z, 'oak_planks');
            put(x, 64, z, 'air', { light: 12 });
            put(x, 65, z, 'air', { light: 12 });
        }
    for (let n = 0; n <= 3; n++)
        for (const y of [64, 65]) {
            put(n, y, -1, 'oak_planks');
            put(n, y, 4, 'oak_planks');
            put(-1, y, n, 'oak_planks');
            put(4, y, n, 'oak_planks');
        }
    put(1, 64, -1, 'oak_door', { half: 'lower' });
    put(1, 65, -1, 'oak_door', { half: 'upper' });
    put(1, 63, -2, 'dirt');
    put(1, 64, -2, 'air');
    put(1, 65, -2, 'air');
    // Stations, each with a standing cell beside it.
    for (const [x, name] of [
        [10, 'crafting_table'],
        [12, 'furnace'],
        [14, 'chest'],
    ]) {
        put(x, 64, 10, name);
        // The other three sides are known to be blocked, so the verdict depends only on the open side.
        put(x - 1, 64, 10, 'stone');
        put(x + 1, 64, 10, 'stone');
        put(x, 64, 9, 'stone');
        put(x, 64, 11, 'air');
        put(x, 65, 11, 'air');
        put(x, 63, 11, 'dirt');
    }
    // Farm: 16 cells.
    for (let x = 30; x < 38; x++)
        for (const z of [30, 31]) {
            put(x, 64, z, 'wheat', { light: 12, age: 3 });
            put(x, 63, z, 'farmland', { moisture: 7 });
        }
    return blocks;
}

export function settlementEvents({ edit } = {}) {
    const draft = [];
    const add = (type, actorId, payload, extra = {}) => draft.push({ type, actorId, payload, ...extra });
    for (const actor of TEAM) add('player.join', actor, {});
    add('region.registered', TEAM[0], { kind: 'shelter', min: { x: 0, y: 64, z: 0 }, max: { x: 3, y: 65, z: 3 } });
    add('region.registered', TEAM[0], {
        kind: 'settlement',
        min: { x: -20, y: 60, z: -20 },
        max: { x: 40, y: 70, z: 40 },
    });
    add('region.registered', TEAM[1], { kind: 'farm', min: { x: 30, y: 64, z: 30 }, max: { x: 37, y: 64, z: 31 } });
    add('region.registered', TEAM[2], { kind: 'chest', pos: { x: 14, y: 64, z: 10 } });
    for (const [x, to] of [
        [10, 'crafting_table'],
        [12, 'furnace'],
        [14, 'chest'],
    ])
        add('block.change', TEAM[3], { pos: { x, y: 64, z: 10 }, to, cause: 'player_place' });
    for (const actor of TEAM) add('shelter.enter', actor, { via: 'door' });
    // Eight cells complete a full cycle. All sixteen end up planted.
    let cell = 0;
    for (let x = 30; x < 38; x++)
        for (const z of [30, 31]) {
            const pos = { x, y: 64, z };
            const actor = TEAM[cell % 4];
            add('crop.plant', actor, { pos, crop: 'wheat' });
            if (cell < 8) {
                add('crop.mature', null, { pos, crop: 'wheat' });
                add('crop.harvest', actor, { pos, crop: 'wheat', mature: true }, { label: `harvest-${cell}` });
                add('item.pickup', actor, { item: 'wheat', count: 1 }, { correlateTo: `harvest-${cell}` });
                add('crop.plant', actor, { pos, crop: 'wheat' });
            }
            cell++;
        }
    const inventory = () => [{ item: 'bread', count: 5 }];
    for (let second = 3000; second < 3600; second++)
        add(
            'world.sample',
            null,
            {
                second,
                players: TEAM.map(actorId => ({
                    actorId,
                    alive: true,
                    connected: true,
                    food: 18,
                    health: 20,
                    inventory: inventory(),
                })),
                containers: [{ pos: { x: 14, y: 64, z: 10 }, items: [] }],
            },
            { elapsedMs: second * 1000 },
        );
    add(
        'terminal.snapshot',
        null,
        {
            players: TEAM.map(actorId => ({
                actorId,
                alive: true,
                connected: true,
                food: 18,
                health: 20,
                inventory: [...inventory(), { item: 'stone_pickaxe', count: 1, durabilityRemaining: 100 }],
            })),
            blocks: terminalBlocks(),
            containers: [{ pos: { x: 14, y: 64, z: 10 }, items: [] }],
        },
        { elapsedMs: 3600000 },
    );
    edit?.(draft);
    return number(draft);
}

export function number(draft, { source = 'paper', evidenceQuality = 'authoritative' } = {}) {
    let seq = 0;
    const ids = new Map();
    const events = draft.map(d => {
        const { type, actorId, payload, label, correlateTo, elapsedMs } = d;
        seq++;
        const eventId = `${source}-${String(seq).padStart(8, '0')}`;
        if (label) ids.set(label, eventId);
        return {
            schemaVersion: '1',
            runId: 'fixture',
            eventId,
            source,
            sourceSeq: seq,
            collectorSeq: seq,
            tick: seq,
            elapsedMs: elapsedMs ?? seq,
            utc: '2026-11-05T00:00:00.000Z',
            type,
            actorId: actorId ?? null,
            correlationId: correlateTo ?? null,
            payload,
            evidenceQuality,
        };
    });
    for (const event of events)
        if (event.correlationId) event.correlationId = ids.get(event.correlationId) ?? event.correlationId;
    return events;
}

export const terminalOf = draft => draft.find(d => d.type === 'terminal.snapshot').payload;
