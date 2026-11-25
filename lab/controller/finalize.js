import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readEvents } from '../events/log.js';
import { classifyFailures, renderReport } from '../evaluator/report.js';
import { scoreRun } from '../evaluator/score.js';
import { redact, REPO_ROOT, sha256, sha256File, writeDurable } from '../lib/util.js';

export const ARTIFACTS = [
    'resolved-config.json',
    'events.jsonl',
    'score.json',
    'usage.json',
    'report.md',
    'cleanup.json',
    'manifest.json',
];

const contentHash = file => {
    try {
        return sha256File(file);
    } catch {
        return 'unreadable';
    }
};

export function codeIdentity(cwd = REPO_ROOT) {
    const git = (...args) =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 256 * 1024 * 1024,
        });
    try {
        const head = git('rev-parse', 'HEAD').trim();
        const status = git('status', '--porcelain');
        const diff = git('diff', 'HEAD');
        // `git diff` leaves out untracked files, and status can collapse them to a directory name, so hash their contents.
        const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
            .split('\0')
            .filter(Boolean)
            .sort()
            .map(name => `${name}\0${contentHash(path.join(cwd, name))}`)
            .join('\n');
        return {
            head,
            branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
            dirty: status.length > 0,
            diffSha256: status.length ? sha256(`${diff}${status}${untracked}`) : null,
        };
    } catch {
        return { head: null, branch: null, dirty: null, diffSha256: null, note: 'git identity unavailable' };
    }
}

export const isUpstreamAncestor = (sha, cwd = REPO_ROOT) => {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

export const pidAlive = pid => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

// Execution status is separate from benchmark success: a run can complete validly and still score zero.
export function concludeRun({ reason, score, malformedEvents = 0 }) {
    if (reason === 'integrity_breach')
        return { state: 'INVALID', validity: { valid: false, reason: 'identity or permission breach' } };
    if (reason === 'deadline' || reason === 'budget_exhausted') {
        if (!score?.integrity.terminalSnapshot)
            return { state: 'INVALID', validity: { valid: false, reason: 'missing terminal snapshot' } };
        if (score.integrity.sequenceGaps.length || malformedEvents)
            return { state: 'INVALID', validity: { valid: false, reason: 'critical evidence loss' } };
        return { state: 'COMPLETED', validity: { valid: true, reason: null } };
    }
    return { state: 'ABORTED', validity: { valid: false, reason } };
}

// Shared by the normal path and by recovery after a controller died, so both leave the same set of artefacts.
export function finalizeRun({
    runId,
    runDir,
    snapshot,
    reason,
    ledger,
    store,
    stopTiming = null,
    participants,
    mode,
    extra = {},
}) {
    mkdirSync(runDir, { recursive: true });
    const { events, malformed } = readEvents(path.join(runDir, 'events.jsonl'));
    const started = events.some(e => e.type === 'world.clock_start');
    let score = null;
    if (started && snapshot?.scenario)
        score = scoreRun({
            scenario: snapshot.scenario,
            events,
            participants,
            evidenceClass: extra.evidenceClass ?? 'mock',
        });
    if (score) writeDurable(path.join(runDir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
    const { state, validity } = concludeRun({ reason, score, malformedEvents: malformed });
    ledger.retainOpen(runId);
    ledger.closeRun(runId);
    const totals = ledger.runTotals(runId);
    const spending = {
        ...totals,
        providerRequests: mode === 'mock' ? 0 : totals.requests,
        mockRequests: mode === 'mock' ? totals.requests : 0,
        currency: 'USD',
        note: 'Settled figures come from provider-reported usage. Unsettled exposure may or may not have been billed. This is not an invoice.',
    };
    writeDurable(path.join(runDir, 'usage.json'), `${JSON.stringify(spending, null, 2)}\n`);
    const workers = store.workers(runId);
    const stillAlive = workers.filter(w => w.pid !== process.pid && pidAlive(w.pid)).map(w => w.actor_id);
    const cleanup = {
        workersGone: stillAlive.length === 0,
        stillAlive,
        checkedAt: new Date().toISOString(),
        stopTiming,
    };
    writeDurable(path.join(runDir, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`);
    const failures = classifyFailures(events);
    const report = renderReport({
        runId,
        state,
        terminationReason: reason,
        validity,
        mode,
        scenarioId: snapshot?.config?.scenario ?? 'unknown',
        score,
        spending,
        failures,
        events,
        cleanup,
        stopTiming,
    });
    writeDurable(path.join(runDir, 'report.md'), report);
    const manifest = redact({
        schemaVersion: 1,
        runId,
        execution: state,
        terminationReason: reason,
        validity,
        evidenceClass: score?.evidenceClass ?? null,
        benchmark: score
            ? { primaryCompletion: score.primaryCompletion, points: score.points, maxPoints: score.maxPoints }
            : null,
        code: extra.code ?? null,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        scenario: snapshot?.scenario
            ? { id: snapshot.scenario.id, hash: snapshot.scenario.hash, frozen: snapshot.scenario.frozen ?? null }
            : null,
        configHash: snapshot?.configHash ?? null,
        model: snapshot?.config?.model ?? null,
        limits: snapshot?.config?.limits ?? null,
        policy: snapshot?.config?.policy ?? null,
        fixture: {
            id: snapshot?.config?.runtime?.fixtureId ?? null,
            sha256: snapshot?.config?.runtime?.fixtureSha256 ?? null,
        },
        worldSnapshots: { initial: null, final: null, note: 'The mock world has no world files' },
        assignmentSeed: snapshot?.config?.assignmentSeed ?? null,
        participants: extra.assignment ?? participants ?? [],
        approvals: [],
        pricing: extra.pricing ?? null,
        interventions: [],
        timing: { transitions: store.transitions(runId).map(t => ({ to: t.to_state, at: t.at })) },
        spending,
        provenance: extra.provenance ?? 'lab controller',
        malformedEventLines: malformed,
    });
    manifest.artifactCompleteness = Object.fromEntries(
        ARTIFACTS.filter(name => name !== 'manifest.json').map(name => [name, existsSync(path.join(runDir, name))]),
    );
    writeDurable(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const hashes = {};
    for (const name of ARTIFACTS) {
        const file = path.join(runDir, name);
        if (existsSync(file) && statSync(file).isFile()) hashes[name] = sha256File(file);
    }
    writeDurable(
        path.join(runDir, 'integrity.json'),
        `${JSON.stringify({ algorithm: 'sha256', files: hashes, note: 'Detects accidental change only; it does not prove honesty against a compromised host.' }, null, 2)}\n`,
    );
    return { state, reason, validity, score, spending, cleanup, reportPath: path.join(runDir, 'report.md') };
}

export function verifyIntegrity(runDir) {
    const file = path.join(runDir, 'integrity.json');
    if (!existsSync(file)) return { ok: false, problems: ['integrity.json is missing'] };
    const { files } = JSON.parse(readFileSync(file, 'utf8'));
    const problems = [];
    for (const [name, hash] of Object.entries(files)) {
        const target = path.join(runDir, name);
        if (!existsSync(target)) problems.push(`${name} is missing`);
        else if (sha256File(target) !== hash) problems.push(`${name} changed after finalization`);
    }
    return { ok: problems.length === 0, problems };
}
