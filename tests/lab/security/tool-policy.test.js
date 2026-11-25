import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildWorkerEnv, buildToolPolicy, toUpstreamConfig } from '../../../lab/adapter/upstream.js';
import { assertAllowlistSafe, createToolPolicy, FORBIDDEN_TOOLS } from '../../../lab/adapter/tool-policy.js';
import { createMinecraftSession } from '../../../src/model/session.js';
import { REPO, resolveMock, tempDir } from '../fixtures/helpers.js';

const SNAPSHOT = JSON.parse(readFileSync(path.join(REPO, 'test', 'fixtures', 'tool-definitions.json'), 'utf8'));
const upstreamNames = Object.values(SNAPSHOT).flatMap(list => list.map(t => t.name));
const tool = name => ({
    name,
    description: name,
    parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
});

// A real MinecraftSession with only the pi SDK replaced, so this exercises the final registration boundary.
async function session(tools, toolPolicy) {
    let installed;
    const runner = await createMinecraftSession(
        {
            agentId: 'test',
            cwd: '/x',
            sessionDir: '/x/s',
            systemPrompt: 'rules',
            tools,
            toolPolicy,
            observe: async () => ({ text: 'o', images: [] }),
        },
        {
            createSession: async options => {
                installed = options.tools;
                const manager = { getEntries: () => [], appendCustomEntry() {} };
                return {
                    session: {
                        isIdle: true,
                        agent: { transformContext: async m => m },
                        subscribe: () => () => {},
                        prompt: async () => {},
                        abort: async () => {},
                        dispose() {},
                        messages: [],
                    },
                    sessionManager: manager,
                    compatible: false,
                };
            },
        },
    );
    return { runner, installed };
}

const allNames = [
    'observe_world',
    'go_to',
    'run_shell',
    'shared_exec',
    'compute_js',
    'workspace_read',
    'workspace_write',
    'workspace_list',
    'fly_to',
    'mystery_tool',
];

test('forbidden built-in bypass: a real session registers only the allowlist', async () => {
    const removed = [];
    const policy = createToolPolicy({ allowlist: ['observe_world', 'go_to'], onRemoved: n => removed.push(n) });
    const { installed, runner } = await session(allNames.map(tool), policy);
    assert.deepEqual(installed.map(t => t.name).sort(), ['go_to', 'observe_world']);
    for (const name of ['run_shell', 'shared_exec', 'compute_js', 'workspace_write', 'session_history', 'mystery_tool'])
        assert.ok(removed.includes(name), name);
    // invokeTool is the path the shell relay uses, so it must not reach a removed tool either.
    for (const name of ['run_shell', 'compute_js', 'session_history'])
        await assert.rejects(runner.invokeTool(name, {}), /Unknown tool/);
});

test('without a policy the upstream session behaves as before, so the seam is additive', async () => {
    const { installed } = await session(['go_to', 'run_shell'].map(tool), undefined);
    assert.deepEqual(
        installed.map(t => t.name),
        ['go_to', 'run_shell', 'session_history'],
    );
});

test('a missing allowlisted tool stops startup instead of running short', async () => {
    const policy = createToolPolicy({ allowlist: ['observe_world', 'never_built'] });
    await assert.rejects(session(['observe_world'].map(tool), policy), /Allowlisted tools are missing: never_built/);
});

test('forbidden tools can never be allowlisted', () => {
    for (const name of FORBIDDEN_TOOLS) assert.throws(() => assertAllowlistSafe(['go_to', name]), /forbidden/);
    assert.throws(() => assertAllowlistSafe([]), /empty/);
    assert.throws(() => assertAllowlistSafe(['go_to', 'go_to']), /duplicate/);
});

test('admitted tools are frozen', () => {
    const [wrapped] = createToolPolicy({ allowlist: ['go_to'] })([tool('go_to')]);
    assert.throws(() => {
        wrapped.execute = () => 'swapped';
    }, TypeError);
});

test('every shipped scenario allowlist names real upstream tools or documented team/runner tools', () => {
    const known = new Set([...upstreamNames, 'directory', 'directory_search', 'wait']);
    for (const [scenario, agents] of [
        ['tool-qualification-v1', 2],
        ['settlement-60-v0.1', 4],
    ]) {
        const { scenario: s } = resolveMock({ scenario, agents });
        for (const name of s.tools) assert.ok(known.has(name), `${scenario}: ${name}`);
    }
});

test('the upstream fallback to an unisolated shell is impossible through the adapter', () => {
    const upstream = toUpstreamConfig(resolveMock(), {
        actorId: 'agent-a',
        name: 'agent_a',
        peers: ['agent_b'],
        host: '127.0.0.1',
        port: 25565,
        brokerUrl: 'http://127.0.0.1:1/v1',
        stateDir: '/run/a',
    });
    assert.equal(upstream.sandbox.kind, 'none');
    assert.equal(upstream.toolsModule, null);
    assert.equal(upstream.sharedMachineSocket, undefined);
    assert.equal(upstream.reconnect, false);
    assert.equal(upstream.allowFlight, false);
    assert.equal(upstream.apiKey, undefined, 'the adapter passes no provider key');
});

test('upstream environment variables and .env-style settings cannot change adapter output', t => {
    const previous = { ...process.env };
    t.after(() => {
        for (const key of ['AGENT_SANDBOX', 'AGENT_TOOLS_MODULE', 'MODEL_API_KEY', 'MC_HOST']) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });
    Object.assign(process.env, {
        AGENT_SANDBOX: 'local',
        AGENT_TOOLS_MODULE: '/evil.mjs',
        MODEL_API_KEY: 'k',
        MC_HOST: 'evil.example',
    });
    const upstream = toUpstreamConfig(resolveMock(), {
        actorId: 'a',
        name: 'a',
        peers: [],
        host: '127.0.0.1',
        port: 25565,
        brokerUrl: 'http://127.0.0.1:1/v1',
        stateDir: '/run/a',
    });
    assert.equal(upstream.sandbox.kind, 'none');
    assert.equal(upstream.toolsModule, null);
    assert.equal(upstream.host, '127.0.0.1');
    assert.equal(upstream.apiKey, undefined);
});

test('a worker environment drops everything outside the short passthrough list', () => {
    const env = buildWorkerEnv(
        {
            PATH: 'p',
            SYSTEMROOT: 's',
            ANTHROPIC_API_KEY: 'k',
            AGENT_SANDBOX: 'local',
            NODE_OPTIONS: '--require x',
            HOME: '/h',
            USERPROFILE: 'u',
        },
        { LAB_WORKER_TOKEN: 't' },
    );
    assert.deepEqual(Object.keys(env).sort(), ['LAB_WORKER_TOKEN', 'PATH', 'SYSTEMROOT']);
});

test('a single-agent policy tolerates only the team-mode tools being absent', t => {
    tempDir(t);
    const names = resolveMock({ agents: 1 }).scenario.tools.filter(n => !n.startsWith('directory'));
    const policy = buildToolPolicy(resolveMock({ agents: 1 }));
    assert.equal(policy(names.map(tool)).length, names.length);
    assert.throws(
        () => buildToolPolicy(resolveMock({ agents: 2 }))(names.map(tool)),
        /missing: directory, directory_search/,
    );
});
