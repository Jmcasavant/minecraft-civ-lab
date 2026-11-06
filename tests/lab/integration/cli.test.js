import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { isSubscriptionLogin } from '../../../lab/broker/cli-provider.js';
import { ControlStore } from '../../../lab/controller/store.js';
import { codeIdentity, pidAlive } from '../../../lab/controller/finalize.js';
import { javaMajorVersion } from '../../../lab/lib/util.js';
import { mockConfig, REPO, tempDir } from '../fixtures/helpers.js';

const CLI = path.join(REPO, 'lab', 'cli', 'lab.js');
const baseEnv = () =>
    Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('LAB_') && !k.startsWith('NODE_TEST')),
    );
const lab = (args, env = {}) => {
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
        encoding: 'utf8',
        env: { ...baseEnv(), ...env },
        timeout: 90000,
    });
    return { code: done.status, out: done.stdout, err: done.stderr };
};
function configFile(t, overrides = {}) {
    const dir = tempDir(t);
    const file = path.join(dir, 'config.yaml');
    writeFileSync(file, stringify(mockConfig(overrides)));
    return { file, runsDir: path.join(dir, 'runs') };
}
const startRun = (config, runsDir) =>
    spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', CLI, 'run', '--config', config, '--runs-dir', runsDir],
        { env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
async function untilRunning(runsDir) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            const store = new ControlStore(path.join(runsDir, 'control.sqlite'));
            const run = store.listRuns().at(-1);
            const workers = run ? store.workers(run.run_id) : [];
            store.close();
            if (run?.state === 'RUNNING') return { runId: run.run_id, workers };
        } catch {}
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('Run did not reach RUNNING');
}
const exitOf = child => new Promise(resolve => child.once('close', resolve));
const stateOf = (runsDir, runId) => {
    const store = new ControlStore(path.join(runsDir, 'control.sqlite'));
    const row = store.run(runId);
    store.close();
    return row;
};
const runIdIn = text => /Run (run-\S+)/.exec(text)[1];

test('doctor reports state without printing secrets, and makes no model request', () => {
    const done = lab(['doctor', '--json'], { OPENAI_API_KEY: 'sk-doctorcheck123456', AGENT_SANDBOX: 'local' });
    assert.equal(done.code, 0, done.err);
    const report = JSON.parse(done.out);
    assert.equal(report.credentials.OPENAI_API_KEY, 'present');
    assert.equal(report.paidRequestsMade, 0);
    assert.doesNotMatch(done.out, /sk-doctorcheck123456/);
    assert.ok(report.upstreamEnvironmentNotForwarded.includes('AGENT_SANDBOX'));
    assert.ok(report.liveBlockers.some(b => /EULA/.test(b)));
    assert.ok(report.modelLogins['claude-cli']);
    assert.ok(report.modelLogins['codex-cli']);
});

test('java version parsing ignores numbers in the release date', () => {
    assert.equal(javaMajorVersion('java version "25.0.1" 2025-10-21 LTS'), 25);
    assert.equal(javaMajorVersion('openjdk version "21" 2023-09-19'), 21);
    assert.equal(javaMajorVersion('openjdk version "21.0.4" 2024-07-16'), 21);
    assert.equal(javaMajorVersion('java version "1.8.0_202"'), 8);
    assert.equal(javaMajorVersion(null), null);
});

// A stand-in `codex` on PATH that reports a chosen login and records whether a model request was attempted.
function fakeCodex(t, statusLine, events = []) {
    const dir = tempDir(t);
    const marker = path.join(dir, 'request-attempted');
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(path.dirname(script), { recursive: true });
    const stream = events.map(event => `${JSON.stringify(event)}\n`).join('');
    writeFileSync(
        script,
        `if (process.argv[2] === 'exec') {
             require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');
             process.stdout.write(${JSON.stringify(stream)});
         } else console.error(${JSON.stringify(statusLine)});`,
    );
    if (process.platform === 'win32') writeFileSync(path.join(dir, 'codex.cmd'), '');
    else
        writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
            mode: 0o755,
        });
    return { dir, marker };
}
const codexCheck = (fake, runs) =>
    lab(['transport-check', '--provider', 'codex-cli', '--model', 'm', '--approve-one-request', '--runs-dir', runs], {
        PATH: fake.dir,
    });

test('transport-check refuses a persisted API-key login before any request', t => {
    const fake = fakeCodex(t, 'Logged in using an API key - sk-persisted12345');
    const done = codexCheck(fake, tempDir(t));
    assert.equal(done.code, 1, done.err);
    assert.match(done.err, /api-key, not a subscription login/);
    assert.doesNotMatch(done.out + done.err, /sk-persisted12345/);
    assert.equal(existsSync(fake.marker), false, 'no model request may start');
});

