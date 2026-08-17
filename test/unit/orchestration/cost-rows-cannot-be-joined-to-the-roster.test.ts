/**
 * THE COST LEDGER NAMES AGENTS THAT DO NOT EXIST IN THE ROSTER.
 *
 * Every mint-stage call site already names its seam:
 *
 *     seamInvocationEnv('estate-survey', logDir)     ... runAgentForJson(..., 'ESTATE_SURVEY', ...)
 *     seamInvocationEnv('agent-mint', logDir)        ... runAgentForJson(..., 'PROJECT_AGENTS', ...)
 *     seamInvocationEnv('roster-review', logDir)     ... runAgentForJson(..., 'ROSTER_REVIEW', ...)
 *     seamInvocationEnv('role-assigner', logDir)     ... runAgentForJson(..., 'ROLE_ASSIGNMENTS', ...)
 *
 * The seam is one identity; the cost tag beside it is a second, unrelated literal. They agree on
 * two of the four by luck of spelling and disagree on the other two outright — PROJECT_AGENTS is
 * the seam 'agent-mint', ROLE_ASSIGNMENTS is 'role-assigner'. Live 2026-08-17, run
 * 20260817T162132Z, phase-cost.jsonl held:
 *
 *     codeline-discovery, ESTATE_SURVEY, PROJECT_AGENTS, ROSTER_REVIEW, ROLE_ASSIGNMENTS,
 *     prompt-builder
 *
 * so per-agent spend cannot be joined to the roster, the registry, or the activity timeline, and
 * "what did the mint cost" has to be answered by knowing which two spellings mean the same thing.
 * Normalising the case does not fix it: two of the four would still name no seam at all.
 *
 * The fix is one identity, not two — the cost label comes from the seam the call already declares.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const SEAMS = new Set(Object.keys(registry.profiles || {}));

describe('cost rows cannot be joined to the roster', () => {
  it('the helper that decides a cost label is reachable', () => {
    expect(typeof spec.costLabelFor,
      'spec-mode-runner does not expose how a cost label is chosen, so it cannot be asserted')
      .toBe('function');
  });

  it('THE COST LABEL IS THE SEAM THE CALL ALREADY DECLARES', () => {
    // EPAM_SEAM is set by seamInvocationEnv, so the identity is already present at every site.
    expect(spec.costLabelFor('ESTATE_SURVEY', { EPAM_SEAM: 'estate-survey' })).toBe('estate-survey');
    expect(spec.costLabelFor('PROJECT_AGENTS', { EPAM_SEAM: 'agent-mint' })).toBe('agent-mint');
    expect(spec.costLabelFor('ROLE_ASSIGNMENTS', { EPAM_SEAM: 'role-assigner' })).toBe('role-assigner');
  });

  it('an explicit agent name still wins — a minted agent is not its seam', () => {
    // Many agents share one seam (every -investigator runs at code-graph-detective). The cost row
    // must name the AGENT where one is given, or per-agent spend collapses onto the archetype.
    expect(spec.costLabelFor('X', { EPAM_SEAM: 'code-graph-detective', EPAM_AGENT_NAME: 'mocka-investigator' }))
      .toBe('mocka-investigator');
  });

  it('falls back to the tag when neither is present', () => {
    // No seam, no agent: the tag is all there is, and losing the row entirely would be worse.
    expect(spec.costLabelFor('LEGACY_TAG', {})).toBe('LEGACY_TAG');
    expect(spec.costLabelFor('LEGACY_TAG', null)).toBe('LEGACY_TAG');
  });

  it('every label it produces for the mint stage names a REAL seam', () => {
    // The join this whole test exists for: a label that matches no seam cannot be reconciled
    // against the roster by any reader.
    for (const [tag, seam] of [
      ['ESTATE_SURVEY', 'estate-survey'],
      ['PROJECT_AGENTS', 'agent-mint'],
      ['ROSTER_REVIEW', 'roster-review'],
      ['ROLE_ASSIGNMENTS', 'role-assigner'],
    ]) {
      const label = spec.costLabelFor(tag, { EPAM_SEAM: seam });
      expect(SEAMS.has(label), `cost label '${label}' matches no seam in the registry`).toBe(true);
    }
  });
});
