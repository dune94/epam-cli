/**
 * Full agent audit, 2026-07-31: test-coordinator-agent's profile described
 * an elaborate active role (reads PRD, sequences testing-gate agents,
 * applies quality-scoring, emits JSON verdicts) — but grep across
 * claude.sh/run-agent-orchestration.sh confirmed it is NEVER invoked as an
 * LLM call anywhere. The name is used only as an event-attribution label
 * (update-monitor.sh event calls) for the deterministic Phase A/B/C
 * sequencing/gate-aggregation logic actually implemented in
 * run-agent-orchestration.sh. The profile is not removed (the label is a
 * real, intentional part of observability, and the prose still documents
 * intended responsibilities for a future LLM-based implementation) — it now
 * says so explicitly instead of silently implying active LLM behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');
const ORCH_SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

function profile(file: string): string {
  const p = JSON.parse(readFileSync(join(AGENTS, file), 'utf8'));
  const t = p['test-coordinator-agent'];
  expect(t, `test-coordinator-agent missing from ${file}`).toBeTruthy();
  return t as string;
}

for (const file of ['profiles.json', 'profiles.canonical.json']) {
  describe(`${file} — test-coordinator-agent discloses it is not an active LLM call`, () => {
    it('states it is not currently invoked as an LLM call', () => {
      expect(profile(file)).toMatch(/not currently invoked as an LLM call/);
    });

    it('names the actual mechanism (deterministic logic in run-agent-orchestration.sh)', () => {
      expect(profile(file)).toMatch(/implemented deterministically in run-agent-orchestration\.sh/);
    });

    it('explains the label is used for observability event-attribution', () => {
      expect(profile(file)).toMatch(/event-attribution label/);
    });
  });
}

describe('the label really is used for event attribution (confirming the note is accurate)', () => {
  it('appears as an event-attribution argument in run-agent-orchestration.sh', () => {
    const occurrences = ORCH_SRC.match(/"main" "test-coordinator-agent"/g) || [];
    expect(occurrences.length, 'if this label is no longer used anywhere, the profile note is now inaccurate').toBeGreaterThan(0);
  });
});
