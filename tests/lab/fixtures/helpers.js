import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLabConfig } from '../../../lab/config/load.js';

export const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(FIXTURES, '..', '..', '..');
export const UPSTREAM_SHA = '775d558689f5e4eaa0f1d0d7a320035190b1fce6';

export function tempDir(t, prefix = 'lab-test-') {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    t.after(() => {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {}
    });
    return dir;
}

export function mockConfig(overrides = {}) {
    const base = {
        schemaVersion: 1,
        mode: 'mock',
        scenario: 'tool-qualification-v1',
        agents: 2,
        assignmentSeed: 1,
        controller: { bind: '127.0.0.1', paidApprovalRequired: true },
        runtime: {
            upstreamCommit: UPSTREAM_SHA,
            serverVersion: '1.21.6',
            paperBuild: null,
            serverImageDigest: null,
            fixtureId: null,
            fixtureSha256: null,
            durationSeconds: 2,
        },
        model: {
            provider: 'mock',
            id: 'scripted-v1',
            pricingRecord: null,
            maxOutputTokens: 1024,
            maxConcurrentRequestsPerAgent: 1,
        },
        limits: { runBudgetUsd: 0, campaignBudgetUsd: 0, maxProviderRequests: 0, maxModelRetries: 1 },
        policy: {
            sandbox: 'none',
            sharedMachine: 'none',
            generatedCode: false,
            internetResearch: false,
            observationMode: 'text',
            coordination: 'minimal',
            survivalReflexes: 'frozen-baseline',
            autoResumePreviousRun: false,
        },
    };
    return merge(base, overrides);
}

function merge(base, overrides) {
    const out = { ...base };
    for (const [key, value] of Object.entries(overrides))
        out[key] =
            value && typeof value === 'object' && !Array.isArray(value) && base[key] ? merge(base[key], value) : value;
    return out;
}

export const resolveMock = (overrides, env = {}) => resolveLabConfig(mockConfig(overrides), { env });

// A fictional provider whose prices exist only in these tests.
export const FAKE_PRICING = Object.freeze({
    provider: 'fake-paid',
    modelId: 'fake-model-1',
    source: 'test fixture, not a real price',
    retrievedAt: '2026-11-05',
    separatelyBilledFeatures: ['web_search'],
    inputMicrosPerToken: 1,
    outputMicrosPerToken: 5,
    cacheWriteMicrosPerToken: 2,
    cacheReadMicrosPerToken: 0.1,
});
