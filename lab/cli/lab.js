#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createBroker } from '../broker/broker.js';
import {
    CLI_PROVIDERS,
    createCliProvider,
    isSubscriptionLogin,
    resolveCli,
    subscriptionPricing,
} from '../broker/cli-provider.js';
import { loadLabConfig } from '../config/load.js';
import { codeIdentity, pidAlive, verifyIntegrity } from '../controller/finalize.js';
import { isTerminal, openStores, recoverInterrupted, runLab } from '../controller/controller.js';
import { timelineLines } from '../evaluator/report.js';
import { scoreRun } from '../evaluator/score.js';
import { readEvents, sequenceGaps } from '../events/log.js';
import { canonicalJson, delay, javaMajorVersion, microsToUsd, REPO_ROOT } from '../lib/util.js';

const CREDENTIAL_NAMES = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'E2B_API_KEY',
    'MODEL_API_KEY',
];
const UPSTREAM_ENV = /^(AGENT_|MC_|MODEL_BASE_URL$|MODEL_API_KEY$|E2B_)/;

const parse = argv =>
    parseArgs({
        args: argv,
        options: {
            config: { type: 'string' },
            run: { type: 'string' },
            'runs-dir': { type: 'string' },
            json: { type: 'boolean' },
            timeout: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            'approve-one-request': { type: 'boolean' },
        },
        allowPositionals: false,
        strict: true,
    }).values;

const runsDirOf = values =>
    path.resolve(values['runs-dir'] ?? process.env.LAB_RUNS_DIR ?? path.join(REPO_ROOT, 'runs'));
const say = text => process.stdout.write(`${text}\n`);
const fail = (message, code = 1) => {
    process.stderr.write(`lab: ${message}\n`);
    return code;
};

const toolVersion = (command, args) => {
    const done = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    if (done.error) return null;
    // `java -version` prints to stderr and exits 0.
    const output = done.stdout?.trim() || done.stderr?.trim();
    return output ? output.split('\n')[0].trim() : null;
};

const portFree = port =>
    new Promise(resolve => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });

async function doctor(values) {
    const mineflayer = readFileSync(path.join(REPO_ROOT, 'node_modules', 'mineflayer', 'package.json'), 'utf8');
    const disk = statfsSync(REPO_ROOT);
    const java = toolVersion('java', ['-version']);
    const docker = toolVersion('docker', ['--version']);
    const report = {
        node: process.version,
        java,
        docker,
        git: codeIdentity(),
        mineflayer: JSON.parse(mineflayer).version,
        credentials: Object.fromEntries(CREDENTIAL_NAMES.map(name => [name, process.env[name] ? 'present' : 'absent'])),
        upstreamEnvironmentNotForwarded: Object.keys(process.env).filter(name => UPSTREAM_ENV.test(name)),
        freeDiskGb: Number(((disk.bavail * disk.bsize) / 1024 ** 3).toFixed(1)),
        port25565Free: await portFree(25565),
        minecraftEulaAcceptance: 'not recorded: requires the operator; the lab has not accepted it or started a server',
        permissions: {
            workerFilesystemAndProcess: 'node --permission (defence in depth, not containment)',
            operatorOnServer: 'not tested: no server',
        },
        networking: {
            workerEgressIsolation: 'NOT ENFORCED on this host; requires the disposable Linux VM from docs/SECURITY.md',
        },
        paidRequestsMade: 0,
    };
    const offlineBlockers = [];
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) offlineBlockers.push('Node 22.19 or newer is required');
    const liveBlockers = [
        'M2: the operator has not accepted the Minecraft EULA for a lab server',
        'M2: the Paper telemetry plugin has not been built',
    ];
    if (!docker) liveBlockers.push('Containment: Docker is not installed, and no disposable Linux VM is configured');
    if (process.platform !== 'linux')
        liveBlockers.push(
            `Platform: upstream startAgent refuses to run on ${process.platform} (workspace tools require Linux). createGameTools does not have this limit`,
        );
    if (javaMajorVersion(java) !== 21)
        liveBlockers.push(
            `M2: upstream's server configuration uses Java 21; this host reports ${java ?? 'no Java'}. Qualify or pin it`,
        );
    const cli = cliAuthStatus();
    report.modelLogins = cli;
    if (!cli['claude-cli'].loggedIn && !cli['codex-cli'].loggedIn)
        liveBlockers.push('M3: neither the claude nor the codex CLI is logged in');
    if (cli.providerKeysInEnvironment.length)
        report.keyNote = `Set in this shell but never passed to the CLIs: ${cli.providerKeysInEnvironment.join(', ')}`;
    liveBlockers.push('M3: the real-game model loop is not built, and no model run has been approved');
    report.offlineBlockers = offlineBlockers;
    report.liveBlockers = liveBlockers;
    if (values.json) say(JSON.stringify(report, null, 2));
    else {
        say('Lab doctor (no server started, no model called)');
        for (const key of [
            'node',
            'java',
            'docker',
            'mineflayer',
            'freeDiskGb',
            'port25565Free',
            'minecraftEulaAcceptance',
        ])
            say(`  ${key}: ${report[key] ?? 'absent'}`);
        say(
            `  code: ${report.git.head ?? 'unknown'} on ${report.git.branch ?? 'unknown'}${report.git.dirty ? ' (dirty)' : ''}`,
        );
        say(
            `  credentials: ${Object.entries(report.credentials)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')}`,
        );
        if (report.upstreamEnvironmentNotForwarded.length)
            say(`  set but never forwarded to workers: ${report.upstreamEnvironmentNotForwarded.join(', ')}`);
        for (const [name, login] of Object.entries(report.modelLogins))
            if (name.endsWith('-cli'))
                say(
                    `  ${name}: ${login.installed ? `${login.loggedIn ? 'logged in' : 'not logged in'}${login.authMethod ? ` (${login.authMethod})` : ''}` : 'not installed'}`,
                );
        say(`  worker network egress isolation: ${report.networking.workerEgressIsolation}`);
        say(`Offline blockers: ${offlineBlockers.length ? offlineBlockers.join('; ') : 'none'}`);
        say('Live and paid blockers:');
        for (const blocker of liveBlockers) say(`  - ${blocker}`);
    }
    return offlineBlockers.length ? 1 : 0;
}

