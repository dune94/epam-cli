/**
 * A GATE MUST READ THE FIELD THE PRODUCER ACTUALLY WRITES.
 *
 * THE DEFECT, live run 20260804T130402Z. The coordinator reviewed all three lanes and
 * returned needs_review on every one, qualityScore 0.45 — below the 0.7 bar. The
 * spec-review gate did not fire. Not because the verdict was missing: it was persisted,
 * on every lane, at
 *
 *     story.specification.coordinatorReview = { verdict, reviewNotes, qualityScore, ... }
 *
 * while spec_review_gate queried `.specReview`, a field NO producer anywhere writes. The
 * gate has never fired once since it was written.
 *
 * WHY THE EXISTING TEST DID NOT CATCH IT. spec-review-enforced.test.ts builds its PRD
 * fixture as `{ specReview: r }` — it hand-authored the fixture to match the gate. Test
 * and gate agreed with each other and both disagreed with the pipeline. Every assertion
 * passed, mutation testing passed, and the gate was dead on arrival. A fixture authored
 * from the consumer's assumption can only ever confirm that assumption.
 *
 * This is the fourth instance of one defect class — an agent produces output that never
 * lands where its consumer looks:
 *   - skill notes written to profiles.json, never read into the writer's prompt
 *   - review-rejection blockers never persisted to the writer's profile
 *   - specReview (this one)
 *   - acceptanceCriteria: speckit authors 10, the story keeps 0
 *
 * So this test does not assert a field NAME. It DERIVES the path from the producer's own
 * assignment statement and requires the gate to read that path — executing the real gate
 * against a PRD shaped the way the real producer shapes it. If the producer ever moves the
 * field, this test moves with it and the gate must follow. The two cannot drift apart
 * again, and no fixture here encodes anyone's assumption about the name.
 *
 * COSTS NOTHING TO RUN: no LLM call. The producer's shape comes from its source, the gate
 * is executed for real under bash. Live behaviour, zero tokens.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const GUARDS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const RUNNER_SRC = readFileSync(RUNNER, 'utf8');
const GUARDS_SRC = readFileSync(GUARDS, 'utf8');

/**
 * Where does the pipeline actually persist the coordinator's verdict? Derived from the
 * producer's assignment, never restated. Matches e.g.
 *     story.specification.coordinatorReview = {
 * and returns ['specification', 'coordinatorReview'].
 */
