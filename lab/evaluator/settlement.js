import { component, unsupported } from './evidence.js';

// Settlement-60 v0.1 predicates. Pure functions of the evidence and the scenario's frozen tables. Telemetry that is
// missing is unknown, which yields `unsupported`, never `fail` or `pass`. A failure already known from other evidence
// still fails, because the missing data could not rescue it. Only participants' own evidence can move a team's score.
const V = 'settlement-60/0.1';
const key = ({ x, y, z }) => `${x},${y},${z}`;
const inBox = (p, b) =>
    p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

class Unknown extends Error {}
const blockAt = (blocks, x, y, z) => {
    const block = blocks[key({ x, y, z })];
    if (!block) throw new Unknown(`Terminal snapshot has no data for ${x},${y},${z}`);
    return block;
};

function latestRegion(evidence, kind) {
    const regs = evidence.window.filter(
        e => e.type === 'region.registered' && e.payload.kind === kind && evidence.participants.has(e.actorId),
    );
    return regs.at(-1) ?? null;
}

// Returns a list of problems. Throws Unknown when the snapshot lacks a cell the verdict depends on.
export function shelterProblems(box, blocks, rules) {
    const problems = [];
    const width = box.max.x - box.min.x + 1;
    const depth = box.max.z - box.min.z + 1;
    const height = box.max.y - box.min.y + 1;
    if (width < rules.minInteriorWidth || depth < rules.minInteriorDepth)
        problems.push(`Interior ${width}x${depth} is too small`);
    if (height < rules.minInteriorHeight) problems.push(`Interior height ${height} is too low`);
    if (width > rules.maxInteriorWidth || depth > rules.maxInteriorDepth || height > rules.maxInteriorHeight)
        return [...problems, 'Region exceeds the inspection bound'];
    if (problems.length) return problems;
    const solid = new Set(rules.safeFullBlocks);
    const passable = new Set(rules.passable);
    const doors = new Set(rules.doors);
    for (let x = box.min.x; x <= box.max.x; x++)
        for (let z = box.min.z; z <= box.max.z; z++) {
            const floor = blockAt(blocks, x, box.min.y - 1, z);
            if (!solid.has(floor.name)) problems.push(`Unsafe floor ${floor.name} at ${x},${box.min.y - 1},${z}`);
            const roof = blockAt(blocks, x, box.max.y + 1, z);
            if (!solid.has(roof.name)) problems.push(`Roof gap ${roof.name} at ${x},${box.max.y + 1},${z}`);
            for (let y = box.min.y; y <= box.max.y; y++) {
                const cell = blockAt(blocks, x, y, z);
                if (!passable.has(cell.name)) problems.push(`Interior cell ${x},${y},${z} holds ${cell.name}`);
            }
            const standing = blockAt(blocks, x, box.min.y, z);
            if (standing.light === undefined) throw new Unknown(`No light level for ${x},${box.min.y},${z}`);
            if (standing.light < rules.minBlockLight)
                problems.push(`Light ${standing.light} at ${x},${box.min.y},${z}`);
        }
    const ring = [];
    for (let x = box.min.x; x <= box.max.x; x++)
        ring.push({ x, z: box.min.z - 1, out: { x: 0, z: -1 } }, { x, z: box.max.z + 1, out: { x: 0, z: 1 } });
    for (let z = box.min.z; z <= box.max.z; z++)
        ring.push({ x: box.min.x - 1, z, out: { x: -1, z: 0 } }, { x: box.max.x + 1, z, out: { x: 1, z: 0 } });
    let routed = false;
    for (const wall of ring) {
        const lower = blockAt(blocks, wall.x, box.min.y, wall.z);
        if (doors.has(lower.name)) {
            const upper = blockAt(blocks, wall.x, box.min.y + 1, wall.z);
            if (upper.name !== lower.name || lower.half !== 'lower' || upper.half !== 'upper') {
                problems.push(`Malformed door at ${wall.x},${box.min.y},${wall.z}`);
                continue;
            }
            for (let y = box.min.y + 2; y <= box.max.y; y++) {
                const above = blockAt(blocks, wall.x, y, wall.z);
                if (!solid.has(above.name)) problems.push(`Wall gap ${above.name} at ${wall.x},${y},${wall.z}`);
            }
            const ox = wall.x + wall.out.x;
            const oz = wall.z + wall.out.z;
            const ground = blockAt(blocks, ox, box.min.y - 1, oz);
            const feet = blockAt(blocks, ox, box.min.y, oz);
            const head = blockAt(blocks, ox, box.min.y + 1, oz);
            if (solid.has(ground.name) && passable.has(feet.name) && passable.has(head.name)) routed = true;
            continue;
        }
        for (let y = box.min.y; y <= box.max.y; y++) {
            const block = blockAt(blocks, wall.x, y, wall.z);
            if (!solid.has(block.name)) problems.push(`Wall gap ${block.name} at ${wall.x},${y},${wall.z}`);
        }
    }
    if (!routed) problems.push('No operable door with a walkable exterior route');
    return problems;
}

