/**
 * TWO DIFFERENT QUESTIONS SHARED ONE FILTER, AND THE WRONG ONE ANSWERED "no".
 *
 * THE DRIFT. fe5d6cb (2026-07-29) fixed a real defect: the bug-reproduction gate
 * (Step 3.55) was blocking AMSD-2041, a storyKind "novel" story, for not shipping a
 * test that reproduces a bug it does not have. Unsatisfiable, correctly narrowed with
 * `select((.storyKind // "") != "novel")`.
 *
 * The same commit pasted that identical filter into a SECOND loop — Step 3.54, the
 * dedicated test *writer* (run-agent-orchestration.sh:6990). That one did not deserve
 * it. The writer does not need a bug: it reads the committed fix diff and the story's
 * verificationCriteria, and its own validator requires the test to PASS against the
 * committed fix — there is no red-baseline assumption anywhere in it.
 *
 * THE CONSEQUENCE. Step 10's TC writer is skipped for ALL brownfield, so Step 3.54 is
 * the only step in the brownfield path that authors a test. Excluding novel from it
 * left novel brownfield stories with no test author at all — while team-lead-review.sh
 * :436 still enforces test coverage. Live run 20260804T202338Z: all three lanes
 * changes_requested, every one carrying a test-coverage blocker ("the change adds ZERO
 * test coverage… VC1 is trivially testable and its absence is a blocker"), against a
 * story nothing had been asked to write a test for. Unwinnable by construction.
 *
 * THE FIX SHAPE. The two questions get two names, so they cannot be re-conflated by a
 * future copy-paste:
 *
 *   phase_stories_brownfield_scope   — every story in the phase. Who gets a test
 *                                      written, and whose VC coverage is reported.
 *   phase_stories_for_repro_gate     — only stories with a bug to reproduce. Strictly
 *                                      narrower, and narrower ON PURPOSE.
 *
 * Executes the REAL functions under bash, including against the three live checkpoints
 * from the run that deadlocked.
 *
 * SUPERSEDES test/unit/orchestration/repro-gate-novel-stories.test.ts, which covered the
 * gate half of this (novel not gated / defect gated / unknown gated / mixed) by slicing
 * the jq program out of the orchestrator's source text and running it standalone. Its
 * own commit admitted it could not be made to fail under mutation. All four of its cases
 * live on here, run against the real function instead of an extracted string.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const GUARDS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

/** The three lanes that deadlocked — real spec output, not a fixture I typed. */
const LIVE = (lane: string) =>
  join(
    REPO_ROOT,
    `orchestrations/projects/metrolinx/runs/20260804T185158Z/lanes/${lane}/checkpoint/prd.json`,
  );

interface Selection {
  ids: string[];
  status: number;
  stderr: string;
}

