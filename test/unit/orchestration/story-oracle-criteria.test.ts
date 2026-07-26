/**
 * A gate must be shown the criteria the story is actually judged against.
 *
 * Live metrolinx 2026-07-26, run 8. The spec validator answered:
 *
 *   {"stories":[{"storyId":"AMSD-1820","criteria":[],"overallCompliance":100,
 *                "verdict":"pass"}],"overallVerdict":"pass"}
 *
 * Zero criteria evaluated, 100% compliance reported — and the agent was not at
 * fault. Its prompt says "use the pre-injected acceptanceCriteria", and the
 * oracle building that section read `acceptanceCriteria` alone. Brownfield
 * stories carry `verificationCriteria`. AMSD-1820 finished with three VCs and
 * zero ACs, so the oracle emitted "Acceptance criteria (0):" and the agent
 * truthfully classified an empty list.
 *
 * The criteria moved to a new field and the oracle did not follow, so a gate
 * validated against nothing and scored it full marks. This is the failure the
 * pipeline is least able to detect on its own: not a wrong answer, but a
 * confident answer to a question nobody asked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORACLE = join(__dirname, '../../../orchestrations/scripts/lib/story_oracle.py');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const VC = 'Given a Mozio booking with a promo code and a return trip, the rendered ' +
           'email confirmation displays the discount amount for the return leg';
const AC = 'The system displays the promo code discount for both outbound and return legs';

function build(story: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: ['AMSD-1820'] },
    stories: [{ id: 'AMSD-1820', title: 'Promo code', ...story }],
  }));
  const r = spawnSync('python3', [ORACLE, prd, 'core'], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '') + (r.stderr || '');
}

describe('the oracle shows whatever criteria the story carries', () => {
  it('injects verificationCriteria — the exact run-8 shape', () => {
    // Three VCs, zero ACs: the state AMSD-1820 was actually in.
    const out = build({ verificationCriteria: [VC], acceptanceCriteria: [] });
    expect(out, 'the validator is handed nothing and reports 100% over an empty set')
      .toContain('return leg');
  });

  it('labels them as verification criteria, not acceptance criteria', () => {
    // "Acceptance criteria (0)" reads as "nothing to check"; the label must be true.
    const out = build({ verificationCriteria: [VC] });
    expect(out).toMatch(/Verification criteria \(1\)/);
  });

  it('still injects acceptanceCriteria when that is what the story has', () => {
    const out = build({ acceptanceCriteria: [AC] });
    expect(out).toContain('outbound and return legs');
    expect(out).toMatch(/Acceptance criteria \(1\)/);
  });

  it('prefers verification criteria when a story carries both', () => {
    // VCs are observable and testable; ACs are the looser statement they refine.
    const out = build({ verificationCriteria: [VC], acceptanceCriteria: [AC] });
    expect(out).toMatch(/Verification criteria/);
  });

  it('reads criteria written as {text} objects, not only plain strings', () => {
    const out = build({ acceptanceCriteria: [{ text: AC, status: 'pending' }] });
    expect(out).toContain('outbound and return legs');
  });

  it('tells the gate that an empty set cannot be scored', () => {
    // The run-8 failure in one line: nothing to check must not read as "fine".
    const out = build({ acceptanceCriteria: [], verificationCriteria: [] });
    expect(out, 'an empty criteria list is presented as though it were satisfiable')
      .toMatch(/cannot report compliance|none recorded/i);
  });

  it('is wired into the spec validator', () => {
    const orch = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(orch, 'the validator still builds its oracle from acceptanceCriteria alone')
      .toMatch(/story_oracle\.py/);
  });
});