test('transport-check refuses a login method it does not recognise', t => {
    const fake = fakeCodex(t, 'Logged in using something new');
    const done = codexCheck(fake, tempDir(t));
    assert.equal(done.code, 1, done.err);
    assert.match(done.err, /not a subscription login/);
    assert.equal(existsSync(fake.marker), false);
});

test('transport-check lets a ChatGPT login through to its one request', t => {
    const fake = fakeCodex(t, 'Logged in using ChatGPT');
    codexCheck(fake, tempDir(t));
    assert.equal(existsSync(fake.marker), true);
});

test('transport-check does not present an echoed model as one the CLI confirmed', t => {
    const fake = fakeCodex(t, 'Logged in using ChatGPT', [
        {
            type: 'item.completed',
            item: {
                type: 'agent_message',
                text: JSON.stringify({ done: true, tool: null, argsJson: '{}', note: 'ok' }),
            },
        },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const done = codexCheck(fake, tempDir(t));
    assert.equal(done.code, 0, done.err);
    const report = JSON.parse(done.out);
    assert.equal(report.ok, true);
    assert.equal(report.requestedModel, 'm');
    assert.equal(report.returnedModel, null);
    assert.equal(report.modelVerified, false);
});

test('only recognised subscription logins qualify', () => {
    assert.equal(isSubscriptionLogin('claude-cli', { loggedIn: true, authMethod: 'claude.ai' }), true);
    assert.equal(isSubscriptionLogin('codex-cli', { loggedIn: true, authMethod: 'chatgpt' }), true);
    assert.equal(isSubscriptionLogin('codex-cli', { loggedIn: true, authMethod: 'api-key' }), false);
    assert.equal(isSubscriptionLogin('claude-cli', { loggedIn: true, authMethod: 'api_key' }), false);
    assert.equal(isSubscriptionLogin('claude-cli', { loggedIn: true, authMethod: null }), false);
    assert.equal(isSubscriptionLogin('codex-cli', { loggedIn: false, authMethod: 'chatgpt' }), false);
});

test('the code fingerprint changes when an untracked file changes', t => {
    const dir = tempDir(t);
    const git = (...args) =>
        spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir });
    git('init');
    writeFileSync(path.join(dir, 'tracked.txt'), 'a');
    git('add', '.');
    git('commit', '-m', 'first');
    mkdirSync(path.join(dir, 'lab'));
    writeFileSync(path.join(dir, 'lab', 'scorer.js'), 'one');
    const before = codeIdentity(dir);
    assert.equal(before.dirty, true);
    assert.ok(before.diffSha256);
    assert.equal(codeIdentity(dir).diffSha256, before.diffSha256, 'stable when nothing changed');
    writeFileSync(path.join(dir, 'lab', 'scorer.js'), 'two');
    assert.notEqual(codeIdentity(dir).diffSha256, before.diffSha256);
});

test('doctor rejects a bad flag', () => {
    assert.equal(lab(['doctor', '--nonsense']).code, 2);
});

test('auth reports status only, with no account details and no model request', () => {
    const done = lab(['auth']);
    assert.equal(done.code, 0, done.err);
    const status = JSON.parse(done.out);
    assert.equal(status.modelRequestsMade, 0);
    assert.doesNotMatch(done.out, /email|orgId|orgName/);
});

test('transport-check will not run without its approval flag', () => {
    const none = lab(['transport-check', '--provider', 'claude-cli', '--model', 'some-model']);
    assert.equal(none.code, 2);
    assert.match(none.err, /--approve-one-request/);
    assert.equal(
        lab(['transport-check', '--provider', 'anthropic-api', '--model', 'x', '--approve-one-request']).code,
        2,
    );
    assert.equal(lab(['transport-check', '--provider', 'claude-cli', '--approve-one-request']).code, 2);
});

test('validate: success and failure paths', t => {
    const { file } = configFile(t);
    const good = lab(['validate', '--config', file]);
    assert.equal(good.code, 0, good.err);
    assert.match(good.out, /Config is valid/);
    const { file: bad } = configFile(t, { policy: { sandbox: 'local' } });
    const refused = lab(['validate', '--config', bad]);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /policy.sandbox/);
    assert.equal(lab(['validate']).code, 2);
    assert.equal(lab(['validate', '--config', path.join(REPO, 'no-such.yaml')]).code, 2);
});

test('unknown commands are refused', () => {
    assert.equal(lab(['launch-the-rockets']).code, 2);
    assert.equal(lab([]).code, 2);
});

