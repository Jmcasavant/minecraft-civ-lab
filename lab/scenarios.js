import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { deepFreeze, hashOf, REPO_ROOT } from './lib/util.js';

export const SCENARIOS_DIR = path.join(REPO_ROOT, 'scenarios');

export function loadScenario(id) {
    if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) throw new Error(`Invalid scenario id ${id}`);
    const file = path.join(SCENARIOS_DIR, id, 'scenario.yaml');
    if (!existsSync(file)) throw new Error(`Unknown scenario ${id}`);
    const scenario = parseYaml(readFileSync(file, 'utf8'), { uniqueKeys: true, strict: true });
    if (scenario.id !== id) throw new Error(`Scenario file ${file} declares id ${scenario.id}`);
    return deepFreeze({ ...scenario, hash: hashOf(scenario) });
}
