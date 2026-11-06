import { sequenceGaps } from '../events/log.js';

// Only this source and quality can move a score. Agent claims, operational logs and, for a real run, mock events are
// all excluded here, before any predicate sees them.
const ACCEPTED = {
    authoritative: { source: 'paper', quality: 'authoritative' },
    mock: { source: 'mock-server', quality: 'mock' },
};

export function prepareEvidence(events, { evidenceClass, participants }) {
    const accepted = ACCEPTED[evidenceClass];
    if (!accepted) throw new Error(`Unknown evidence class ${evidenceClass}`);
    const ordered = [...events].sort((a, b) => a.collectorSeq - b.collectorSeq);
    const trusted = ordered.filter(e => e.source === accepted.source && e.evidenceQuality === accepted.quality);
    const terminal = trusted.find(e => e.type === 'terminal.snapshot') ?? null;
    const cutoff = terminal ? terminal.collectorSeq : Infinity;
    return {
        evidenceClass,
        participants: new Set(participants),
        terminal,
        window: trusted.filter(e => e.collectorSeq <= cutoff),
        lateEvents: trusted.filter(e => e.collectorSeq > cutoff).length,
        ignored: ordered.length - trusted.length,
        gaps: sequenceGaps(trusted),
    };
}

export function component(id, predicateVersion, maxPoints, outcome, { points, evidenceIds = [], reasons = [] } = {}) {
    return {
        id,
        predicateVersion,
        outcome,
        points: outcome === 'unsupported' ? 0 : (points ?? (outcome === 'pass' ? maxPoints : 0)),
        maxPoints,
        evidenceIds: [...new Set(evidenceIds)],
        reasons,
    };
}

export const unsupported = (id, version, maxPoints, reason) =>
    component(id, version, maxPoints, 'unsupported', { reasons: [reason] });

export function assembleScore({ scenario, evidence, components }) {
    return {
        schemaVersion: '1',
        scenario: scenario.id,
        evidenceClass: evidence.evidenceClass,
        primaryCompletion: components.length > 0 && components.every(c => c.outcome === 'pass'),
        points: components.reduce((sum, c) => sum + c.points, 0),
        maxPoints: components.reduce((sum, c) => sum + c.maxPoints, 0),
        evaluatedAtTick: evidence.terminal?.tick ?? null,
        integrity: {
            terminalSnapshot: Boolean(evidence.terminal),
            sequenceGaps: evidence.gaps,
            ignoredNonAuthoritativeEvents: evidence.ignored,
            lateEvents: evidence.lateEvents,
        },
        components,
    };
}