function scoreShelter(evidence, scenario) {
    const out = [];
    const reg = latestRegion(evidence, 'shelter');
    const terminal = evidence.terminal;
    if (!terminal)
        return [
            unsupported('shelter.enclosure', V, 15, 'No terminal snapshot'),
            unsupported('shelter.entered', V, 5, 'No terminal snapshot'),
        ];
    if (!reg)
        out.push(component('shelter.enclosure', V, 15, 'fail', { reasons: ['No shelter region was registered'] }));
    else {
        try {
            const problems = shelterProblems(reg.payload, terminal.payload.blocks ?? {}, scenario.shelter);
            out.push(
                component('shelter.enclosure', V, 15, problems.length ? 'fail' : 'pass', {
                    evidenceIds: [reg.eventId, terminal.eventId],
                    reasons: problems.slice(0, 10),
                }),
            );
        } catch (error) {
            if (!(error instanceof Unknown)) throw error;
            out.push(unsupported('shelter.enclosure', V, 15, error.message));
        }
    }
    if (evidence.gaps.length) out.push(unsupported('shelter.entered', V, 5, 'Sequence gaps in server evidence'));
    else {
        const entries = evidence.window.filter(e => e.type === 'shelter.enter' && e.payload.via !== 'teleport');
        const missing = [...evidence.participants].filter(actor => !entries.some(e => e.actorId === actor));
        const passed = Boolean(reg) && !missing.length;
        out.push(
            component('shelter.entered', V, 5, passed ? 'pass' : 'fail', {
                evidenceIds: entries.map(e => e.eventId),
                reasons: missing.length ? [`Never entered through gameplay: ${missing.join(', ')}`] : [],
            }),
        );
    }
    return out;
}

const playersOf = state => (Array.isArray(state.players) ? new Map(state.players.map(p => [p.actorId, p])) : null);

function scoreTools(evidence, scenario) {
    const id = 'tools';
    if (!evidence.terminal) return unsupported(id, V, 20, 'No terminal snapshot');
    const players = playersOf(evidence.terminal.payload);
    if (!players) return unsupported(id, V, 20, 'Terminal snapshot has no player data');
    const allowed = new Set(scenario.pickaxes);
    const missing = [];
    const unknown = [];
    let points = 0;
    for (const actor of evidence.participants) {
        const items = players.get(actor)?.inventory;
        if (!Array.isArray(items)) {
            unknown.push(`No inventory data for ${actor}`);
            continue;
        }
        const pickaxes = items.filter(i => allowed.has(i.item) && i.count > 0);
        if (pickaxes.some(i => i.durabilityRemaining > 0)) points += 5;
        else if (pickaxes.some(i => typeof i.durabilityRemaining !== 'number'))
            unknown.push(`No durability data for ${actor}'s pickaxe`);
        else missing.push(actor);
    }
    if (!missing.length && unknown.length) return unsupported(id, V, 20, unknown.join('; '));
    return component(id, V, 20, missing.length ? 'fail' : 'pass', {
        points,
        evidenceIds: [evidence.terminal.eventId],
        reasons: missing.length ? [`No qualifying pickaxe at cutoff: ${missing.join(', ')}`] : [],
    });
}

