import { microsToUsd } from '../lib/util.js';

const TIMELINE_LIMIT = 60;

const TIMELINE_TYPES = new Set([
    'run.state',
    'world.clock_start',
    'player.join',
    'player.quit',
    'craft.result',
    'block.change',
    'item.transfer',
    'food.consume',
    'terminal.snapshot',
    'action.finished',
    'action.refused',
    'security.rejected',
    'agent.claim',
    'broker.rejected',
    'broker.ambiguous',
    'worker.exit',
    'worker.report',
]);

// Failure classes from the protocol. `undetermined` is used wherever the evidence cannot separate model from tool.
export function classifyFailures(events) {
    const counts = new Map();
    const bump = (cls, code, eventId) => {
        const k = `${cls}:${code}`;
        const row = counts.get(k) ?? { class: cls, code, count: 0, evidenceIds: [] };
        row.count++;
        if (row.evidenceIds.length < 5) row.evidenceIds.push(eventId);
        counts.set(k, row);
    };
    for (const e of events) {
        if (e.type === 'broker.rejected') {
            const provider = ['provider_failed', 'model_mismatch'].includes(e.payload.code);
            bump(provider ? 'provider' : 'infrastructure', e.payload.code, e.eventId);
        } else if (e.type === 'broker.ambiguous') bump('provider', e.payload.reason, e.eventId);
        else if (e.type === 'action.finished' && ['failed', 'partial'].includes(e.payload.status))
            bump('undetermined', e.payload.failureCode ?? 'unknown', e.eventId);
        else if (e.type === 'action.refused') bump('undetermined', e.payload.failureCode, e.eventId);
        else if (e.type === 'security.rejected') bump('undetermined', e.payload.kind, e.eventId);
        else if (e.type === 'worker.exit' && e.payload.unexpected) bump('infrastructure', 'worker_exit', e.eventId);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function biggestBlocker({ state, terminationReason, score, failures }) {
    if (state === 'ABORTED') return `Run aborted: ${terminationReason}`;
    if (state === 'INVALID') return `Run invalid: ${terminationReason}`;
    const unsupported = score?.components.find(c => c.outcome === 'unsupported');
    if (unsupported) return `${unsupported.id} is unsupported: ${unsupported.reasons[0]}`;
    const failed = score?.components.find(c => c.outcome === 'fail');
    if (failed) return `${failed.id} failed: ${failed.reasons[0] ?? 'see evidence'}`;
    if (failures.length) return `Most frequent failure: ${failures[0].code} (${failures[0].count})`;
    return 'None recorded';
}

const line = e => {
    const who = e.actorId ? ` ${e.actorId}` : '';
    const summary = JSON.stringify(e.payload);
    return `- \`${(e.elapsedMs / 1000).toFixed(2)}s\` [${e.evidenceQuality}] **${e.type}**${who} ${summary.length > 160 ? `${summary.slice(0, 157)}...` : summary} (\`${e.eventId}\`)`;
};

export function timelineLines(events, limit = TIMELINE_LIMIT) {
    return events
        .filter(e => TIMELINE_TYPES.has(e.type))
        .sort((a, b) => a.collectorSeq - b.collectorSeq)
        .slice(0, limit)
        .map(line);
}

// Results first: outcome, validity, spending and the biggest blocker, then the supporting evidence.
export function renderReport({
    runId,
    state,
    terminationReason,
    validity,
    mode,
    scenarioId,
    score,
    spending,
    failures,
    events,
    cleanup,
    stopTiming,
}) {
    const out = [];
    const mock = score?.evidenceClass === 'mock' || mode === 'mock';
    out.push(`# Run report: ${runId}`, '');
    if (mock)
        out.push(
            '> **MOCK RUN.** A simulated world and a scripted provider, with no Minecraft server and no model. This validates the lab pipeline only. It is not evidence about Minecraft gameplay or any model.',
            '',
        );
    out.push(`- **Execution:** ${state} (${terminationReason})`);
    out.push(`- **Validity:** ${validity.valid ? 'valid' : `INVALID: ${validity.reason}`}`);
    out.push(`- **Scenario:** ${scenarioId}`);
    if (score)
        out.push(
            `- **Benchmark result:** ${score.primaryCompletion ? 'all components passed' : 'not completed'}, ${score.points}/${score.maxPoints} points (${score.evidenceClass} evidence)`,
        );
    else out.push('- **Benchmark result:** unsupported, no score was produced');
    out.push(
        `- **Spending:** settled $${microsToUsd(spending.settledMicros)}, unsettled exposure $${microsToUsd(spending.unsettledExposureMicros)}, provider requests ${spending.providerRequests}, mock requests ${spending.mockRequests}`,
    );
    out.push(`- **Biggest blocker:** ${biggestBlocker({ state, terminationReason, score, failures })}`, '');
    if (score) {
        out.push(
            '## Score components',
            '',
            '| Component | Outcome | Points | Why | Evidence |',
            '| --- | --- | ---: | --- | --- |',
        );
        for (const c of score.components)
            out.push(
                `| ${c.id} | ${c.outcome} | ${c.points}/${c.maxPoints} | ${c.reasons.join('; ').replaceAll('|', '/') || ''} | ${c.evidenceIds.slice(0, 3).join(', ')} |`,
            );
        out.push(
            '',
            `Integrity: terminal snapshot ${score.integrity.terminalSnapshot ? 'present' : 'MISSING'}; sequence gaps ${score.integrity.sequenceGaps.length}; ignored non-evidence events ${score.integrity.ignoredNonAuthoritativeEvents}; late events ${score.integrity.lateEvents}.`,
            '',
        );
    }
    out.push('## Failures', '');
    if (failures.length) {
        out.push('| Class | Code | Count | Example evidence |', '| --- | --- | ---: | --- |');
        for (const f of failures) out.push(`| ${f.class} | ${f.code} | ${f.count} | ${f.evidenceIds[0]} |`);
    } else out.push('None recorded.');
    out.push('', '## Stop and cleanup', '');
    out.push(
        `- Stop requested to workers gone: ${stopTiming?.workerTerminationMs ?? 'not measured'} ms; forced kills: ${stopTiming?.forcedKills ?? 'not measured'}`,
    );
    out.push(`- Workers verified gone: ${cleanup?.workersGone ?? 'not verified'}`, '');
    out.push('## Timeline', '', ...timelineLines(events), '');
    return out.join('\n');
}
