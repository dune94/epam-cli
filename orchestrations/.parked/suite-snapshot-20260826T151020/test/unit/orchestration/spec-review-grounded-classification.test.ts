/**
 * THE REVIEWER'S CLASSIFICATION WAS UNGROUNDED IN THREE SEPARATE WAYS.
 *
 * Measured 2026-08-04 by sending the SAME prompt to the real model four times:
 *
 *   current prompt        0.55  0.72  0.60  0.72     spread 0.17
 *   + verificationCriteria 0.70  0.73  0.65  0.72     spread 0.08
 *
 * On byte-identical input the gate outcome was a coin flip: two of four samples fell below
 * the 0.7 bar and two cleared it. Three causes, each fixed here.
 *
 * 1. THE REVIEWER COULD NOT SEE WHAT IT WAS GRADING. reviewPayload sent
 *    {id, title, acceptanceCriteria, specification}. verificationCriteria lives on the
 *    story ROOT, not inside .specification — so on a brownfield ticket, where the AC array
 *    is empty by policy, the reviewer received a title and some prose and was asked to
 *    score the spec. The VCs ARE the deliverable there. The reviewer said so itself:
 *    gotransit's run-3 flag was literally "vc_not_visible_in_notes".
 *
 * 2. qualityScore HAD NO DEFINITION. The entire specification of it in the prompt was
 *    `"qualityScore":0.0-1.0`. No rubric, no anchors. The gate then hard-blocked below
 *    0.7 — a threshold on a number the model was never told how to compute.
 *
 * 3. THE BLOCKING FLAG COULD BE HALLUCINATED. In one of four samples the model returned
 *    "missing_manifest_path" while the evidence block listed EXISTS for every path. That
 *    flag is a hard blocker, so a hallucination halts a run whose manifest is perfectly
 *    valid — indistinguishable from a real defect.
 *
 * The fix for (3) is the principle this engine already relies on elsewhere: we ALREADY
 * know the answer deterministically. fs.existsSync cannot hallucinate. The gate blocks on
 * OUR computation, recorded to the PRD; the model's flag is corroboration, never the
 * trigger.
 *
 * Nothing here names a project, codeline or vendor. No LLM tokens: the payload builder and
 * path checker are executed directly, and the gate is executed for real under bash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { templateBody } from '../../helpers/prompt-text';

const REPO_ROOT = join(__dirname, '../../../');
const GUARDS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildReviewPayload, manifestMissingPaths, manifestEvidence } = spec;

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grounded-review-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'RealFile.ts'), 'export const x = 1;\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const prd = () => ({ project: { outputDir: dir } });

const story = (files: string[], vcs: string[] = ['the behaviour is observable']) => ({
  id: 'ST-1',
  title: 'A capability described in the ticket',
  acceptanceCriteria: [],
  verificationCriteria: vcs,
  technicalNotes: { files },
  specification: { coordinatorNotes: 'some prose from the agents' },
});

// ── 1. The reviewer must be shown the deliverable ───────────────────────────────
describe('the review payload carries what the reviewer is asked to judge', () => {
  it('REPRODUCES THE GAP: verificationCriteria reach the reviewer', () => {
    const payload = buildReviewPayload([story(['src/RealFile.ts'])], true);
    expect(
      payload,
      'on a brownfield ticket the AC array is empty by policy, so the VCs are the only ' +
        'substance there is. Judging spec quality without them is guessing from prose — ' +
        'measured spread 0.17 on identical input, and the reviewer flagged ' +
        '"vc_not_visible_in_notes" itself.',
    ).toMatch(/verificationCriteria/);
    expect(payload).toContain('the behaviour is observable');
  });

  it('still carries the fields it always did', () => {
    const payload = buildReviewPayload([story(['src/RealFile.ts'])], true);
    for (const key of ['id', 'title', 'acceptanceCriteria', 'specification']) {
      expect(payload, `${key} was dropped`).toMatch(new RegExp(`"${key}"`));
    }
  });

  it('carries the declared file set — the manifest is part of what is under review', () => {
    const payload = buildReviewPayload([story(['src/RealFile.ts'])], true);
    expect(payload).toContain('src/RealFile.ts');
  });

  it('a greenfield review still gets splitChildren; brownfield does not', () => {
    const parent = { ...story(['src/RealFile.ts']), id: 'P1' };
    const green = buildReviewPayload([parent], false, [
      { id: 'C1', title: 'child', acceptanceCriteria: ['a'], specification: { createdFrom: 'P1' } },
    ]);
    expect(green).toMatch(/splitChildren/);
    expect(buildReviewPayload([parent], true, [])).not.toMatch(/splitChildren/);
  });

  it('is valid JSON — a malformed payload would poison the whole review', () => {
    expect(() => JSON.parse(buildReviewPayload([story(['src/RealFile.ts'])], true))).not.toThrow();
  });

  it('a story with no VCs does not break the payload', () => {
    expect(() => JSON.parse(buildReviewPayload([story(['src/RealFile.ts'], [])], true))).not.toThrow();
  });
});

// ── 3. The missing-path fact is OURS, not the model's ───────────────────────────
describe('missing manifest paths are computed, never taken on the model\'s word', () => {
  it('finds a genuinely missing path', () => {
    const missing = manifestMissingPaths([story(['src/nope.ts'])], prd());
    expect(missing).toContainEqual({ storyId: 'ST-1', file: 'src/nope.ts' });
  });

  it('reports NOTHING when every path exists', () => {
    expect(manifestMissingPaths([story(['src/RealFile.ts'])], prd())).toEqual([]);
  });

  it('agrees with the evidence text the reviewer is shown — one source of truth', () => {
    const s = [story(['src/RealFile.ts', 'src/nope.ts'])];
    const evidence = manifestEvidence(s, prd());
    const missing = manifestMissingPaths(s, prd());
    expect(evidence).toMatch(/EXISTS\s+src\/RealFile\.ts/);
    expect(evidence).toMatch(/MISSING/);
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe('src/nope.ts');
  });

  it('a story declaring no files reports no missing paths (that is a different defect)', () => {
    expect(manifestMissingPaths([story([])], prd())).toEqual([]);
  });
});

// ── The gate acts on the computed fact ──────────────────────────────────────────
describe('the gate blocks on the computed fact, not the model\'s flag', () => {
  function runGate(storyObj: unknown, env: Record<string, string> = {}) {
    const d = mkdtempSync(join(tmpdir(), 'gate-grounded-'));
    try {
      const prdFile = join(d, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({ stories: [storyObj] }));
      const script = join(d, 'g.sh');
      writeFileSync(script, [
        'set -uo pipefail',
        'log(){ echo "$*"; }; info(){ echo "$*"; }; warning(){ echo "WARN: $*"; }',
        'error(){ echo "ERROR: $*" >&2; }; success(){ echo "$*"; }',
        `source ${JSON.stringify(GUARDS)}`,
        `spec_review_gate ${JSON.stringify(prdFile)}`,
        'echo "EXIT:$?"',
      ].join('\n'));
      const r = spawnSync('bash', [script], {
        encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env },
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      return { code: Number((out.match(/EXIT:(\d+)/) || [])[1] ?? -1), out };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  const withCheck = (missing: unknown[], review: Record<string, unknown>) => ({
    id: 'ST-1',
    status: 'pending',
    specification: {
      manifestCheck: { missing, checkedAt: '2026-08-04T15:00:00Z' },
      coordinatorReview: { verdict: 'needs_review', qualityScore: 0.9, flags: [], ...review },
    },
  });

  it('THE HALLUCINATION: the model cries missing_manifest_path but nothing is missing → PASSES', () => {
    const { code, out } = runGate(withCheck([], { flags: ['missing_manifest_path'] }));
    expect(
      code,
      'a hallucinated flag halted a run whose manifest was fully verified. Measured 1 in 4 ' +
        'samples with an all-EXISTS evidence block.\n' + out,
    ).toBe(0);
  });

  it('but it is REPORTED — a model contradicting the filesystem is worth knowing about', () => {
    const { out } = runGate(withCheck([], { flags: ['missing_manifest_path'] }));
    expect(out).toMatch(/missing_manifest_path|advisory/i);
  });

  it('THE REAL CONDITION: a computed missing path BLOCKS, even with a clean review', () => {
    const { code, out } = runGate(withCheck(
      [{ storyId: 'ST-1', file: 'src/nope.ts' }],
      { verdict: 'approved', qualityScore: 0.99, flags: [] },
    ));
    expect(
      code,
      'a manifest naming a file that does not exist reached the writer despite the ' +
        `filesystem saying so. That is the ~2M-token condition.\n${out}`,
    ).not.toBe(0);
  });

  it('the block NAMES the missing path, so it is actionable', () => {
    const { out } = runGate(withCheck([{ storyId: 'ST-1', file: 'src/nope.ts' }], {}));
    expect(out).toContain('src/nope.ts');
  });

  it('an ABSENT manifestCheck does not block — absent is not zero, as a resume needs', () => {
    const { code } = runGate({
      id: 'ST-1', status: 'pending',
      specification: { coordinatorReview: { verdict: 'approved', qualityScore: 0.9, flags: [] } },
    });
    expect(code).toBe(0);
  });

  // SUPERSEDED 2026-08-07: qualityScore is telemetry and never gates. It is a number the
  // reviewer invents, unverifiable in the way a computed check or a project-declared flag is
  // not — and as the default blocker it halted a lane on a 0.02 margin while two cleared. The
  // rule this test guards (the gate blocks on the computed fact, not the model's flag) is
  // unchanged and still covered by its siblings.

  it('SPEC_REVIEW_ENFORCE=0 still turns everything off', () => {
    const { code } = runGate(
      withCheck([{ storyId: 'ST-1', file: 'src/nope.ts' }], {}),
      { SPEC_REVIEW_ENFORCE: '0' },
    );
    expect(code).toBe(0);
  });
});

// ── 2. qualityScore must mean something ─────────────────────────────────────────
describe('qualityScore is defined for the model that has to produce it', () => {
  // The reviewer's own prompt. This read spec-mode-runner.js when the rubric was a literal
  // inside it; the rubric is the coordinator-review template now, and the script that renders
  // it contains none of the wording.
  const SRC = templateBody('spec-coordinator-review');

  it('the prompt gives NUMERIC ANCHORS, not a bare 0.0-1.0 range', () => {
    expect(
      SRC,
      'the only guidance was `"qualityScore":0.0-1.0`, while the gate hard-blocks below ' +
        '0.7 — a threshold on a number the model was never told how to compute. Measured ' +
        'spread on identical input: 0.17.',
    ).toMatch(/QUALITY SCORE|qualityScore means|0\.9\s*=|0\.7\s*=/);
  });

  it('the anchor text names what the gate actually enforces', () => {
    const i = SRC.search(/QUALITY SCORE/);
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 900)).toMatch(/0\.7/);
  });

  it('it tells the model NOT to lower the score for things it cannot see', () => {
    const i = SRC.search(/QUALITY SCORE/);
    expect(
      SRC.slice(i, i + 900),
      'every low score so far cited "speckit could not read the source files" — an ' +
        'unavoidable condition being priced into the score every run',
    ).toMatch(/could not read|unable to read|cannot see|do not lower/i);
  });
});
