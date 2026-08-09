/**
 * THE TWO BASE-STATE FILES MUST NAME THE SAME ROLES.
 *
 * Two files claim to be the roster's base state:
 *   profiles.json.original   — what pre-run-reset.sh:354 and every tier3 launcher RESTORE from.
 *                              The scripts call it "the canonical floor: all core agents".
 *   profiles.canonical.json  — what mint-agents-step.js diffs the live roster AGAINST to decide
 *                              what a run generated.
 *
 * Live 2026-08-08 they disagreed by SEVEN roles — failure-analyst, kb-change-reviewer,
 * prd-change-reviewer, prd-model-coordinator, codeline-bridge-agent,
 * retry-extension-coordinator, code-graph-detective — every one of them an engine role the
 * pipeline invokes (code-graph-detective appears in 13 script files, failure-analyst in 10).
 *
 * Two consequences, one cosmetic and one not:
 *   - every run reported seven phantom "pre-existing drift" entries that were nothing of the
 *     kind, which is noise in the one report that exists to make real drift visible;
 *   - anything that restored from profiles.canonical.json would delete the detective.
 *
 * Nothing caught it. profiles-canonical.test.ts — named for the file, cited by the launchers
 * as the guard — never opens profiles.canonical.json at all; it checks profiles.json and
 * profiles.json.original against a hand-written CORE_AGENT_PROFILES list that happens to omit
 * all seven.
 *
 * This asserts the RELATIONSHIP between the files rather than restating their contents, so it
 * cannot go stale the way a hand-written list does: no role name is written here, and adding a
 * permanent agent to one file without the other fails immediately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = join(__dirname, '../../../orchestrations/agents');
const ORIGINAL = join(AGENTS, 'profiles.json.original');
const CANONICAL = join(AGENTS, 'profiles.canonical.json');
const LIVE = join(AGENTS, 'profiles.json');

const roles = (p: string): string[] => Object.keys(JSON.parse(readFileSync(p, 'utf8'))).sort();

describe('both base-state files exist', () => {
  it('the restore source is present', () => expect(existsSync(ORIGINAL)).toBe(true));
  it('the diff baseline is present', () => expect(existsSync(CANONICAL)).toBe(true));
  it('neither is empty — an empty file would make every assertion below vacuous', () => {
    expect(roles(ORIGINAL).length).toBeGreaterThan(0);
    expect(roles(CANONICAL).length).toBeGreaterThan(0);
  });
});

describe('THE DEFECT: the base-state files name exactly the same roles', () => {
  it('no role exists in the restore source but not the diff baseline', () => {
    const missing = roles(ORIGINAL).filter((r) => !roles(CANONICAL).includes(r));
    expect(
      missing,
      `profiles.canonical.json is missing ${missing.length} role(s) that profiles.json.original ` +
      `restores: ${missing.join(', ')}. Every run then reports them as "pre-existing drift", and ` +
      'anything restoring from canonical would delete them.',
    ).toEqual([]);
  });

  it('no role exists in the diff baseline but not the restore source', () => {
    const extra = roles(CANONICAL).filter((r) => !roles(ORIGINAL).includes(r));
    expect(
      extra,
      `profiles.canonical.json declares ${extra.length} role(s) that no run would ever restore: ` +
      `${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('the two are the same set', () => {
    expect(roles(CANONICAL)).toEqual(roles(ORIGINAL));
  });
});

describe('every role the base state names carries a real brief', () => {
  it('no empty or whitespace-only profile in either file', () => {
    for (const p of [ORIGINAL, CANONICAL]) {
      const obj = JSON.parse(readFileSync(p, 'utf8'));
      const blank = Object.keys(obj).filter((k) => !String(obj[k] || '').trim());
      expect(blank, `${p} has role(s) with no brief: ${blank.join(', ')}`).toEqual([]);
    }
  });

  it('a role present in both files carries the SAME brief in each', () => {
    const a = JSON.parse(readFileSync(ORIGINAL, 'utf8'));
    const b = JSON.parse(readFileSync(CANONICAL, 'utf8'));
    const differ = Object.keys(a).filter((k) => k in b && a[k] !== b[k]);
    expect(
      differ,
      `the same role is briefed differently in the two base files: ${differ.join(', ')} — ` +
      'which one a run gets would then depend on which file it happened to read',
    ).toEqual([]);
  });
});

describe('the live roster is the base state plus whatever this run minted', () => {
  it('profiles.json contains every role the restore source names', () => {
    // The floor. A live roster missing a restored role means something deleted an engine agent.
    const missing = roles(ORIGINAL).filter((r) => !roles(LIVE).includes(r));
    expect(missing, `profiles.json is missing restored role(s): ${missing.join(', ')}`).toEqual([]);
  });
});
