import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLabConfig, resolveLabConfig } from '../../../lab/config/load.js';
import { REPO, mockConfig, resolveMock, tempDir } from '../fixtures/helpers.js';

const rejects = (overrides, pattern, env = {}) =>
    assert.throws(() => resolveLabConfig(mockConfig(overrides), { env }), pattern);

test('the shipped mock config is valid and spends nothing', () => {
    const { config } = loadLabConfig(path.join(REPO, 'configs', 'mock.yaml'), { env: {} });
    assert.equal(config.mode, 'mock');
    assert.equal(config.limits.runBudgetUsd, 0);
    assert.equal(config.limits.maxProviderRequests, 0);
});

test('unknown fields are rejected at every level', () => {
    rejects({ surprise: 1 }, /unknown field/);
    rejects({ model: { baseUrl: 'https://evil.example' } }, /unknown field/);
    rejects({ policy: { extra: true } }, /unknown field/);
});

test('safety policy cannot be relaxed from a config file', () => {
    rejects({ policy: { sandbox: 'local' } }, /policy.sandbox/);
    rejects({ policy: { sharedMachine: 'local' } }, /policy.sharedMachine/);
    rejects({ policy: { generatedCode: true } }, /generatedCode/);
    rejects({ policy: { autoResumePreviousRun: true } }, /autoResumePreviousRun/);
    rejects({ controller: { bind: '0.0.0.0' } }, /bind/);
    rejects({ controller: { paidApprovalRequired: false } }, /paidApprovalRequired/);
});

test('mock mode cannot carry a budget or a real provider', () => {
    rejects({ limits: { runBudgetUsd: 1, campaignBudgetUsd: 1 } }, /zero budget/);
    rejects({ model: { provider: 'anthropic' } }, /requires model.provider mock/);
    rejects({ limits: { maxProviderRequests: 5 } }, /maxProviderRequests 0/);
});

test('paid mode rejects every placeholder', () => {
    assert.throws(
        () => resolveLabConfig(mockConfig({ mode: 'paid', model: { provider: 'x' } }), { env: {} }),
        error => {
            for (const part of [
                'campaignId',
                'pricingRecord',
                'runBudgetUsd',
                'campaignBudgetUsd',
                'maxProviderRequests',
                'paperBuild',
                'fixtureSha256',
            ])
                assert.match(error.message, new RegExp(part));
            return true;
        },
    );
});

test('subscription mode uses a CLI login, a request cap and no dollar budget', () => {
    const valid = {
        mode: 'subscription',
        campaignId: 'pilot',
        model: { provider: 'claude-cli', id: 'some-model' },
        limits: { maxProviderRequests: 10 },
    };
    assert.equal(resolveLabConfig(mockConfig(valid), { env: {} }).config.mode, 'subscription');
    rejects({ ...valid, model: { provider: 'anthropic', id: 'x' } }, /mode subscription requires provider/);
    rejects({ ...valid, limits: { maxProviderRequests: 0 } }, /maxProviderRequests above zero/);
    rejects(
        { ...valid, limits: { maxProviderRequests: 5, runBudgetUsd: 5, campaignBudgetUsd: 5 } },
        /no dollar budget/,
    );
});

test('literal secrets in a config are refused and never echoed', () => {
    assert.throws(
        () => resolveLabConfig(mockConfig({ model: { pricingRecord: 'sk-abcdefghijklmnop' } }), { env: {} }),
        error => {
            assert.match(error.message, /looks like a literal secret/);
            assert.doesNotMatch(error.message, /sk-abcdefghijklmnop/);
            return true;
        },
    );
});

test('environment overrides resolve once and unknown ones fail closed', () => {
    assert.equal(resolveMock({}, { LAB_DURATION_SECONDS: '9' }).config.runtime.durationSeconds, 9);
    assert.throws(() => resolveMock({}, { LAB_POLICY_SANDBOX: 'local' }), /Unknown lab environment override/);
    assert.throws(() => resolveMock({}, { LAB_DURATION_SECONDS: 'soon' }), /must be an integer/);
    // Upstream variables have no effect on the lab's resolved config.
    assert.equal(resolveMock({}, { AGENT_SANDBOX: 'local', MC_HOST: 'evil.example' }).config.policy.sandbox, 'none');
});

test('resolved configuration is frozen and hashed stably', () => {
    const a = resolveMock();
    const b = resolveMock();
    assert.equal(a.configHash, b.configHash);
    assert.throws(() => {
        a.config.limits.runBudgetUsd = 100;
    }, TypeError);
    assert.notEqual(a.configHash, resolveMock({ agents: 3 }).configHash);
});

test('malformed and duplicate-key YAML is rejected', t => {
    const dir = tempDir(t);
    const file = path.join(dir, 'bad.yaml');
    writeFileSync(file, 'schemaVersion: 1\nschemaVersion: 1\n');
    assert.throws(() => loadLabConfig(file, { env: {} }), /INVALID_CONFIG|Map keys must be unique/);
    assert.throws(() => loadLabConfig(path.join(dir, 'missing.yaml'), { env: {} }), /Cannot read/);
});

test('an unknown scenario and too many agents are rejected', () => {
    rejects({ scenario: 'no-such-scenario' }, /Unknown scenario/);
    rejects({ agents: 5 }, /above 4/);
});
