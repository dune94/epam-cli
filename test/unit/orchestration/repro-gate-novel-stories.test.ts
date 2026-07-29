/**
 * A novel story has no bug to reproduce.
 *
 * Live AMSD-2041 2026-07-29:
 *
 *   Step 3.55: reproduction gate BLOCKED AMSD-2041 (gate exit 1)
 *   "the fix does not ship a test that reproduces the bug"
 *
 * AMSD-2041 is storyKind "novel" — a new capability. The spec pass said so in
 * every lane, and the detective is explicit: "there is no fix site, and
 * inventing one produces a confident wrong answer." There is no bug, so no test
 * can reproduce one, so this gate can NEVER pass for this story. It is not a
 * high bar; it is an unsatisfiable one.
 *
 * The gate selected every story in the phase:
 *
 *   .stories[] | select(.id as $id | $ids | index($id) != null) | .id
 *
 * with no storyKind filter. Same defect class as LAD-2 on the ladder side: the
 * classification exists and is correct, and the consumer does not read it.
 *
 * A DEFECT must still be gated. That is the whole point of the gate — a bug fix
 * without a reproducing test proves nothing — so this must narrow the gate's
 * scope, never weaken it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Run the gate's own story-selection jq against a PRD fixture. */
function selected(stories: Record<string, unknown>[]): string[] {
  const d = mkdtempSync(join(tmpdir(), 'repro-gate-'));
  dirs.push(d);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: stories.map((s) => s.id) },
    stories,
  }));
  // The selection expression exactly as the gate runs it.
  // Anchor on the GATE, then take its jq program. The same
  // "(.implementationOrder[$phase] // []) as $ids" opener appears earlier for
  // the main-story selector, so anchoring on that text alone extracted the
  // wrong block (agentGroup/completed filters) and every case came back empty —
  // a harness that fails closed manufactures passes.
  const gate = SRC.indexOf('Bug-reproduction test gate (brownfield)');
  expect(gate, 'repro gate not found').toBeGreaterThan(-1);
  const i = SRC.indexOf("'(.implementationOrder[$phase] // []) as $ids |", gate);
  expect(i, 'gate story selection not found').toBeGreaterThan(-1);
  const expr = SRC.slice(i + 1, SRC.indexOf("'", i + 1));
  const r = spawnSync('jq', ['-r', '--arg', 'phase', 'core', expr, prd], { encoding: 'utf8' });
  // A jq program that does not PARSE also produces no output, which is
  // indistinguishable from "selected nothing" — so an unparseable program would
  // satisfy every "expect([])" here. Verified: removing the storyKind filter
  // broke the quoting and this file still passed 4/4 until this check existed.
  expect(r.status, `jq failed, so an empty result proves nothing:\n${r.stderr}`).toBe(0);
  return (r.stdout || '').split('\n').filter(Boolean);
}

describe('the reproduction gate applies to defects only', () => {
  it('does not gate a novel story — it can never satisfy it', () => {
    expect(selected([{ id: 'NOVEL-1', storyKind: 'novel' }]),
      'a novel story is required to ship a bug-reproduction test for a bug that does not exist')
      .toEqual([]);
  });

  it('still gates a defect', () => {
    // Narrowing the scope must not weaken the gate: a bug fix with no
    // reproducing test proves nothing.
    expect(selected([{ id: 'BUG-1', storyKind: 'defect' }]),
      'the gate no longer protects bug fixes').toEqual(['BUG-1']);
  });

  it('gates a story whose kind is unknown', () => {
    // Absent classification defaults to the safe side: gate it.
    expect(selected([{ id: 'UNKNOWN-1' }])).toEqual(['UNKNOWN-1']);
  });

  it('selects only the defects from a mixed phase', () => {
    expect(selected([
      { id: 'NOVEL-1', storyKind: 'novel' },
      { id: 'BUG-1', storyKind: 'defect' },
      { id: 'BUG-2', storyKind: 'defect' },
    ])).toEqual(['BUG-1', 'BUG-2']);
  });
});
