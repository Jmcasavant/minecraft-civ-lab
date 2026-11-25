import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../fixtures/helpers.js';

const scripts = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;
const DOCS = ['OPERATIONS.md', 'STATUS.md', 'UPSTREAM_AUDIT.md', 'SECURITY.md', 'LAB_ARCHITECTURE.md'];

test('every lab command documented anywhere exists as an npm script', () => {
    const used = new Set();
    for (const name of DOCS) {
        const text = readFileSync(path.join(REPO, 'docs', name), 'utf8');
        for (const match of text.matchAll(/\blab:[a-z-]+/g)) used.add(match[0]);
    }
    assert.ok(used.size >= 8);
    for (const command of used) assert.ok(scripts[command], `${command} has no npm script`);
});

test('every lab npm script is documented for operators', () => {
    const text = readFileSync(path.join(REPO, 'docs', 'OPERATIONS.md'), 'utf8');
    for (const name of Object.keys(scripts).filter(s => s.startsWith('lab:')))
        assert.match(text, new RegExp(`\\b${name}\\b`), name);
});

test('every lab npm script points at a real command or test path', () => {
    for (const [name, script] of Object.entries(scripts)) {
        if (!name.startsWith('lab:') || name === 'lab:test') continue;
        const command = name.slice(4);
        assert.ok(script.endsWith(`lab/cli/lab.js ${command}`), name);
    }
    assert.ok(existsSync(path.join(REPO, 'lab', 'cli', 'lab.js')));
});

test('mock output is labelled as mock in the operator guide', () => {
    assert.match(readFileSync(path.join(REPO, 'docs', 'OPERATIONS.md'), 'utf8'), /MOCK RUN/);
});

test('the documentation does not claim qualification that has not happened', () => {
    const security = readFileSync(path.join(REPO, 'docs', 'SECURITY.md'), 'utf8');
    assert.match(security, /Nothing in this project is qualified yet/);
    assert.match(security, /\*\*Not enforced\*\*/);
});