function scoreInfrastructure(evidence, scenario) {
    const id = 'infrastructure';
    if (!evidence.terminal) return unsupported(id, V, 15, 'No terminal snapshot');
    if (evidence.gaps.length) return unsupported(id, V, 15, 'Sequence gaps in server evidence');
    const region = latestRegion(evidence, 'settlement');
    if (!region) return component(id, V, 15, 'fail', { reasons: ['No settlement region was registered'] });
    const blocks = evidence.terminal.payload.blocks ?? {};
    const passable = new Set(scenario.shelter.passable);
    const solid = new Set(scenario.shelter.safeFullBlocks);
    const evidenceIds = [region.eventId, evidence.terminal.eventId];
    const reasons = [];
    const unknown = [];
    let points = 0;
    for (const station of scenario.stations) {
        let stationUnknown = false;
        const placements = evidence.window.filter(
            e =>
                e.type === 'block.change' &&
                e.payload.to === station &&
                e.payload.cause === 'player_place' &&
                evidence.participants.has(e.actorId) &&
                inBox(e.payload.pos, region.payload),
        );
        const standing = placements.find(e => {
            const { x, y, z } = e.payload.pos;
            const block = blocks[key(e.payload.pos)];
            if (!block) {
                stationUnknown = true;
                return false;
            }
            if (block.name !== station) return false;
            return [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ].some(([dx, dz]) => {
                const feet = blocks[key({ x: x + dx, y, z: z + dz })];
                const head = blocks[key({ x: x + dx, y: y + 1, z: z + dz })];
                const ground = blocks[key({ x: x + dx, y: y - 1, z: z + dz })];
                const blocked =
                    (feet && !passable.has(feet.name)) ||
                    (head && !passable.has(head.name)) ||
                    (ground && !solid.has(ground.name));
                if (blocked) return false;
                if (feet && head && ground) return true;
                stationUnknown = true;
                return false;
            });
        });
        if (standing) {
            points += 5;
            evidenceIds.push(standing.eventId);
        } else if (stationUnknown) unknown.push(`Terminal snapshot cannot show whether ${station} is reachable`);
        else reasons.push(`No team-placed, reachable ${station} in the settlement area at cutoff`);
    }
    if (!reasons.length && unknown.length) return unsupported(id, V, 15, unknown.join('; '));
    return component(id, V, 15, reasons.length ? 'fail' : 'pass', { points, evidenceIds, reasons });
}

