/**
 * Full agent audit, 2026-07-31: typescript-engineer's profile carried a
 * "CONTRACT SCRATCHPAD — MANDATORY LAST STEP" instruction telling the model
 * to hand-write the cross-story contract file itself. That's dead prose —
 * deterministic-contract-generation.test.ts documents the model never
 * reliably produced it, so generate_story_contract() (claude.sh) now writes
 * it deterministically via regex extraction, overriding prompt reliance.
 * The stale "MANDATORY"/"Omitting ... will cause ... to fail" wording
 * misleadingly pressured the model to attempt a redundant, unreliable task.
 * Replaced with an accurate note: the file is generated automatically, no
 * action needed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');

function tsEngineerProfile(file: string): string {
  const p = JSON.parse(readFileSync(join(AGENTS, file), 'utf8'));
  const t = p['typescript-engineer'];
  expect(t, `typescript-engineer missing from ${file}`).toBeTruthy();
  return t as string;
}

for (const file of ['profiles.json', 'profiles.canonical.json']) {
  describe(`${file} — typescript-engineer no longer claims to hand-write the contract`, () => {
    it('has no MANDATORY LAST STEP contract-scratchpad instruction', () => {
      expect(tsEngineerProfile(file)).not.toMatch(/CONTRACT SCRATCHPAD.*MANDATORY LAST STEP/);
    });

    it('does not threaten test-story failure for omitting a hand-written contract', () => {
      expect(tsEngineerProfile(file)).not.toMatch(/Omitting the contract file will cause/);
    });

    it('accurately states the contract file is generated automatically', () => {
      const t = tsEngineerProfile(file);
      expect(t).toMatch(/CONTRACT FILE:/);
      expect(t).toMatch(/generated for you automatically/);
      expect(t).toMatch(/you do not need to write it yourself/);
    });
  });
}