/** Run one of the REAL selector functions and return what it selected. */
function select(fn: string, prd: unknown | string, phase = 'core'): Selection {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'));
  try {
    const prdFile = typeof prd === 'string' ? prd : join(dir, 'prd.json');
    if (typeof prd !== 'string') writeFileSync(prdFile, JSON.stringify(prd, null, 2));
    const script = join(dir, 'run.sh');
    writeFileSync(
      script,
      [
        'set -uo pipefail',
        'log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }',
        `source ${JSON.stringify(GUARDS)}`,
        `${fn} ${JSON.stringify(prdFile)} ${JSON.stringify(phase)}`,
        'echo "RC=$?"',
      ].join('\n'),
    );
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
    const out = r.stdout || '';
    const rcLine = /RC=(\d+)/.exec(out);
    return {
      ids: out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('RC=')),
      status: rcLine ? Number(rcLine[1]) : -1,
      stderr: r.stderr || '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A PRD whose `core` phase holds one story per storyKind given. */
const prdWith = (kinds: (string | null)[]) => ({
  implementationOrder: { core: kinds.map((_, i) => `S${i + 1}`) },
  stories: kinds.map((k, i) => ({
    id: `S${i + 1}`,
    ...(k === null ? {} : { storyKind: k }),
    status: 'pending',
  })),
});

describe('the test WRITER covers every brownfield story — that is the point of it', () => {
  it('THE DRIFT: a novel story is selected for a dedicated test-writing pass', () => {
    const r = select('phase_stories_brownfield_scope', prdWith(['novel']));
    expect(r.status, 'the selector itself failed').toBe(0);
    expect(
      r.ids,
      'Step 3.54 is the ONLY step that authors a test in the brownfield path (Step 10 is ' +
        'skipped for all brownfield). Dropping novel here left the story with no test ' +
        'author, while team-lead-review.sh:436 still blocks it for missing tests. That ' +
        'deadlocked all three lanes on run 20260804T202338Z.',
    ).toEqual(['S1']);
  });

  it('a defect is still selected', () => {
    expect(select('phase_stories_brownfield_scope', prdWith(['defect'])).ids).toEqual(['S1']);
  });

  it('an unclassified story is still selected', () => {
    expect(select('phase_stories_brownfield_scope', prdWith([null])).ids).toEqual(['S1']);
  });

  it('a mixed phase selects all of them', () => {
    expect(select('phase_stories_brownfield_scope', prdWith(['defect', 'novel'])).ids).toEqual([
      'S1',
      'S2',
    ]);
  });
});

describe('the repro GATE stays narrow — a novel story has no bug to reproduce', () => {
  it('a novel story is NOT gated', () => {
    const r = select('phase_stories_for_repro_gate', prdWith(['novel']));
    expect(r.status).toBe(0);
    expect(
      r.ids,
      'fe5d6cb narrowed this correctly and must stay narrowed: the gate proves RED→GREEN ' +
        'against a pre-fix baseline, which a story with no prior bug can never satisfy',
    ).toEqual([]);
  });

  it('a defect IS gated', () => {
    expect(select('phase_stories_for_repro_gate', prdWith(['defect'])).ids).toEqual(['S1']);
  });

  it('an unclassified story IS gated — absent classification defaults to the safe side', () => {
    expect(
      select('phase_stories_for_repro_gate', prdWith([null])).ids,
      'treating "no storyKind" as novel would silently drop the gate for any story the ' +
        'spec pass failed to classify',
    ).toEqual(['S1']);
  });

  it('a mixed phase gates the defect only', () => {
    expect(select('phase_stories_for_repro_gate', prdWith(['defect', 'novel'])).ids).toEqual(['S1']);
  });
});

describe('the gate is a strict subset of the scope — never the other way round', () => {
  const kinds = ['defect', 'novel', null, 'defect'];
  it('every gated story is in scope, and novel is the only difference', () => {
    const scope = select('phase_stories_brownfield_scope', prdWith(kinds)).ids;
    const gated = select('phase_stories_for_repro_gate', prdWith(kinds)).ids;
    expect(gated.every((id) => scope.includes(id))).toBe(true);
    expect(scope.filter((id) => !gated.includes(id))).toEqual(['S2']);
  });
});

describe('phase scoping and bad input', () => {
  const twoPhase = {
    implementationOrder: { core: ['S1'], later: ['S2'] },
    stories: [
      { id: 'S1', storyKind: 'defect', status: 'pending' },
      { id: 'S2', storyKind: 'novel', status: 'pending' },
    ],
  };

  it('a story in ANOTHER phase is not selected into this one', () => {
    expect(select('phase_stories_brownfield_scope', twoPhase, 'core').ids).toEqual(['S1']);
    expect(select('phase_stories_brownfield_scope', twoPhase, 'later').ids).toEqual(['S2']);
  });

  it('an unknown phase selects nothing, without crashing', () => {
    const r = select('phase_stories_brownfield_scope', twoPhase, 'nope');
    expect(r.ids).toEqual([]);
    expect(r.status).toBe(0);
  });

  it('a malformed PRD selects nothing and does not emit a bare "null"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sel-bad-'));
    try {
      const p = join(dir, 'prd.json');
      writeFileSync(p, '{not json');
      const r = select('phase_stories_brownfield_scope', p);
      expect(
        r.status,
        'a missing function also emits nothing — assert the selector actually RAN, or ' +
          'this test passes while proving nothing (the trap fe5d6cb\'s own test fell into)',
      ).toBe(0);
      expect(
        r.ids,
        'a jq program that fails to parse produces no output, which must not be ' +
          'indistinguishable from a story literally named "null"',
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing PRD selects nothing, without crashing', () => {
    const r = select('phase_stories_brownfield_scope', '/nonexistent/prd.json');
    expect(r.ids).toEqual([]);
    expect(r.status).toBe(0);
  });
});

/**
 * THE REAL ARTEFACTS. The three lanes that deadlocked, exactly as they sit on disk.
 * Every one is storyKind "novel" — so before the fix, none of them had a test author.
 */
describe('against the three checkpoints that actually deadlocked', () => {
  for (const lane of ['gotransit', 'upexpress', 'metrolinx']) {
    it.skipIf(!existsSync(LIVE(lane)))(`${lane}: in writer scope, out of gate scope`, () => {
      expect(select('phase_stories_brownfield_scope', LIVE(lane)).ids).toEqual(['AMSD-2041']);
      expect(select('phase_stories_for_repro_gate', LIVE(lane)).ids).toEqual([]);
    });
  }
});

/**
 * WIRING. The behavioural tests above prove the selectors; these prove the orchestrator
 * asks the right one at each of the three call sites, and that no raw storyKind filter
 * survives at the writer site to re-create the drift.
 */
describe('the orchestrator asks the right question at each site', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SRC: string = require('node:fs').readFileSync(ORCH, 'utf8');

  const blockAround = (anchor: string, before: number, after: number) => {
    const i = SRC.indexOf(anchor);
    expect(i, `anchor moved: ${anchor}`).toBeGreaterThan(-1);
    return SRC.slice(Math.max(0, i - before), i + after);
  };

  it('Step 3.54 (the writer) selects the full brownfield scope', () => {
    const block = blockAround('brownfield-repro-test-writer.sh" "$_tw_story"', 200, 700);
    expect(block).toMatch(/phase_stories_brownfield_scope/);
    expect(
      block,
      'a raw storyKind filter at the writer site is the exact regression fe5d6cb introduced',
    ).not.toMatch(/storyKind/);
  });

  it('Step 3.55 (the gate) selects the narrower repro scope', () => {
    const block = blockAround('brownfield-repro-test-gate.sh" "$_rg_story"', 400, 2600);
    expect(block).toMatch(/phase_stories_for_repro_gate/);
  });

  it('vc-coverage is not nested inside the gate result, so novel reaches it', () => {
    const block = blockAround('vc-coverage-check.sh', 1200, 1600);
    expect(
      block,
      'vc-coverage sat in the else-branch of the repro gate, so every novel story — which ' +
        'the gate never selects — silently skipped coverage reporting too',
    ).toMatch(/phase_stories_brownfield_scope/);
  });
});