function producerVerdictPath(): string[] {
  const m = RUNNER_SRC.match(
    /^\s*(?:const\s+\w+\s*=\s*)?story\.((?:\w+\.)*\w*[Rr]eview\w*)\s*=\s*\{/m,
  );
  expect(
    m,
    'no `story.<...>Review = {` assignment found in spec-mode-runner.js — the producer ' +
      'moved or was removed, and this test can no longer derive the contract',
  ).toBeTruthy();
  return (m as RegExpMatchArray)[1].split('.');
}

/** Nest a value at a derived path: ['a','b'] + v -> { a: { b: v } }. */
function nest(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;
}

/** Run the REAL gate against a PRD. Returns the exit code and its output. */
function runGate(prd: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-contract-'));
  try {
    const prdFile = join(dir, 'prd.json');
    writeFileSync(prdFile, JSON.stringify(prd, null, 2));
    const script = join(dir, 'run.sh');
    writeFileSync(
      script,
      [
        'set -uo pipefail',
        // The guard library expects these from its caller.
        'log() { echo "$*"; }',
        'warning() { echo "WARN: $*"; }',
        'error() { echo "ERROR: $*" >&2; }',
        'success() { echo "OK: $*"; }',
        `source ${JSON.stringify(GUARDS)}`,
        `spec_review_gate ${JSON.stringify(prdFile)}`,
        'echo "EXIT:$?"',
      ].join('\n'),
    );
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ...env },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const code = Number((out.match(/EXIT:(\d+)/) || [])[1] ?? -1);
    return { code, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A story carrying a verdict at the path the PRODUCER writes it to.
 *
 * `flags` defaults to EMPTY on purpose. An earlier version of this fixture stamped
 * missing_manifest_path on every story — which, once that flag became blocking, meant even
 * the "an approved, high-quality review PASSES" case carried a hard blocker. The fixture,
 * not the gate, was wrong. See spec-review-blocking-policy.test.ts for flag behaviour.
 */
function storyWithVerdict(verdict: string, qualityScore: number | null, flags: unknown[] = []) {
  return {
    id: 'ST-1',
    status: 'pending',
    ...nest(producerVerdictPath(), {
      verdict,
      reviewNotes: 'the declared file set could not be confirmed',
      qualityScore,
      flags,
      reviewedAt: '2026-08-04T13:11:00.000Z',
    }),
  };
}

describe('the spec-review gate reads the path the producer writes', () => {
  it('the producer path is derivable (guard against a vacuous pass)', () => {
    const p = producerVerdictPath();
    expect(p.length).toBeGreaterThan(0);
    expect(p.join('.')).toMatch(/[Rr]eview/);
  });

  it('THE LIVE DEFECT: a needs_review verdict, persisted as the pipeline persists it, BLOCKS', () => {
    const { code, out } = runGate({ stories: [storyWithVerdict('needs_review', 0.45, [{ flag: 'missing_fix_site', severity: 'blocking' }])] }, { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_fix_site' });
    expect(
      code,
      'the gate passed a story the reviewer refused. Live, all three lanes returned ' +
        `needs_review at .${producerVerdictPath().join('.')} and every one sailed through — ` +
        'the gate queries a field no producer writes.\n' + out,
    ).not.toBe(0);
  });

  it('a low quality score alone does NOT block — it is telemetry', () => {
    // POLICY CHANGE 2026-08-07 (operator decision): qualityScore is TELEMETRY and never
    // gates. Unlike a flag, a verdict or a missing manifest path it is not a claim about
    // anything, so it can be neither structurally constrained nor independently re-checked
    // — the treatment every other model assertion here now gets. It was the DEFAULT blocker
    // while the specific enumerable signal defaulted to empty, so the only thing that could
    // stop a run was the one thing nobody could interrogate: a lane halted on a 0.02 margin
    // while two cleared. What blocks now is a needs_review verdict carrying at least one
    // flag, plus the deterministic missing-manifest-path check.
    const { code } = runGate({ stories: [storyWithVerdict('approved', 0.45)] });
    expect(code, 'a scalar nobody can interrogate still stops a run').toBe(0);
  });

  it('the score is still REPORTED at the producer\'s path, so a degrading reviewer is visible', () => {
    const { out } = runGate({ stories: [storyWithVerdict('needs_review', 0.45)] });
    expect(out).toMatch(/0\.45/);
  });

  it('an approved, high-quality review PASSES — the gate is not simply always-on', () => {
    const { code, out } = runGate({ stories: [storyWithVerdict('approved', 0.95)] });
    expect(code, `a clean review was blocked:\n${out}`).toBe(0);
  });

  it('the gate NAMES the offending story, so the failure is actionable', () => {
    const { out } = runGate({ stories: [storyWithVerdict('needs_review', 0.45, [{ flag: 'missing_fix_site', severity: 'blocking' }])] }, { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_fix_site' });
    expect(out).toContain('ST-1');
  });

  it('a story with NO review does not block — a resumed run skips the spec pass', () => {
    const { code } = runGate({ stories: [{ id: 'ST-1', status: 'pending' }] });
    expect(code).toBe(0);
  });

  it('a null qualityScore does not block — absent is not zero', () => {
    const { code } = runGate({ stories: [storyWithVerdict('approved', null)] });
    expect(code).toBe(0);
  });

  it('a deprecated story is ignored even when flagged', () => {
    const s = { ...storyWithVerdict('needs_review', 0.1, [{ flag: 'missing_fix_site', severity: 'blocking' }]), status: 'deprecated' };
    expect(runGate({ stories: [s] }).code).toBe(0);
  });

  it('SPEC_REVIEW_ENFORCE=0 turns it off deliberately', () => {
    const { code } = runGate(
      { stories: [storyWithVerdict('needs_review', 0.45)] },
      { SPEC_REVIEW_ENFORCE: '0' },
    );
    expect(code).toBe(0);
  });

  it('a project may NARROW which flags block, without touching the engine', () => {
    const { code } = runGate(
      { stories: [storyWithVerdict('needs_review', 0.95, ['style_nit'])] },
      { SPEC_REVIEW_BLOCKING_FLAGS: 'missing_fix_site' });
    expect(code, 'an unlisted flag blocked despite the project narrowing the set').toBe(0);
  });

  it('the gate does NOT query a field no producer writes', () => {
    // Every `.<field>` the gate selects on must be reachable in the producer.
    const queried = [...GUARDS_SRC.matchAll(/select\(\s*\.(\w+)\s*!=\s*null\s*\)/g)]
      .map((m) => m[1]);
    for (const field of queried) {
      if (!/review/i.test(field)) continue;
      expect(
        RUNNER_SRC.includes(`story.${field}`) || RUNNER_SRC.includes(`.${field} =`),
        `the gate branches on ".${field}", which nothing in spec-mode-runner.js ever ` +
          'assigns — a gate reading a field no producer writes can never fire',
      ).toBe(true);
    }
  });
});

/**
 * THE CLASS, not the instance. Four separate defects have now been "the producer wrote it
 * somewhere the consumer never looks". This enumerates the seam so the fifth is caught
 * before a run, not by one.
 */
describe('every verdict the pipeline persists is reachable by a consumer', () => {
  it('finds the producer assignments (guard against a vacuous pass)', () => {
    const assigns = [...RUNNER_SRC.matchAll(/story\.((?:\w+\.)*\w*[Rr]eview\w*)\s*=\s*\{/g)];
    expect(
      assigns.length,
      'no review-shaped assignments found at all, so the assertions below prove nothing',
    ).toBeGreaterThan(0);
  });

  it('the gate library references the SAME path the producer assigns', () => {
    const path = producerVerdictPath().join('.');
    expect(
      GUARDS_SRC,
      `the producer writes the verdict to story.${path}, but no guard mentions that path. ` +
        'A verdict nothing reads is the same as no verdict at all.',
    ).toContain(path);
  });
});
