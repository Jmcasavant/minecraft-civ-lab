import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { CLI_PROVIDERS } from '../broker/cli-provider.js';
import { assertValid } from '../lib/schema.js';
import { deepFreeze, hashOf, labSchema, looksSecret, redact } from '../lib/util.js';
import { loadScenario } from '../scenarios.js';

const CONFIG_SCHEMA = labSchema('config');

// The only environment overrides the lab accepts, applied once at load time. Everything else is ignored by design:
// upstream AGENT_*, MC_* and MODEL_* variables never reach a worker (see adapter/upstream.js).
const ENV_OVERRIDES = {
    LAB_DURATION_SECONDS: (config, value) => {
        const seconds = Number(value);
        if (!Number.isInteger(seconds)) throw new ConfigError(`LAB_DURATION_SECONDS must be an integer, got ${value}`);
        config.runtime.durationSeconds = seconds;
    },
};
const LAB_NON_CONFIG_ENV = new Set(['LAB_RUNS_DIR']);

export class ConfigError extends Error {
    code = 'INVALID_CONFIG';
}

function scanForSecrets(value, path = '$') {
    if (typeof value === 'string' && looksSecret(value)) throw new ConfigError(`${path}: looks like a literal secret`);
    if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) scanForSecrets(v, `${path}.${k}`);
}

export function semanticErrors(config) {
    const errors = [];
    const { mode, model, limits, runtime } = config;
    if (limits.campaignBudgetUsd < limits.runBudgetUsd) errors.push('limits.campaignBudgetUsd is below runBudgetUsd');
    if (mode === 'mock') {
        if (model.provider !== 'mock') errors.push('mode mock requires model.provider mock');
        if (limits.runBudgetUsd !== 0 || limits.campaignBudgetUsd !== 0)
            errors.push('mode mock requires a zero budget');
        if (limits.maxProviderRequests !== 0) errors.push('mode mock requires limits.maxProviderRequests 0');
    }
    if (mode === 'subscription') {
        if (!CLI_PROVIDERS.includes(model.provider))
            errors.push(`mode subscription requires provider ${CLI_PROVIDERS.join(' or ')}`);
        if (!config.campaignId) errors.push('mode subscription requires campaignId');
        if (limits.runBudgetUsd !== 0 || limits.campaignBudgetUsd !== 0)
            errors.push('mode subscription uses no dollar budget; set both budgets to 0');
        if (!(limits.maxProviderRequests > 0))
            errors.push('mode subscription requires limits.maxProviderRequests above zero');
        if (model.pricingRecord) errors.push('mode subscription has no pricing record');
        if (!runtime.upstreamCommit) errors.push('mode subscription requires runtime.upstreamCommit');
    }
    if (mode === 'paid') {
        if (model.provider === 'mock') errors.push('mode paid cannot use the mock provider');
        if (!config.campaignId) errors.push('mode paid requires campaignId');
        if (!model.pricingRecord) errors.push('mode paid requires model.pricingRecord');
        if (!(limits.runBudgetUsd > 0)) errors.push('mode paid requires limits.runBudgetUsd above zero');
        if (!(limits.campaignBudgetUsd > 0)) errors.push('mode paid requires limits.campaignBudgetUsd above zero');
        if (!(limits.maxProviderRequests > 0)) errors.push('mode paid requires limits.maxProviderRequests above zero');
        for (const key of ['upstreamCommit', 'paperBuild', 'serverImageDigest', 'fixtureId', 'fixtureSha256'])
            if (runtime[key] === null) errors.push(`mode paid requires runtime.${key}`);
    }
    return errors;
}

export function resolveLabConfig(raw, { env = process.env } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('Config must be a mapping');
    scanForSecrets(raw);
    const config = structuredClone(raw);
    const applied = {};
    for (const name of Object.keys(env)) {
        if (!name.startsWith('LAB_') || LAB_NON_CONFIG_ENV.has(name)) continue;
        const override = ENV_OVERRIDES[name];
        if (!override) throw new ConfigError(`Unknown lab environment override ${name}`);
        override(config, env[name]);
        applied[name] = env[name];
    }
    try {
        assertValid(CONFIG_SCHEMA, config, 'lab config');
    } catch (error) {
        if (error.code === 'INVALID') throw new ConfigError(error.message);
        throw error;
    }
    const errors = semanticErrors(config);
    let scenario = null;
    try {
        scenario = loadScenario(config.scenario);
    } catch (error) {
        errors.push(error.message);
    }
    if (scenario && config.agents > scenario.maxAgents)
        errors.push(`scenario ${config.scenario} allows at most ${scenario.maxAgents} agents`);
    if (errors.length) throw new ConfigError(`Invalid lab config:\n  ${errors.join('\n  ')}`);
    return deepFreeze({ config, configHash: hashOf(config), scenario, envOverrides: applied });
}

export function loadLabConfig(file, options) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new ConfigError(`Cannot read ${file}: ${error.code ?? error.message}`);
    }
    let raw;
    try {
        raw = parseYaml(text, { uniqueKeys: true, strict: true });
    } catch (error) {
        throw new ConfigError(`${file}: ${error.message}`);
    }
    return resolveLabConfig(raw, options);
}

export const redactedConfig = resolved => redact(resolved.config);
