import { assertValid } from '../lib/schema.js';
import { labSchema } from '../lib/util.js';
import { assembleScore, prepareEvidence } from './evidence.js';
import { scoreSettlement } from './settlement.js';
import { scoreToolQualification } from './tool-qualification.js';

const SCORE_SCHEMA = labSchema('score');
const SCORERS = { 'tool-qualification': scoreToolQualification, 'settlement-60': scoreSettlement };

export const hasScorer = name => Object.hasOwn(SCORERS, name);

// Pure: the same events and scenario always yield the same score, with no clock, file or network access.
export function scoreRun({ scenario, events, participants, evidenceClass }) {
    const scorer = SCORERS[scenario.scorer];
    if (!scorer) throw new Error(`Scenario ${scenario.id} names unknown scorer ${scenario.scorer}`);
    const evidence = prepareEvidence(events, { evidenceClass, participants });
    const components = scorer({ evidence, scenario });
    return assertValid(SCORE_SCHEMA, assembleScore({ scenario, evidence, components }), 'score');
}
