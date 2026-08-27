/**
 * A LOOKUP THAT READS THE WRONG FILE REPORTS A BINDING FAILURE.
 *
 * Live 2026-08-27, run 20260827T125654Z: both lanes logged
 *   "NO INVESTIGATOR for codeline 'mocka' — 2 investigator(s) are registered
 *    (mocka-fare-detective, mockb-schedule-detective) but none is bound to this codeline"
 * while <project>/agent-profiles.json held BOTH briefs, written by the mint 27 minutes earlier, and
 * <project>/project-investigators.json mapped mocka -> mocka-fare-detective exactly as it should.
 *
 * Nothing was unbound. The lookup resolved the right NAME and then asked for its brief from
 * orchestrations/agents/profiles.json — the canonical roster, which holds the 57 shipped roles and
 * has never held a project's minted ones. The guard is `name && profiles[name]`, so a present name
 * with an absent brief falls through to a message about binding.
 *
 * It was invisible because the fallback is CORRECT for a codeline that genuinely minted no
 * investigator: the generic code-graph-detective runs, the lane continues, and the only symptom is
 * a stderr line that reads like a roster problem.
 *
 * Three copies of that read existed and a fix to one would have left the others — so the lookup is
 * now one exported function, asserted here against the real files on disk.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const AGENTS_DIR = join(REPO_ROOT, 'orchestrations/agents');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { profilesWithProjectBriefs } = require(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

/** A project that has actually minted investigators — discovered, never named here. */
function projectWithInvestigators(): { dir: string; names: string[] } | null {
  const root = join(REPO_ROOT, 'orchestrations/projects');
  for (const p of readdirSync(root)) {
    const reg = join(root, p, 'project-investigators.json');
    const briefs = join(root, p, 'agent-profiles.json');
    if (!existsSync(reg) || !existsSync(briefs)) continue;
    try {
      const names = (JSON.parse(readFileSync(reg, 'utf8')).investigators || []) as string[];
      if (names.length) return { dir: join(root, p), names };
    } catch { /* try the next project */ }
  }
  return null;
}

describe('an investigator brief is found where the mint wrote it', () => {
  it('a project with minted investigators exists — otherwise this asserts nothing', () => {
    expect(projectWithInvestigators(), 'no project has minted investigators; nothing is under test')
      .toBeTruthy();
  });

  it('REPRODUCES run 14: the canonical roster alone does NOT contain them', () => {
    // The premise of the defect. If this ever fails, the briefs moved back and the fix below is
    // no longer load-bearing.
    const found = projectWithInvestigators()!;
    const canonical = JSON.parse(readFileSync(join(AGENTS_DIR, 'profiles.json'), 'utf8'));
    const profiles = canonical.profiles || canonical;
    for (const n of found.names) {
      expect(profiles[n], `${n} is in the canonical roster — the premise no longer holds`).toBeFalsy();
    }
  });

  it('the lookup finds every minted investigator once the project is in scope', () => {
    const found = projectWithInvestigators()!;
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR;
    process.env.EPAM_PROJECT_CONFIG_DIR = found.dir;
    try {
      const profiles = profilesWithProjectBriefs(join(REPO_ROOT, 'orchestrations/logs'));
      for (const n of found.names) {
        expect(profiles[n],
          `no brief for '${n}' — the lane will report NO INVESTIGATOR and run the generic detective`)
          .toBeTruthy();
      }
      // The canonical roster must still be there: this merges, it does not replace.
      expect(Object.keys(profiles).length,
        'the canonical roles were lost — the merge replaced instead of layering')
        .toBeGreaterThan(found.names.length);
    } finally {
      if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR;
      else process.env.EPAM_PROJECT_CONFIG_DIR = prev;
    }
  });
});
