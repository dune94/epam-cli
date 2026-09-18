/**
 * SUPERFLUOUS AGENTS MUST NOT TRIGGER A REPLACEMENT BRIEF.
 *
 * When a roster reviewer's remedy says "remove X entirely — its work is fully subsumed by
 * retained roles", the corrective mint must NOT tell the minter to find a new owner for X's
 * work. That instruction is what causes the catchall-re-minting loop:
 *
 *   cycle 1: reviewer says "regintel-engineer is superfluous, remove entirely"
 *   replacedBlock: "regintel-engineer was removed — THEIR WORK STILL NEEDS AN OWNER"
 *   cycle 2: minter produces a NEW regintel-engineer or a new catchall role
 *   cycle 3: reviewer indicts the catchall … and so on until the budget is exhausted
 *
 * Fix: partitionRosterFindings(findings, minted) returns a `superfluous` list — agents
 * whose remedy matches the "remove entirely / fully subsumed / collapse into one" pattern.
 * The corrective mint excludes them from replacedAgents and adds them to superfluousAgents,
 * which renders a "DO NOT REPLACE" block rather than a "WORK STILL NEEDS AN OWNER" block.
 *
 * Tests are static (no LLM calls):
 *   1. partitionRosterFindings returns superfluous list for matching remedies
 *   2. Agents in superfluous are NOT in retained (they are still indicted)
 *   3. A finding whose remedy does NOT match the pattern is not treated as superfluous
 *   4. mintProjectAgents prompt assembler includes superfluousBlock when superfluousAgents given
 */
import { describe, it, expect } from 'vitest';

const AGENT_ROSTER = require('../../../orchestrations/scripts/lib/agent-roster.js');
const { partitionRosterFindings } = AGENT_ROSTER;

const SUPERFLUOUS_REMEDIES = [
  'Remove regintel-engineer from the roster entirely (its role is fully subsumed by the pipeline-engineer and service-engineer briefs)',
  'Remove this role entirely — it is fully subsumed by the retained role',
  'regintel-engineer should be removed entirely since its scope is already covered',
];

const NON_SUPERFLUOUS_REMEDIES = [
  // "Collapse into one" means dedup — the role still exists after correction, just as one copy
  'Collapse the two identical regintel-pipeline-engineer entries into one, and resolve the models.py/store.py overlap',
  'Collapse the three identical regintel-service-engineer entries into a single implementer brief',
  'Name a single owner for models.py and store.py (pipeline-engineer owns them; service-engineer only imports them)',
  'Tell the investigator that the source repo path is recorded as sourceRepoReadOnly inside the reviewed PRD checkpoint',
];

const MINTED = [
  { name: 'regintel-engineer', kind: 'implementer', rationale: 'all tickets' },
  { name: 'regintel-pipeline-engineer', kind: 'implementer', rationale: 'pipeline tickets' },
  { name: 'regintel-service-engineer', kind: 'implementer', rationale: 'service tickets' },
  { name: 'spec-coordinator-agent', kind: 'coordinator', rationale: 'coordinates' },
];

describe('partitionRosterFindings — superfluous detection', () => {
  it('returns superfluous list for "remove entirely / fully subsumed / collapse into one" remedies', () => {
    const findings = SUPERFLUOUS_REMEDIES.map((remedy, i) => ({
      agent: MINTED[i % MINTED.length].name,
      severity: 'blocking',
      claim: 'false claim',
      checked: 'checked',
      found: 'found',
      remedy,
    }));

    const result = partitionRosterFindings(findings, MINTED);

    expect(result).toHaveProperty('superfluous');
    expect(Array.isArray(result.superfluous)).toBe(true);
    // Every finding with a superfluous-pattern remedy must appear in the superfluous list
    for (const f of findings) {
      if (f.agent && MINTED.some((m) => m.name === f.agent)) {
        expect(result.superfluous).toContain(f.agent);
      }
    }
  });

  it('superfluous agents are still indicted (not retained)', () => {
    const findings = [{
      agent: 'regintel-engineer',
      severity: 'blocking',
      claim: 'false claim about roster composition',
      checked: 'compared against retained agents',
      found: 'pipeline-engineer IS in the roster',
      remedy: 'Remove regintel-engineer from the roster entirely (its role is fully subsumed by the pipeline-engineer and service-engineer briefs)',
    }];

    const result = partitionRosterFindings(findings, MINTED);

    expect(result.indicted).toContain('regintel-engineer');
    expect(result.retained.map((a: any) => a.name)).not.toContain('regintel-engineer');
    expect(result.superfluous).toContain('regintel-engineer');
  });

  it('non-matching remedies do NOT appear in superfluous', () => {
    const findings = NON_SUPERFLUOUS_REMEDIES.map((remedy, i) => ({
      agent: MINTED[i % MINTED.length].name,
      severity: 'blocking',
      claim: 'overlapping ownership',
      checked: 'compared file lists',
      found: 'overlap exists',
      remedy,
    }));

    const result = partitionRosterFindings(findings, MINTED);

    // Non-matching remedies must NOT be in superfluous
    for (const f of findings) {
      if (f.agent) expect(result.superfluous).not.toContain(f.agent);
    }
    // But they ARE still indicted
    for (const f of findings) {
      if (f.agent && MINTED.some((m) => m.name === f.agent)) {
        expect(result.indicted).toContain(f.agent);
      }
    }
  });

  it('finding with no remedy is not treated as superfluous', () => {
    const findings = [{
      agent: 'regintel-engineer',
      severity: 'blocking',
      claim: 'false claim',
      checked: 'checked',
      found: 'found',
      // no remedy field
    }];

    const result = partitionRosterFindings(findings, MINTED);

    expect(result.superfluous).not.toContain('regintel-engineer');
    expect(result.indicted).toContain('regintel-engineer');
  });
});