// Asks each CLI whether it is logged in. Makes no model request and prints no account details.
export function cliAuthStatus() {
    // Run without a shell. Some CLIs print status on stderr, so both streams are read.
    const read = (provider, args) => {
        const cli = resolveCli(provider);
        if (!cli) return null;
        const done = spawnSync(cli.command, [...cli.prefixArgs, ...args], {
            encoding: 'utf8',
            timeout: 20000,
            windowsHide: true,
        });
        return `${done.stdout ?? ''}\n${done.stderr ?? ''}`.trim() || null;
    };
    const claudeRaw = read('claude-cli', ['auth', 'status']);
    let claude = { installed: false };
    if (claudeRaw) {
        try {
            const parsed = JSON.parse(claudeRaw);
            claude = {
                installed: true,
                loggedIn: parsed.loggedIn === true,
                authMethod: parsed.authMethod ?? null,
                subscriptionType: parsed.subscriptionType ?? null,
            };
        } catch {
            claude = { installed: true, loggedIn: false, authMethod: null, note: 'unrecognized status output' };
        }
    }
    const codexRaw = read('codex-cli', ['login', 'status']);
    const codex = codexRaw
        ? {
              installed: true,
              loggedIn: /logged in/i.test(codexRaw) && !/not logged in/i.test(codexRaw),
              authMethod: /chatgpt/i.test(codexRaw) ? 'chatgpt' : /api key/i.test(codexRaw) ? 'api-key' : null,
          }
        : { installed: false };
    return {
        'claude-cli': claude,
        'codex-cli': codex,
        providerKeysInEnvironment: CREDENTIAL_NAMES.filter(name => process.env[name]),
    };
}

function authCommand() {
    say(JSON.stringify({ ...cliAuthStatus(), modelRequestsMade: 0 }, null, 2));
    return 0;
}

