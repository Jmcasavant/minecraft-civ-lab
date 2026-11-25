import { component, unsupported } from './evidence.js';

const VERSION = 'tool-qualification/1';
const CHECKS = [
    { id: 'collect', type: 'item.pickup', test: p => p.item === 'oak_log' },
    { id: 'craft', type: 'craft.result', test: p => p.item === 'crafting_table' },
    { id: 'place', type: 'block.change', test: p => p.to === 'crafting_table' && p.cause === 'player_place' },
    { id: 'transfer', type: 'item.transfer', test: p => p.count > 0 },
    { id: 'eat', type: 'food.consume', test: () => true },
];

// One component per skill, passing only when every participant shows server-side evidence of it.
export function scoreToolQualification({ evidence }) {
    return CHECKS.map(check => {
        if (!evidence.terminal) return unsupported(check.id, VERSION, 20, 'No terminal snapshot');
        if (evidence.gaps.length) return unsupported(check.id, VERSION, 20, 'Sequence gaps in server evidence');
        const evidenceIds = [];
        const missing = [];
        for (const actor of evidence.participants) {
            const hit = evidence.window.find(
                e => e.type === check.type && e.actorId === actor && check.test(e.payload),
            );
            if (hit) evidenceIds.push(hit.eventId);
            else missing.push(actor);
        }
        return component(check.id, VERSION, 20, missing.length ? 'fail' : 'pass', {
            evidenceIds,
            reasons: missing.length ? [`No ${check.type} evidence for ${missing.join(', ')}`] : [],
        });
    });
}
