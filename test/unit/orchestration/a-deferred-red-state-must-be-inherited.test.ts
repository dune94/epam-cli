/**
 * A DEFERRAL WHOSE TARGET CANNOT JUDGE THE DEFERRED CASE IS A HOLE, NOT A HANDOFF.
 *
 * Step 3.545 (update-invalidated-tests) reconciles pre-existing tests that a fix legitimately
 * invalidated. When it cannot reconcile one it logs:
 *
 *     "Step 3.545: could not reconcile a failing test — leaving it for the repro-gate
 *      (Step 3.55) to judge. NOT blocking."
 *
 * and returns. Step 3.55 then iterates phase_stories_for_repro_gate(), which selects
 * `(.storyKind // "") != "novel"` — novel stories are excluded deliberately (fe5d6cb), because
 * a story that adds a capability has no bug to reproduce and can never satisfy fail-on-baseline.
 *
 * BOTH STEPS ARE INDIVIDUALLY CORRECT. 3.545 was made non-blocking on 2026-07-24 after it killed
 * a run whose fix and test were both sound. 3.55's exclusion is right. The defect is between
 * them: for a NOVEL story, 3.545 defers to a gate whose own selector excludes it, the loop
 * iterates zero stories, `_repro_blocked` stays 0, and line 7574 reports
 * "bug-reproduction test gate passed for all phase stories" — literally true of the empty set.
 *
 * Live 2026-08-11, AMSD-2041/gotransit (storyKind: novel): the suite was RED with 10 broken
 * suites, 3.545 deferred, 3.55 examined nothing, and the phase reported SUCCESS. The broken
 * code was already committed.
 *
 * THE FIX USES MACHINERY THAT ALREADY EXISTS. When 3.55 blocks it stamps the story
 * (`reviewStatus: "escalated"`, `reproGate: "failed"`, run-agent-orchestration.sh:7563-7565).
 * 3.545 has the same $PRD_FILE in scope and stamps nothing — its finding lives only in a log
 * line that no later step reads. A deferred RED state must be recorded on the story so any
 * later gate inherits it, rather than being passed verbally.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const GUARDS = join(ROOT, 'orchestrations/scripts/lib/story-guards.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function prdFile(stories: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), 'redstate-')); dirs.push(d);
  const p = join(d, 'prd.json');
  writeFileSync(p, JSON.stringify({
    implementationOrder: { core: (stories as any[]).map((s) => s.id) },
    stories,
  }, null, 2));
  return p;
}

/** Run the real selector from lib/story-guards.sh against a fixture PRD. */
function reproGateStories(prd: string): string[] {
  const r = spawnSync('bash', ['-c',
    `. "${GUARDS}" >/dev/null 2>&1; phase_stories_for_repro_gate "${prd}" core`,
  ], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean);
}

describe('THE HOLE: the deferral target excludes the deferring case', () => {
  it('a novel story is not selected by the repro gate', () => {
    const prd = prdFile([{ id: 'S-NOVEL', storyKind: 'novel' }]);
    expect(
      reproGateStories(prd),
      'this exclusion is CORRECT (fe5d6cb) — the point is that 3.545 defers to it anyway',
    ).toEqual([]);
  });

  it('a defect story IS selected — so the deferral is only broken for novel', () => {
    const prd = prdFile([{ id: 'S-DEFECT', storyKind: 'defect' }]);
    expect(reproGateStories(prd)).toEqual(['S-DEFECT']);
  });
});

