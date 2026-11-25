import { resolveConfig } from '../../src/config.js';
import { assertAllowlistSafe, createToolPolicy } from './tool-policy.js';

// The seam for milestone M2/M3: turns a validated lab config into options for the harness's own `startAgent`. A worker
// calls `startAgent` directly rather than bin/minecraft-agent.js, because the CLI loads .env from the working
// directory, lets flags and AGENT_* variables override a config file, and restarts its child on reconnectable exits.

// Values the operating system needs to start a process. Nothing else from the controller's environment is forwarded.
const WORKER_ENV_PASSTHROUGH = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'];

export function buildWorkerEnv(parentEnv, extra = {}) {
    const env = {};
    const names = new Map(Object.keys(parentEnv).map(name => [name.toUpperCase(), name]));
    for (const wanted of WORKER_ENV_PASSTHROUGH) {
        const actual = names.get(wanted);
        if (actual) env[actual] = parentEnv[actual];
    }
    return { ...env, ...extra };
}

export function toUpstreamConfig(resolved, { actorId, name, peers, host, port, brokerUrl, stateDir, objective }) {
    const { config, scenario } = resolved;
    const layer = {
        host,
        port,
        name,
        objective: objective ?? scenario.objective,
        auth: 'offline',
        minecraftVersion: config.runtime.serverVersion,
        gameMode: 'survival',
        model: `${config.model.provider}/${config.model.id}`,
        baseUrl: brokerUrl,
        sandbox: config.policy.sandbox,
        vision: false,
        allowFlight: false,
        reconnect: false,
        stateDir,
        team: peers.length > 0,
        peers,
    };
    // An empty env and a Docker probe that answers no keep upstream's fallback (docker, else unisolated local bash)
    // from ever being consulted, and stop MODEL_API_KEY or AGENT_* from applying here.
    const upstream = resolveConfig([layer], { env: {}, probeDocker: () => false, cwd: stateDir });
    if (upstream.sandbox.kind !== 'none') throw new Error(`Worker ${actorId} did not resolve to sandbox none`);
    if (upstream.toolsModule) throw new Error(`Worker ${actorId} resolved a tools module`);
    if (upstream.sharedMachineSocket) throw new Error(`Worker ${actorId} resolved a shared machine`);
    return upstream;
}

export function buildToolPolicy(resolved, { onRemoved } = {}) {
    const allowlist = assertAllowlistSafe([...resolved.scenario.tools]);
    // Upstream builds these two only in team mode, so they can be absent for a single agent and nowhere else.
    const optional = resolved.config.agents > 1 ? [] : ['directory', 'directory_search'];
    return createToolPolicy({ allowlist, optional, onRemoved });
}