function scoreCrops(evidence, scenario) {
    const rules = scenario.crops;
    const terminal = evidence.terminal;
    if (!terminal)
        return [
            unsupported('crops.cells', V, 15, 'No terminal snapshot'),
            unsupported('crops.cycles', V, 10, 'No terminal snapshot'),
        ];
    if (evidence.gaps.length) {
        const reason = 'Sequence gaps in server evidence';
        return [unsupported('crops.cells', V, 15, reason), unsupported('crops.cycles', V, 10, reason)];
    }
    const region = latestRegion(evidence, 'farm');
    if (!region) {
        const reasons = ['No farm region was registered'];
        return [
            component('crops.cells', V, 15, 'fail', { reasons }),
            component('crops.cycles', V, 10, 'fail', { reasons }),
        ];
    }
    const cropSet = new Set(rules.blocks);
    const blocks = terminal.payload.blocks ?? {};
    const byTeam = e => evidence.participants.has(e.actorId);
    const cropEvents = evidence.window.filter(e => e.type.startsWith('crop.') && inBox(e.payload.pos, region.payload));
    const plantedCells = new Set(
        cropEvents.filter(e => e.type === 'crop.plant' && byTeam(e)).map(e => key(e.payload.pos)),
    );
    // Each condition is true, false, or null when the snapshot does not say. One known false rules the cell out.
    const known = (data, check) => (data === undefined ? null : check(data));
    const eligible = [];
    let unknownCells = 0;
    for (const cell of plantedCells) {
        const block = blocks[cell];
        if (!block) {
            unknownCells++;
            continue;
        }
        if (!cropSet.has(block.name)) continue;
        const [x, y, z] = cell.split(',').map(Number);
        const below = blocks[key({ x, y: y - 1, z })];
        const conditions = [
            known(below?.name, name => name === 'farmland'),
            known(below?.name === 'farmland' ? below.moisture : 1, moisture => moisture > 0),
            known(block.light, light => light >= rules.minLight),
        ];
        if (conditions.includes(false)) continue;
        if (conditions.includes(null)) unknownCells++;
        else eligible.push(cell);
    }
    const cellSummary = `${eligible.length} of ${rules.minEligibleCells} eligible living crop cells at cutoff`;
    const cells =
        eligible.length < rules.minEligibleCells && eligible.length + unknownCells >= rules.minEligibleCells
            ? unsupported('crops.cells', V, 15, `${cellSummary}, with ${unknownCells} unknown`)
            : component('crops.cells', V, 15, eligible.length >= rules.minEligibleCells ? 'pass' : 'fail', {
                  evidenceIds: [region.eventId, terminal.eventId],
                  reasons: [cellSummary],
              });

    const pickups = new Set(
        evidence.window.filter(e => e.type === 'item.pickup' && byTeam(e) && e.correlationId).map(e => e.correlationId),
    );
    const cycleIds = [];
    const evidenceIds = [];
    const perCell = new Map();
    for (const event of cropEvents) {
        const cell = key(event.payload.pos);
        if (!perCell.has(cell)) perCell.set(cell, []);
        perCell.get(cell).push(event);
    }
    for (const [cell, events] of perCell) {
        let stage = 'none';
        let trail = [];
        let count = 0;
        for (const event of events) {
            if (event.type === 'crop.plant' && byTeam(event)) {
                if (stage === 'harvested') {
                    count++;
                    cycleIds.push(`${cell}#${count}`);
                    evidenceIds.push(...trail, event.eventId);
                }
                stage = 'planted';
                trail = [event.eventId];
            } else if (event.type === 'crop.mature' && stage === 'planted') {
                stage = 'mature';
                trail.push(event.eventId);
            } else if (event.type === 'crop.harvest') {
                // An immature or unattributed harvest breaks the chain instead of counting as progress.
                if (
                    stage === 'mature' &&
                    byTeam(event) &&
                    event.payload.mature === true &&
                    pickups.has(event.eventId)
                ) {
                    stage = 'harvested';
                    trail.push(event.eventId);
                } else {
                    stage = 'none';
                    trail = [];
                }
            }
        }
    }
    const cycles = component('crops.cycles', V, 10, cycleIds.length >= rules.minVerifiedCycles ? 'pass' : 'fail', {
        evidenceIds,
        reasons: [`${cycleIds.length} of ${rules.minVerifiedCycles} verified plant-grow-harvest-replant cycles`],
    });
    return [cells, cycles];
}

function finalWindowSamples(evidence, durationSeconds, windowSeconds) {
    const bySecond = new Map();
    for (const e of evidence.window) if (e.type === 'world.sample') bySecond.set(e.payload.second, e);
    const samples = [];
    const missing = [];
    for (let second = durationSeconds - windowSeconds; second < durationSeconds; second++) {
        const sample = bySecond.get(second);
        if (sample) samples.push(sample);
        else missing.push(second);
    }
    return { samples, missing };
}

// Reads the team's current holdings only, each container position once, so moving items around cannot change the total.
// `complete` is false when a member or stack could not be read. That data could only add to the total, so a short total
// is then unknown, while a sufficient one still stands. M2 telemetry must report every registered chest, because an
// absent chest counts as empty here.
export function readReserve(state, chestKeys, nutrition, participants) {
    let units = 0;
    let complete = true;
    const add = items => {
        if (!Array.isArray(items)) {
            complete = false;
            return;
        }
        for (const stack of items) {
            if (!Object.hasOwn(nutrition, stack.item)) continue;
            if (Number.isInteger(stack.count) && stack.count >= 0) units += nutrition[stack.item] * stack.count;
            else complete = false;
        }
    };
    const players = playersOf(state) ?? new Map();
    for (const actor of participants) {
        const player = players.get(actor);
        if (!player) complete = false;
        else if (player.alive !== false) add(player.inventory);
    }
    const seen = new Set();
    for (const container of state.containers ?? []) {
        const at = key(container.pos);
        if (!chestKeys.has(at) || seen.has(at)) continue;
        seen.add(at);
        add(container.items);
    }
    return { units, complete };
}