test('run, status, report and replay work end to end; each fails clearly on an unknown run', t => {
    const { file, runsDir } = configFile(t);
    const started = lab(['run', '--config', file, '--runs-dir', runsDir]);
    assert.equal(started.code, 0, started.err + started.out);
    assert.match(started.out, /finished: COMPLETED/);
    assert.match(started.out, /provider requests 0/);
    const runId = runIdIn(started.out);
    const status = lab(['status', '--run', runId, '--runs-dir', runsDir]);
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.out).state, 'COMPLETED');
    const report = lab(['report', '--run', runId, '--runs-dir', runsDir]);
    assert.equal(report.code, 0, report.err + report.out);
    assert.match(report.out, /MOCK RUN/);
    assert.match(report.out, /Artifact hashes: match/);
    assert.match(report.out, /Re-score from events: matches/);
    const replay = lab(['replay', '--run', runId, '--runs-dir', runsDir]);
    assert.equal(replay.code, 0);
    assert.match(replay.out, /not a deterministic replay/);
    const stop = lab(['stop', '--run', runId, '--runs-dir', runsDir]);
    assert.equal(stop.code, 0);
    assert.match(stop.out, /already ended/);
    for (const command of ['status', 'stop', 'report', 'replay']) {
        assert.equal(lab([command, '--run', 'run-nope', '--runs-dir', runsDir]).code, 1, command);
        assert.equal(lab([command, '--runs-dir', runsDir]).code, 2, command);
    }
    // Tampering with evidence after the fact is detected.
    const store = new ControlStore(path.join(runsDir, 'control.sqlite'));
    const dir = store.run(runId).run_dir;
    store.close();
    appendFileSync(
        path.join(dir, 'events.jsonl'),
        readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n')[0] + '\n',
    );
    const tampered = lab(['report', '--run', runId, '--runs-dir', runsDir]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.out, /MISMATCH/);
});

test('a preflight refusal exits non-zero and leaves an honest report', t => {
    const { file, runsDir } = configFile(t, { scenario: 'settlement-60-v0.1', agents: 4 });
    const done = lab(['run', '--config', file, '--runs-dir', runsDir]);
    assert.equal(done.code, 1);
    assert.match(done.out, /ABORTED \(preflight_failed\)/);
});

test('stop from another process ends a live run within the target, and it stays stopped', async t => {
    const { file, runsDir } = configFile(t, { runtime: { durationSeconds: 60 } });
    const child = startRun(file, runsDir);
    const exit = exitOf(child);
    const { runId, workers } = await untilRunning(runsDir);
    const started = Date.now();
    const stop = lab(['stop', '--run', runId, '--runs-dir', runsDir, '--timeout', '10']);
    assert.equal(stop.code, 0, stop.err + stop.out);
    await exit;
    assert.ok(Date.now() - started < 8000);
    assert.equal(stateOf(runsDir, runId).state, 'ABORTED');
    assert.ok(workers.length === 2 && workers.every(w => !pidAlive(w.pid)));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(stateOf(runsDir, runId).state, 'ABORTED', 'nothing resurrects it');
});

test('controller restart: killing the controller stops its workers, and the run is closed, never resumed', async t => {
    const { file, runsDir } = configFile(t, { runtime: { durationSeconds: 60 } });
    const child = startRun(file, runsDir);
    const exit = exitOf(child);
    const { runId, workers } = await untilRunning(runsDir);
    child.kill('SIGKILL');
    await exit;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && workers.some(w => pidAlive(w.pid))) await new Promise(r => setTimeout(r, 50));
    assert.ok(
        workers.every(w => !pidAlive(w.pid)),
        'workers exit when the controller channel closes',
    );
    const status = JSON.parse(lab(['status', '--run', runId, '--runs-dir', runsDir]).out);
    assert.equal(status.state, 'RUNNING');
    assert.equal(status.controllerAlive, false);
    assert.match(status.action, /lab:stop/);
    // A new controller recovers the old run first, and it ends rather than continuing.
    const { file: shortConfig } = configFile(t);
    const next = lab(['run', '--config', shortConfig, '--runs-dir', runsDir]);
    assert.equal(next.code, 0, next.err + next.out);
    const old = stateOf(runsDir, runId);
    assert.equal(old.state, 'ABORTED');
    assert.equal(old.termination_reason, 'controller_failure');
    const report = lab(['report', '--run', runId, '--runs-dir', runsDir]);
    assert.match(report.out, /controller_failure/);
    assert.match(report.out, /Benchmark result:\*\* not completed/);
});

test('stop closes a run whose controller is already gone', async t => {
    const { file, runsDir } = configFile(t, { runtime: { durationSeconds: 60 } });
    const child = startRun(file, runsDir);
    const exit = exitOf(child);
    const { runId } = await untilRunning(runsDir);
    child.kill('SIGKILL');
    await exit;
    const stop = lab(['stop', '--run', runId, '--runs-dir', runsDir]);
    assert.equal(stop.code, 0, stop.err);
    assert.match(stop.out, /Controller was gone/);
    assert.equal(stateOf(runsDir, runId).state, 'ABORTED');
});
