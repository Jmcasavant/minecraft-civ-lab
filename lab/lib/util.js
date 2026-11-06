import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(LAB_ROOT, '..');

export const loadJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const labSchema = name => loadJson(path.join(LAB_ROOT, 'schemas', `${name}.schema.json`));

export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .filter(k => value[k] !== undefined)
            .sort()
            .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
            .join(',')}}`;
    return JSON.stringify(value);
}

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const sha256File = file => sha256(readFileSync(file));
export const hashOf = value => sha256(canonicalJson(value));

export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

// Write-then-rename with an fsync so a crash leaves either the old file or the complete new one.
export function writeDurable(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    const fd = openSync(tmp, 'r+');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, file);
}

const SECRET_KEY = /(api[-_]?key|secret|token|password|passwd|authorization|bearer|credential)/i;
const SECRET_VALUE =
    /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|e2b_[a-z0-9]{8,})\b/;

export const looksSecret = text => SECRET_VALUE.test(String(text));

// Run artefacts pass through here. Budget and limit fields such as maxOutputTokens carry numbers, not credentials.
export function redact(value, key = '') {
    if (Array.isArray(value)) return value.map(v => redact(v));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
    if (typeof value === 'string' && (SECRET_KEY.test(key) || looksSecret(value))) return '[REDACTED]';
    return value;
}

// Reads the quoted version only: release dates in the same line contain numbers such as 21.
export function javaMajorVersion(versionLine) {
    const match = /version "(?:1\.)?(\d+)/.exec(versionLine ?? '');
    return match ? Number(match[1]) : null;
}

export const USD_MICROS = 1_000_000;
export const usdToMicros = usd => Math.ceil(Number((usd * USD_MICROS).toFixed(6)));
export const microsToUsd = micros => (micros / USD_MICROS).toFixed(6);

export function delay(ms, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}