function scoreFood(evidence, scenario) {
    const id = 'food.reserve';
    const rules = scenario.foodReserve;
    if (!evidence.terminal) return unsupported(id, V, 10, 'No terminal snapshot');
    if (evidence.gaps.length) return unsupported(id, V, 10, 'Sequence gaps in server evidence');
    const { samples, missing } = finalWindowSamples(evidence, scenario.durationSeconds, rules.windowSeconds);
    if (missing.length) return unsupported(id, V, 10, `${missing.length} samples missing from the final window`);
    const chests = new Set(
        evidence.window
            .filter(
                e =>
                    e.type === 'region.registered' &&
                    e.payload.kind === 'chest' &&
                    evidence.participants.has(e.actorId),
            )
            .map(e => key(e.payload.pos)),
    );
    const read = state => readReserve(state, chests, rules.nutrition, evidence.participants);
    const short = samples
        .map(s => ({ second: s.payload.second, ...read(s.payload) }))
        .filter(s => s.units < rules.minUnitsAtEverySample);
    const cutoff = read(evidence.terminal.payload);
    const cutoffShort = cutoff.units < rules.minUnitsAtCutoff;
    const low = short.find(s => s.complete);
    const reasons = [];
    if (low) reasons.push(`Reserve fell below ${rules.minUnitsAtEverySample} at second ${low.second}`);
    if (cutoffShort && cutoff.complete)
        reasons.push(`Reserve ${cutoff.units} at cutoff is below ${rules.minUnitsAtCutoff}`);
    if (!reasons.length && (short.length || cutoffShort))
        return unsupported(id, V, 10, 'Food data is incomplete, and the known total is below the limit');
    return component(id, V, 10, reasons.length ? 'fail' : 'pass', {
        evidenceIds: [evidence.terminal.eventId],
        reasons,
    });
}

function scoreTeam(evidence, scenario) {
    const id = 'team.functioning';
    const rules = scenario.functioningTeam;
    if (!evidence.terminal) return unsupported(id, V, 10, 'No terminal snapshot');
    if (evidence.gaps.length) return unsupported(id, V, 10, 'Sequence gaps in server evidence');
    const { samples, missing } = finalWindowSamples(evidence, scenario.durationSeconds, rules.windowSeconds);
    // Telemetry loss is not evidence of survival.
    if (missing.length) return unsupported(id, V, 10, `${missing.length} samples missing from the final window`);
    const windowStartMs = (scenario.durationSeconds - rules.windowSeconds) * 1000;
    const reasons = [];
    const unknown = [];
    const deaths = evidence.window.filter(
        e => e.type === 'player.death' && e.elapsedMs >= windowStartMs && evidence.participants.has(e.actorId),
    );
    if (deaths.length) reasons.push(`${deaths.length} deaths in the final window`);
    // A player absent from a state's list is offline. A listed player with a missing field is simply unknown.
    const check = (state, where, limits) => {
        const players = playersOf(state);
        if (!players) {
            unknown.push(`No player data ${where}`);
            return;
        }
        for (const actor of evidence.participants) {
            const player = players.get(actor);
            if (!player || player.connected === false) {
                reasons.push(`${actor} not connected ${where}`);
                continue;
            }
            if (player.connected !== true) unknown.push(`No connection data for ${actor} ${where}`);
            for (const [field, min] of Object.entries(limits)) {
                if (typeof player[field] !== 'number') unknown.push(`No ${field} data for ${actor} ${where}`);
                else if (player[field] < min) reasons.push(`${actor} ${field} ${player[field]} ${where}`);
            }
        }
    };
    for (const sample of samples) {
        check(sample.payload, `at second ${sample.payload.second}`, { food: rules.minFoodAtEverySample });
        if (reasons.length) break;
    }
    check(evidence.terminal.payload, 'at cutoff', { food: rules.minFoodAtCutoff, health: rules.minHealthAtCutoff });
    if (!reasons.length && unknown.length) return unsupported(id, V, 10, unknown.slice(0, 10).join('; '));
    return component(id, V, 10, reasons.length ? 'fail' : 'pass', {
        evidenceIds: [evidence.terminal.eventId, ...deaths.map(e => e.eventId)],
        reasons: reasons.slice(0, 10),
    });
}

export function scoreSettlement({ evidence, scenario }) {
    return [
        ...scoreShelter(evidence, scenario),
        scoreTools(evidence, scenario),
        scoreInfrastructure(evidence, scenario),
        ...scoreCrops(evidence, scenario),
        scoreFood(evidence, scenario),
        scoreTeam(evidence, scenario),
    ];
}
