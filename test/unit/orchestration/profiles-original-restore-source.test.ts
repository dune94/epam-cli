/**
 * Re-audit finding, 2026-07-31 (both independent re-audit passes surfaced
 * this the same way): every `orchestrations/scripts/tier3-*-run.sh` and
 * `orchestrations/scripts/orchestrate.sh` unconditionally restores
 * `orchestrations/agents/profiles.json` FROM `profiles.json.original` at
 * the start of every run — this is the "Profiles: Canonical Base State
 * Every Run" standing design (restore before every run start). The initial
 * agent-audit fix pass updated `profiles.json` and `profiles.canonical.json`
 * but MISSED `profiles.json.original` — the file actually consumed by the
 * restore step. Every profile-text fix landed today (team-lead-agent's
 * WriteFile claim, sast-sentinel/review-ranger's unconditional
 * verify-with-shell-commands mandate, typescript-engineer's dead contract
 * instruction, test-coordinator-agent's phantom-role disclosure) would have
 * been silently reverted on the very next live run.
 *
 * `profiles-canonical.test.ts` checks key-set equality between
 * `profiles.json`/`profiles.json.original`, not content equality, so this
 * drift was invisible to the existing suite. This test asserts content
 * equality for every key across all three files, closing that blind spot.
 *
 * Also fixed 2026-07-31: profiles.canonical.json had broader, PRE-EXISTING
 * drift on 7 keys unrelated to any of today's fixes (typescript-engineer,
 * test-engineer, review-agent, prd-project-manager-agent, spike-agent,
 * story-ac-remediator, profile-augmentor) — canonical held much shorter,
 * older versions of several whole profiles. Confirmed profiles.json ==
 * profiles.json.original for every one of them, so profiles.json was the
 * correct/current version; canonical was synced to match it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');
const FILES = ['profiles.json', 'profiles.canonical.json', 'profiles.json.original'];

function loadProfiles(file: string): Record<string, string> {
  return JSON.parse(readFileSync(join(AGENTS, file), 'utf8'));
}

describe('profiles.json, profiles.canonical.json, and profiles.json.original stay in content sync', () => {
  const loaded = Object.fromEntries(FILES.map((f) => [f, loadProfiles(f)]));

  it('every key present in profiles.json has byte-identical text in profiles.json.original', () => {
    const live = loaded['profiles.json'];
    const original = loaded['profiles.json.original'];
    const mismatched: string[] = [];
    for (const key of Object.keys(live)) {
      if (original[key] !== undefined && original[key] !== live[key]) {
        mismatched.push(key);
      }
    }
    expect(mismatched,
      `profiles.json.original is the file every tier3-*-run.sh restores from at run start — ` +
      `these keys differ from the live profiles.json and will be silently reverted on the next ` +
      `run: ${mismatched.join(', ')}`)
      .toEqual([]);
  });

  // Broader pre-existing drift (typescript-engineer, test-engineer,
  // review-agent, prd-project-manager-agent, spike-agent,
  // story-ac-remediator, profile-augmentor — canonical held much
  // shorter/older versions of several whole profiles, not just wording
  // differences) was fixed 2026-07-31 by syncing every key in
  // profiles.canonical.json to profiles.json (confirmed profiles.json ==
  // profiles.json.original for all of them, i.e. profiles.json was the
  // correct/current version canonical had fallen behind). Now asserting
  // full key-set equality, not a scoped subset.
  it('every key present in profiles.json is byte-identical in profiles.canonical.json', () => {
    const live = loaded['profiles.json'];
    const canonical = loaded['profiles.canonical.json'];
    const mismatched: string[] = [];
    for (const key of Object.keys(live)) {
      if (canonical[key] !== undefined && canonical[key] !== live[key]) {
        mismatched.push(key);
      }
    }
    expect(mismatched,
      `profiles.canonical.json drifted from the live profiles.json for these keys: ${mismatched.join(', ')}`)
      .toEqual([]);
  });
});

describe('specific 2026-07-31 fixes survive the restore file', () => {
  const original = loadProfiles('profiles.json.original');

  it('team-lead-agent no longer claims WriteFile access it does not have', () => {
    expect(original['team-lead-agent']).not.toMatch(/full tool access.*WriteFile/);
    expect(original['team-lead-agent']).toMatch(/read-only tool access/);
  });

  it('sast-sentinel and review-ranger no longer mandate an unconditional shell-verification workflow', () => {
    expect(original['sast-sentinel']).not.toMatch(/MUST verify it exists in the actual source files using shell commands/);
    expect(original['review-ranger']).not.toMatch(/Before flagging any exported function as untested, you MUST:\n1\. Run:/);
  });

  it('typescript-engineer no longer claims to hand-write the contract file', () => {
    expect(original['typescript-engineer']).not.toMatch(/CONTRACT SCRATCHPAD.*MANDATORY LAST STEP/);
  });

  it('test-coordinator-agent discloses it is not an active LLM call', () => {
    expect(original['test-coordinator-agent']).toMatch(/not currently invoked as an LLM call/);
  });
});

describe('typescript-engineer\'s contract-instruction fix specifically (all three files)', () => {
  for (const file of FILES) {
    it(`${file} has no dead CONTRACT SCRATCHPAD instruction`, () => {
      expect(loadProfiles(file)['typescript-engineer']).not.toMatch(/CONTRACT SCRATCHPAD.*MANDATORY LAST STEP/);
    });
  }
});
