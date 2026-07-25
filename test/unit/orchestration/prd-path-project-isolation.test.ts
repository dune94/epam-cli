/**
 * Each project must own its PRD file. Two projects sharing one path means running
 * either destroys the other's PRD.
 *
 * LIVE DAMAGE (found 2026-07-25 by the pre-run PRD invariant test, not by anyone
 * noticing): tier3-metrolinx-run.sh, tier3-travel-app-run.sh and
 * tier3-skyscanner-app-run.sh all hardcoded
 *
 *     PRD_FILE="$REPO_ROOT/orchestrations/travel-app-prd.json"
 *
 * and ingest-jira-tickets.sh defaulted its OUT_PRD to the same file. So a metrolinx
 * run's Jira ingest OVERWROTE the travel-app PRD: its 4 SKY stories were replaced by
 * a single AMSD-1820 story marked completed. The travel-app PRD was only recoverable
 * because travel-app-prd.canonical.json exists — skyscanner had no such backstop.
 *
 * This is the same defect class as the agent-invocation work: a parameter that is
 * defaulted rather than derived from the identity that already exists
 * (EPAM_PROJECT_CONFIG_DIR), so every caller silently gets the same wrong value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

const runners = readdirSync(SCRIPTS).filter(f => /^tier3-.*-run\.sh$/.test(f));

/** The PRD_FILE path each runner assigns, verbatim. */
function prdPathOf(runner: string): string | null {
  const src = readFileSync(join(SCRIPTS, runner), 'utf8');
  const m = src.match(/^PRD_FILE=(.+)$/m);
  return m ? m[1].trim() : null;
}

describe('PRD path — one project, one PRD file', () => {
  it('finds the tier3 runners', () => {
    expect(runners.length).toBeGreaterThan(1);
  });

  it('no two projects write to the same PRD path', () => {
    const byPath = new Map<string, string[]>();
    for (const r of runners) {
      const p = prdPathOf(r);
      if (!p) continue;
      byPath.set(p, [...(byPath.get(p) ?? []), r]);
    }
    const shared = [...byPath.entries()].filter(([, rs]) => rs.length > 1);
    expect(shared.map(([p, rs]) => `${rs.join(' + ')} -> ${p}`),
      'these runners overwrite each other\'s PRD').toEqual([]);
  });

  it('the Jira ingest does not default to a specific project\'s PRD', () => {
    // OUT_PRD="${ORCH_DIR}/travel-app-prd.json" made every ingest, for any Jira
    // project, land in the travel-app PRD unless the caller remembered --out-prd.
    const src = readFileSync(join(SCRIPTS, 'ingest-jira-tickets.sh'), 'utf8');
    const m = src.match(/^OUT_PRD=(.+)$/m);
    expect(m, 'ingest-jira-tickets.sh has no OUT_PRD default').toBeTruthy();
    expect(m![1], 'ingest defaults into one named project\'s PRD')
      .not.toMatch(/travel-app-prd\.json|skyscanner.*\.json/);
  });
});