describe('STEP 3.545 MUST RECORD THE RED STATE, NOT ONLY LOG IT', () => {
  const src = readFileSync(ORCH, 'utf8');
  const block = (() => {
    const start = src.indexOf('# Step 3.545:');
    expect(start, 'Step 3.545 moved — this test is anchored on it').toBeGreaterThan(0);
    const end = src.indexOf('# Step 3.55:', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))   // comments stripped: a `toContain` must not pass on prose
      .join('\n');
  })();

  it('the block is non-empty, so these assertions are not vacuous', () => {
    expect(block.length).toBeGreaterThan(200);
  });

  /**
   * EXECUTED, because the source-text version of this test was WORTHLESS.
   *
   * It asserted /jq .*(suiteState|...)/s over the block. With the stamping deleted the test
   * still passed — the regex matched the word `suiteState` in the WARNING MESSAGE. Mutation
   * caught it (2026-08-11). A `toContain` that a log line can satisfy proves nothing, exactly
   * like one a comment can satisfy.
   */
  function runStamping(prd: string): { code: number; prd: any } {
    const start = src.indexOf('        while IFS= read -r _uit_story; do\n            [ -z "$_uit_story" ] && continue\n            _tmp_prd=');
    expect(start, 'the 3.545 stamping loop moved — this test is anchored on it').toBeGreaterThan(0);
    const end = src.indexOf("            \"$PRD_FILE\" 2>/dev/null)", start);
    const body = src.slice(start, end + 40);

    const r = spawnSync('bash', ['-c',
      `set -u
       PHASE=core
       PRD_FILE="${prd}"
       error() { echo "ERROR: $*" >&2; }
       ${body}
       exit 0`,
    ], { encoding: 'utf8' });
    return { code: r.status ?? 1, prd: JSON.parse(readFileSync(prd, 'utf8')) };
  }

  it('actually writes suiteState=red onto every story in the phase', () => {
    const prd = prdFile([{ id: 'S-NOVEL', storyKind: 'novel' }]);
    const r = runStamping(prd);
    const s = r.prd.stories.find((x: any) => x.id === 'S-NOVEL');
    expect(
      s.suiteState,
      'the finding must live on the story, not in a log line no later gate reads',
    ).toBe('red');
    expect(s.suiteStateStep, 'the recording step is named so the state is traceable').toBe('3.545');
  });

  it('leaves the rest of the story untouched', () => {
    const prd = prdFile([{ id: 'S-NOVEL', storyKind: 'novel', agentRole: 'someone', completed: false }]);
    const s = runStamping(prd).prd.stories.find((x: any) => x.id === 'S-NOVEL');
    expect(s.agentRole).toBe('someone');
    expect(s.storyKind).toBe('novel');
    expect(s.completed).toBe(false);
  });
});

describe('STEP 3.55 MUST INHERIT A RED STATE IT DID NOT PRODUCE', () => {
  const src = readFileSync(ORCH, 'utf8');
  const block = (() => {
    const start = src.indexOf('# Step 3.55:');
    const end = src.indexOf('# Step 3.56', start);
    return src.slice(start, end > start ? end : start + 4000)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  })();

  it('the block is non-empty', () => {
    expect(block.length).toBeGreaterThan(200);
  });

  it('it fails the phase on an inherited RED state, not only on its own gate result', () => {
    expect(
      block,
      'a story 3.55 never examines must still fail the phase when 3.545 recorded RED — ' +
      'otherwise the empty loop reports SUCCESS, which is what shipped 10 broken suites',
    ).toMatch(/suiteState|testsRed/);
  });

  it('the success line is not reachable while any story carries an unresolved RED state', () => {
    const successIdx = block.indexOf('bug-reproduction test gate passed');
    expect(successIdx, 'the success line moved').toBeGreaterThan(0);
    const guard = block.slice(0, successIdx);
    expect(
      guard,
      'the SUCCESS message must be guarded by the inherited-state check, not only by _repro_blocked',
    ).toMatch(/suiteState|testsRed/);
  });
});

/**
 * EXECUTED, not read.
 *
 * The assertions above check that the source says the right thing. That is not evidence it
 * DOES the right thing — a source-text test passes on a comment, a dead branch, or an
 * unreachable line. This extracts the real inherited-RED check from Step 3.55 and runs it
 * under bash against fixture PRDs.
 */