// The one command that can use the operator's plan. It makes exactly one model request, with no retry, and it refuses
// to run unless the operator passes the approval flag.
async function transportCheckCommand(values) {
    const provider = values.provider;
    if (!CLI_PROVIDERS.includes(provider ?? '')) return fail(`--provider must be ${CLI_PROVIDERS.join(' or ')}`, 2);
    if (!values.model) return fail('--model is required: give the exact model id to request', 2);
    if (!values['approve-one-request'])
        return fail('This makes one real request against your plan. Pass --approve-one-request to allow it.', 2);
    const auth = cliAuthStatus()[provider];
    if (!auth.installed) return fail(`${provider} is not installed`);
    if (!auth.loggedIn)
        return fail(`${provider} is not logged in. Log in with the CLI itself; the lab will not use an API key.`);
    if (!isSubscriptionLogin(provider, auth))
        return fail(
            `${provider} is logged in with ${auth.authMethod ?? 'an unrecognized method'}, not a subscription login. No request was made, because it could bill an API account.`,
        );
    const { store, ledger } = openStores(runsDirOf(values));
    store.close();
    const runId = `transport-check-${Date.now()}`;
    let boundary = null;
    try {
        ledger.openRun({
            runId,
            campaignId: 'transport-checks',
            runCapMicros: 0,
            campaignCapMicros: 0,
            maxRequests: 1,
        });
        const broker = createBroker({
            runId,
            ledger,
            provider: createCliProvider({
                provider,
                objective: 'Transport check. Reply done=true with a short note.',
                tools: [],
                onBoundary: init => (boundary = init),
            }),
            pricing: subscriptionPricing(provider, values.model),
            config: {
                model: { provider, id: values.model, maxOutputTokens: 256, maxConcurrentRequestsPerAgent: 1 },
                limits: { maxModelRetries: 0 },
            },
            requestTimeoutMs: Number(values.timeout ?? 120) * 1000,
        });
        const reply = await broker.request('transport-check', {
            requestId: 'one',
            observation: { note: 'No game is running.' },
            inputTokensBound: 1000,
        });
        say(
            JSON.stringify(
                {
                    provider,
                    requestedModel: values.model,
                    ok: reply.ok,
                    code: reply.code ?? null,
                    message: reply.message ?? null,
                    returnedModel: reply.modelVerified ? reply.model : null,
                    modelVerified: reply.modelVerified ?? false,
                    usage: reply.usage ?? null,
                    decision: reply.decision ?? null,
                    boundary,
                    ledger: ledger.runTotals(runId),
                },
                null,
                2,
            ),
        );
        return reply.ok ? 0 : 1;
    } finally {
        ledger.closeRun(runId);
        ledger.close();
    }
}

function validateCommand(values) {
    if (!values.config) return fail('--config is required', 2);
    const resolved = loadLabConfig(values.config);
    if (values.json) say(canonicalJson({ configHash: resolved.configHash, config: resolved.config }));
    else {
        say(`Config is valid: ${values.config}`);
        say(
            `  mode ${resolved.config.mode}, scenario ${resolved.config.scenario} (frozen: ${resolved.scenario.frozen ?? 'n/a'}), agents ${resolved.config.agents}`,
        );
        say(
            `  budget: run $${resolved.config.limits.runBudgetUsd}, campaign $${resolved.config.limits.campaignBudgetUsd}`,
        );
        say(`  config hash: ${resolved.configHash}`);
    }
    return 0;
}

async function runCommand(values) {
    if (!values.config) return fail('--config is required', 2);
    const resolved = loadLabConfig(values.config);
    const result = await runLab({
        resolved,
        runsDir: runsDirOf(values),
        onCreated: ({ runId, runDir }) => say(`Run ${runId} started. Artifacts: ${runDir}`),
    });
    say(`Run ${result.runId} finished: ${result.state} (${result.reason})`);
    if (result.score)
        say(`  Score: ${result.score.points}/${result.score.maxPoints} from ${result.score.evidenceClass} evidence`);
    say(
        `  Settled $${microsToUsd(result.spending.settledMicros)}, exposure $${microsToUsd(result.spending.unsettledExposureMicros)}, provider requests ${result.spending.providerRequests}`,
    );
    say(`  Report: ${result.reportPath}`);
    return result.state === 'COMPLETED' ? 0 : 1;
}

const requireRun = (store, runId) => {
    if (!runId) throw Object.assign(new Error('--run is required'), { exit: 2 });
    const run = store.run(runId);
    if (!run) throw Object.assign(new Error(`Unknown run ${runId}`), { exit: 1 });
    return run;
};

function statusCommand(values) {
    const { store, ledger } = openStores(runsDirOf(values));
    try {
        const run = requireRun(store, values.run);
        const totals = ledger.runTotals(run.run_id);
        const controllerAlive = run.controller_pid ? pidAlive(run.controller_pid) : false;
        const status = {
            runId: run.run_id,
            state: run.state,
            terminationReason: run.termination_reason,
            stopRequested: Boolean(store.stopRequest(run.run_id)),
            controllerAlive: isTerminal(run.state) ? null : controllerAlive,
            spending: totals,
            transitions: store.transitions(run.run_id).map(t => `${t.at} ${t.to_state}`),
            artifacts: run.run_dir,
        };
        if (!isTerminal(run.state) && !controllerAlive)
            status.action = 'The controller is gone. Run lab:stop for this run to close it.';
        say(JSON.stringify(status, null, 2));
        return 0;
    } finally {
        store.close();
        ledger.close();
    }
}

