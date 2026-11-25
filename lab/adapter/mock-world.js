import { delay } from '../lib/util.js';

// A small simulator standing in for Paper and the telemetry plugin during offline runs. It is not Minecraft: passing
// here validates the controller, evidence and scoring pipeline only. Every event it emits has evidenceQuality "mock",
// which the scorer refuses to count as authoritative game evidence.
export const MOCK_SOURCE = 'mock-server';
const TICK_MS = 50;
const RECIPES = {
    oak_planks: { yields: 4, needs: { oak_log: 1 } },
    crafting_table: { yields: 1, needs: { oak_planks: 4 } },
    chest: { yields: 1, needs: { oak_planks: 8 }, station: 'table_placed' },
};
const GATHER = { oak_log: 'oak_log', sweet_berry_bush: 'sweet_berries' };
const FOOD = { sweet_berries: 2 };
const COMPLETES = { crafting_table: 'table_placed', chest: 'chest_placed' };

export function createMockWorld({ runId, participants, log, actionMs = 20, faults = {} }) {
    const agents = new Map(
        participants.map((actorId, index) => [
            actorId,
            {
                actorId,
                index,
                uuid: `mock-uuid-${actorId}`,
                inventory: {},
                completed: new Set(),
                logsCollected: 0,
                food: 20,
                health: 20,
                observationSeq: 0,
                connected: false,
                recentFailures: [],
            },
        ]),
    );
    const blocks = new Map();
    const chests = new Map();
    let gatherNoPickup = faults.gatherNoPickup ?? 0;
    let lateEventsAfterCutoff = false;

    const tick = () => Math.floor(log.elapsedMs() / TICK_MS);
    const emit = (type, actorId, payload, correlationId = null) =>
        log.emit({ source: MOCK_SOURCE, type, actorId, payload, correlationId, tick: tick(), evidenceQuality: 'mock' });
    const adjust = (agent, item, n) => {
        agent.inventory[item] = (agent.inventory[item] ?? 0) + n;
        if (agent.inventory[item] <= 0) delete agent.inventory[item];
    };

    const failure = (code, retryable, recovery) => ({
        status: 'failed',
        failureCode: code,
        retryable,
        suggestedRecovery: recovery,
    });

    const handlers = {
        async gather(agent, { block, count = 1 }, signal, actionId) {
            const item = GATHER[block];
            if (!item) return failure('target_not_visible', false, 'Inspect the area and choose a block you can see.');
            const before = agent.inventory[item] ?? 0;
            const evidence = [];
            for (let n = 0; n < count; n++) {
                await delay(actionMs, signal);
                if (signal.aborted) break;
                evidence.push(emit('block.break', agent.actorId, { block }, actionId).eventId);
                if (gatherNoPickup > 0) {
                    gatherNoPickup--;
                    continue;
                }
                adjust(agent, item, 1);
                if (item === 'oak_log') agent.logsCollected++;
                evidence.push(emit('item.pickup', agent.actorId, { item, count: 1 }, actionId).eventId);
            }
            const gained = (agent.inventory[item] ?? 0) - before;
            const delta = { inventory: { [item]: gained } };
            if (signal.aborted)
                return { status: 'cancelled', retryable: true, observedDelta: delta, evidenceIds: evidence };
            if (gained >= count)
                return { status: 'succeeded', retryable: false, observedDelta: delta, evidenceIds: evidence };
            return {
                status: 'partial',
                failureCode: 'broken_not_collected',
                retryable: true,
                suggestedRecovery: 'Reobserve: some blocks broke without the drop reaching your inventory.',
                observedDelta: delta,
                evidenceIds: evidence,
            };
        },
        async craft(agent, { item, count = 1 }, signal, actionId) {
            const recipe = RECIPES[item];
            if (!recipe) return failure('no_recipe', false, 'Choose a known recipe.');
            if (recipe.station && !agent.completed.has(recipe.station))
                return failure('missing_station', true, 'Place a crafting table first.');
            const batches = Math.ceil(count / recipe.yields);
            for (const [need, n] of Object.entries(recipe.needs))
                if ((agent.inventory[need] ?? 0) < n * batches)
                    return failure('missing_item', true, `Collect more ${need}.`);
            await delay(actionMs, signal);
            if (signal.aborted) return { status: 'cancelled', retryable: true };
            for (const [need, n] of Object.entries(recipe.needs)) adjust(agent, need, -n * batches);
            adjust(agent, item, recipe.yields * batches);
            const made = emit('craft.result', agent.actorId, { item, count: recipe.yields * batches }, actionId);
            return {
                status: 'succeeded',
                retryable: false,
                observedDelta: { inventory: { [item]: recipe.yields * batches } },
                evidenceIds: [made.eventId],
            };
        },
        async place(agent, { block, slot = block }, signal, actionId) {
            if (!agent.inventory[block]) return failure('missing_item', true, `You have no ${block}.`);
            await delay(actionMs, signal);
            if (signal.aborted) return { status: 'cancelled', retryable: true };
            const position = `${agent.index}:${slot}`;
            if (blocks.has(position)) return failure('target_changed', true, 'That cell is occupied; reobserve.');
            adjust(agent, block, -1);
            blocks.set(position, { block, by: agent.actorId });
            if (block === 'chest') chests.set(agent.actorId, {});
            if (COMPLETES[block]) agent.completed.add(COMPLETES[block]);
            const placed = emit(
                'block.change',
                agent.actorId,
                { position, to: block, cause: 'player_place' },
                actionId,
            );
            return {
                status: 'succeeded',
                retryable: false,
                observedDelta: { blocks: { [position]: block } },
                evidenceIds: [placed.eventId],
            };
        },
        async deposit(agent, { item, count = 1 }, signal, actionId) {
            const chest = chests.get(agent.actorId);
            if (!chest) return failure('no_container', true, 'Place a chest first.');
            if ((agent.inventory[item] ?? 0) < count)
                return failure('missing_item', true, `You do not hold ${count} ${item}.`);
            await delay(actionMs, signal);
            if (signal.aborted) return { status: 'cancelled', retryable: true };
            adjust(agent, item, -count);
            chest[item] = (chest[item] ?? 0) + count;
            agent.completed.add('deposited');
            const moved = emit('item.transfer', agent.actorId, { item, count, to: `chest:${agent.actorId}` }, actionId);
            return {
                status: 'succeeded',
                retryable: false,
                observedDelta: { inventory: { [item]: -count } },
                evidenceIds: [moved.eventId],
            };
        },
        async eat(agent, { item }, signal, actionId) {
            if (!FOOD[item]) return failure('not_food', false, 'Choose something edible.');
            if (!agent.inventory[item]) return failure('missing_item', true, `You have no ${item}.`);
            await delay(actionMs, signal);
            if (signal.aborted) return { status: 'cancelled', retryable: true };
            adjust(agent, item, -1);
            agent.food = Math.min(20, agent.food + FOOD[item]);
            agent.completed.add('ate');
            const eaten = emit('food.consume', agent.actorId, { item, food: agent.food }, actionId);
            return {
                status: 'succeeded',
                retryable: false,
                observedDelta: { food: agent.food },
                evidenceIds: [eaten.eventId],
            };
        },
        // Test fixture for cancellation: a long action that only ends when its signal fires.
        async mock_hang(agent, args, signal) {
            agent.moving = true;
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            agent.moving = false;
            return { status: 'cancelled', retryable: true };
        },
    };

    return {
        evidenceClass: 'mock',
        join(actorId) {
            const agent = agents.get(actorId);
            agent.connected = true;
            emit('player.join', actorId, { uuid: agent.uuid });
        },
        startClock() {
            log.resetOrigin();
            emit('world.clock_start', null, { participants, tickMs: TICK_MS, simulated: true });
        },
        tick,
        observe(actorId) {
            const agent = agents.get(actorId);
            agent.observationSeq++;
            return {
                agentId: actorId,
                tick: tick(),
                observationSeq: agent.observationSeq,
                controllerElapsedMs: log.elapsedMs(),
                health: agent.health,
                food: agent.food,
                inventory: { ...agent.inventory },
                completed: [...agent.completed].sort(),
                logsCollected: agent.logsCollected,
                recentFailures: agent.recentFailures.slice(-5),
            };
        },
        observationSeq: actorId => agents.get(actorId).observationSeq,
        hasTool: tool => Object.hasOwn(handlers, tool),
        isMoving: actorId => Boolean(agents.get(actorId).moving),
        async execute(actorId, tool, args, signal, actionId) {
            const agent = agents.get(actorId);
            const startedTick = tick();
            const outcome = await handlers[tool](agent, args, signal, actionId);
            if (outcome.status === 'failed' || outcome.status === 'partial')
                agent.recentFailures.push({ tool, code: outcome.failureCode });
            return { observedDelta: {}, evidenceIds: [], ...outcome, startedTick, finishedTick: tick() };
        },
        // Taken while the team is still connected: teardown must not make the final state look like an absent team.
        captureTerminal() {
            lateEventsAfterCutoff = true;
            return emit('terminal.snapshot', null, {
                players: [...agents.values()].map(a => ({
                    actorId: a.actorId,
                    uuid: a.uuid,
                    connected: a.connected,
                    health: a.health,
                    food: a.food,
                    inventory: { ...a.inventory },
                })),
                blocks: Object.fromEntries(blocks),
                containers: Object.fromEntries(chests),
            });
        },
        disconnectAll() {
            for (const agent of agents.values()) {
                if (!agent.connected) continue;
                agent.connected = false;
                emit('player.quit', agent.actorId, { afterCutoff: lateEventsAfterCutoff });
            }
        },
    };
}