describe('EXECUTING the inherited-RED check', () => {
  /** The real jq + guard from Step 3.55, extracted verbatim from the script. */
  function runInheritedRedCheck(prd: string): { code: number; err: string } {
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('    _inherited_red=$(jq -r --arg phase "$PHASE"');
    expect(start, 'the inherited-RED check moved — this test is anchored on it').toBeGreaterThan(0);
    const end = src.indexOf('fi', src.indexOf('exit 2', start));
    const body = src.slice(start, end + 2);

    const r = spawnSync('bash', ['-c',
      `set -u
       PHASE=core
       PRD_FILE="${prd}"
       error() { echo "ERROR: $*" >&2; }
       ${body}
       exit 0`,
    ], { encoding: 'utf8' });
    return { code: r.status ?? 1, err: r.stderr || '' };
  }

  it('BLOCKS when a novel story carries suiteState=red', () => {
    const prd = prdFile([{ id: 'S-NOVEL', storyKind: 'novel', suiteState: 'red', suiteStateStep: '3.545' }]);
    const r = runInheritedRedCheck(prd);
    expect(r.code, 'this is the AMSD-2041 case that shipped 10 broken suites as SUCCESS').toBe(2);
    expect(r.err).toContain('S-NOVEL');
  });

  it('PASSES when no story carries a red suite', () => {
    const prd = prdFile([{ id: 'S-NOVEL', storyKind: 'novel' }]);
    expect(runInheritedRedCheck(prd).code).toBe(0);
  });

  it('PASSES when the red story is not in this phase', () => {
    // implementationOrder scoping must be respected — a red story from another phase is
    // not this phase's to block on.
    const d = mkdtempSync(join(tmpdir(), 'redstate-')); dirs.push(d);
    const p = join(d, 'prd.json');
    writeFileSync(p, JSON.stringify({
      implementationOrder: { core: ['S-A'], other: ['S-B'] },
      stories: [{ id: 'S-A' }, { id: 'S-B', suiteState: 'red' }],
    }));
    expect(runInheritedRedCheck(p).code).toBe(0);
  });

  it('BLOCKS on a defect story too — the check is not novel-specific', () => {
    const prd = prdFile([{ id: 'S-DEFECT', storyKind: 'defect', suiteState: 'red' }]);
    expect(runInheritedRedCheck(prd).code).toBe(2);
  });

  it('names every red story, not just the first', () => {
    const prd = prdFile([
      { id: 'S-ONE', suiteState: 'red' },
      { id: 'S-TWO', suiteState: 'red' },
    ]);
    const r = runInheritedRedCheck(prd);
    expect(r.code).toBe(2);
    expect(r.err).toContain('S-ONE');
    expect(r.err).toContain('S-TWO');
  });
});

/**
 * THE SUITE GETS A BASELINE TOO.
 *
 * Recording suiteState=red on ANY red suite blocks a run on breakage it did not cause. The
 * operator's policy is explicit — "for brownfield we inherit existing test failures, but we
 * cannot be expected to fix them" — and the type check has honoured it since 2026-07-22 via
 * lib/tsc-baseline-gate.sh. The suite had no equivalent, which is why correction 2 shipped
 * blocking on absolutes.
 */
describe('STEP 3.545 SUBTRACTS THE BASELINE BEFORE IT STAMPS', () => {
  const block = (() => {
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('# Step 3.545:');
    const end = src.indexOf('# Step 3.55:', start);
    return src.slice(start, end).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  })();

  it('it asks for the delta before stamping', () => {
    expect(block, 'without a baseline the stamp fires on inherited breakage').toContain('baseline_new_failures');
  });

  it('it asks for the TEST section, not the type check', () => {
    expect(block).toMatch(/baseline_new_failures[^\n]*\n?[^\n]*\btest\b/);
  });

  it('it hands in the output it already captured rather than re-running the suite', () => {
    // Re-running would double the most expensive step in the phase.
    expect(block).toMatch(/update-invalidated-tests-\$\{PHASE\}\.log/);
  });

  it('an all-inherited result clears the failure instead of stamping', () => {
    expect(block).toMatch(/_uit_failed=0/);
  });

  it('the stamp still happens when the delta is unavailable or non-empty', () => {
    // command -v guards the call: with no library the step behaves exactly as before, and an
    // undeclared parse makes the delta decline. Neither may silently skip the stamp.
    expect(block).toContain('command -v baseline_new_failures');
    expect(block).toMatch(/suiteState/);
  });
});