async function stopCommand(values) {
    const runsDir = runsDirOf(values);
    const { store, ledger } = openStores(runsDir);
    try {
        const run = requireRun(store, values.run);
        if (isTerminal(run.state)) {
            say(`Run ${run.run_id} has already ended: ${run.state} (${run.termination_reason})`);
            return 0;
        }
        store.requestStop(run.run_id);
        if (!run.controller_pid || !pidAlive(run.controller_pid)) {
            const recovered = recoverInterrupted({ store, ledger });
            const row = recovered.find(r => r.runId === run.run_id);
            say(`Controller was gone. Closed run ${run.run_id}: ${row?.state ?? store.run(run.run_id).state}`);
            return 0;
        }
        const limitMs = Number(values.timeout ?? 15) * 1000;
        const started = Date.now();
        while (Date.now() - started < limitMs) {
            const state = store.run(run.run_id).state;
            if (isTerminal(state)) {
                say(`Run ${run.run_id} stopped: ${state} in ${Date.now() - started} ms`);
                return 0;
            }
            await delay(50);
        }
        return fail(`Run ${run.run_id} did not stop within ${limitMs} ms; state ${store.run(run.run_id).state}`);
    } finally {
        store.close();
        ledger.close();
    }
}

function loadRunArtifacts(values) {
    const { store, ledger } = openStores(runsDirOf(values));
    try {
        return requireRun(store, values.run);
    } finally {
        store.close();
        ledger.close();
    }
}

function reportCommand(values) {
    const run = loadRunArtifacts(values);
    const reportFile = path.join(run.run_dir, 'report.md');
    if (!existsSync(reportFile)) return fail(`Run ${run.run_id} has no report yet; state ${run.state}`);
    say(readFileSync(reportFile, 'utf8'));
    const integrity = verifyIntegrity(run.run_dir);
    say(`Artifact hashes: ${integrity.ok ? 'match' : `MISMATCH: ${integrity.problems.join('; ')}`}`);
    const scoreFile = path.join(run.run_dir, 'score.json');
    const snapshotFile = path.join(run.run_dir, 'resolved-config.json');
    if (existsSync(scoreFile) && existsSync(snapshotFile)) {
        const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
        const { events } = readEvents(path.join(run.run_dir, 'events.jsonl'));
        const saved = JSON.parse(readFileSync(scoreFile, 'utf8'));
        const again = scoreRun({
            scenario: snapshot.scenario,
            events,
            participants: snapshot.participants,
            evidenceClass: saved.evidenceClass,
        });
        const same = canonicalJson(again) === canonicalJson(saved);
        say(`Re-score from events: ${same ? 'matches score.json' : 'DIFFERS from score.json'}`);
        if (!same) return 1;
    }
    return integrity.ok ? 0 : 1;
}

function replayCommand(values) {
    const run = loadRunArtifacts(values);
    const { events, malformed } = readEvents(path.join(run.run_dir, 'events.jsonl'));
    if (!events.length) return fail(`Run ${run.run_id} has no events`);
    say(
        `Event timeline for ${run.run_id}. This reconstructs recorded events; it is not a deterministic replay of the world.`,
    );
    for (const line of timelineLines(events, Number.MAX_SAFE_INTEGER)) say(line);
    const gaps = sequenceGaps(events);
    say(`${events.length} events, ${malformed} malformed lines, ${gaps.length} sequence gaps.`);
    return 0;
}

export async function main(argv = process.argv.slice(2)) {
    const [command, ...rest] = argv;
    const commands = {
        doctor,
        auth: authCommand,
        'transport-check': transportCheckCommand,
        validate: validateCommand,
        run: runCommand,
        status: statusCommand,
        stop: stopCommand,
        report: reportCommand,
        replay: replayCommand,
    };
    if (!Object.hasOwn(commands, command ?? ''))
        return fail(`Unknown command ${command ?? '(none)'}. Commands: ${Object.keys(commands).join(', ')}`, 2);
    try {
        return await commands[command](parse(rest));
    } catch (error) {
        if (error.code === 'INVALID_CONFIG') return fail(error.message, 2);
        if (error.code?.startsWith?.('ERR_PARSE_ARGS')) return fail(error.message, 2);
        if (error.exit) return fail(error.message, error.exit);
        throw error;
    }
}

process.exitCode = await main();
