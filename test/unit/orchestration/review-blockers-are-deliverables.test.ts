/**
 * A BLOCKER IS A DELIVERABLE, NOT ADVICE.
 *
 * Live 2026-08-07, run 20260807T015510Z resumed to the writer. The team-lead reviewer
 * rejected three consecutive cycles with one blocker-severity finding:
 *
 *   "The sole blocker-level concern is missing test coverage: no tests were added to the
 *    existing test file."
 *
 * No test file was ever created — confirmed against the branch afterwards — and cycle 4
 * APPROVED anyway. The story was marked complete with nothing verifying it.
 *
 * The writer was not ignoring the reviewer. It was obeying the paragraph wrapped around the
 * feedback, which ended:
 *
 *   "...make the SMALLEST edits that resolve each point. If a point says the change is
 *    over-engineered ... REMOVE the excess and use the minimal approach — DO NOT ADD MORE CODE."
 *
 * A blocker demanding a NEW test file was handed to the writer inside an instruction telling
 * it not to add code, in one flat list beside advisory notes about over-engineering. Both
 * instructions were followed; they contradicted each other, and the required one lost.
 *
 * So: blockers render in their own section, and minimality is scoped to HOW MUCH is written
 * rather than WHETHER. The writer may also decline a blocker explicitly with a reason — an
 * unexplained omission is what produced three silent repeats.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real feedback shape the team-lead reviewer writes. */
const FEEDBACK = {
  verdict: 'changes_requested',
  summary: 'The implementation is minimal and correct.',
  issues: [
    { severity: 'blocker', description: 'No tests were added to the existing test file for the new behaviour.', file: 'src/services/contentstack.test.ts' },
    { severity: 'major', description: 'Existing any-typed fields could be narrowed.', file: 'src/services/contentstack.ts', line: 103 },
  ],
};

/** Run the REAL jq the prompt builder runs, against a real feedback file. */
function renderFeedback(feedback: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'rf-')); dirs.push(dir);
  const f = join(dir, 'review-feedback-T-1.json');
  writeFileSync(f, JSON.stringify(feedback, null, 2));
  // The jq program, lifted from claude.sh so the test exercises the shipped expression.
  const i = SRC.indexOf('review_feedback=$(jq -r ');
  expect(i, 'the feedback renderer moved').toBeGreaterThan(-1);
  const prog = SRC.slice(SRC.indexOf("'", i) + 1, SRC.indexOf("' \"$_review_feedback_file\"", i));
  const r = spawnSync('jq', ['-r', prog, f], { encoding: 'utf8' });
  expect(r.status, `jq failed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

describe('blockers are rendered as required, separately from advice', () => {
  const out = renderFeedback(FEEDBACK);

  it('the renderer produces something — otherwise everything below is vacuous', () => {
    expect(out.trim().length).toBeGreaterThan(20);
  });

  it('THE FIX: blockers get their own section saying the attempt is rejected until resolved', () => {
    expect(out, 'a required deliverable still reads like a suggestion').toMatch(/BLOCKERS/);
    expect(out).toMatch(/REJECTED until every one is resolved/i);
  });

  it('the blocker appears above the advisory finding', () => {
    expect(out.indexOf('No tests were added')).toBeLessThan(out.indexOf('any-typed fields'));
  });

  it('advisory findings are still carried, just not as requirements', () => {
    expect(out).toMatch(/Advisory/);
    expect(out).toContain('any-typed fields');
  });

  it('file and line are preserved for both', () => {
    expect(out).toContain('src/services/contentstack.test.ts');
    expect(out).toContain('src/services/contentstack.ts:103');
  });

  it('a feedback file with only advisory findings renders no blocker heading', () => {
    const only = renderFeedback({ issues: [{ severity: 'major', description: 'narrow the type' }] });
    expect(only).not.toMatch(/BLOCKERS/);
    expect(only).toMatch(/Advisory/);
  });

  it('an empty issues list renders nothing rather than empty headings', () => {
    expect(renderFeedback({ issues: [] }).trim()).toBe('');
  });
});

describe('the instruction around the feedback no longer forbids what a blocker requires', () => {
  it('THE CONTRADICTION IS GONE: it does not tell the writer to add no code', () => {
    const i = SRC.indexOf('## Reviewer Feedback — ADDRESS THESE');
    expect(i, 'the feedback preamble moved').toBeGreaterThan(-1);
    const preamble = SRC.slice(i, i + 1600);
    expect(
      preamble,
      'a blocker demanding a new test file was delivered inside "do not add more code"',
    ).not.toMatch(/do not add more code/i);
  });

  it('it says a blocker naming something MISSING is resolved only by creating it', () => {
    const i = SRC.indexOf('## Reviewer Feedback — ADDRESS THESE');
    const preamble = SRC.slice(i, i + 1600);
    expect(preamble).toMatch(/BLOCKER is a required deliverable/i);
    expect(preamble).toMatch(/CREATE it/);
  });

  it('minimality is scoped to how much, not whether', () => {
    const i = SRC.indexOf('## Reviewer Feedback — ADDRESS THESE');
    expect(SRC.slice(i, i + 1600)).toMatch(/HOW MUCH you write, never WHETHER/);
  });

  it('minimality still applies to advisory points — this is not licence to add code', () => {
    const i = SRC.indexOf('## Reviewer Feedback — ADDRESS THESE');
    const preamble = SRC.slice(i, i + 1600);
    expect(preamble).toMatch(/smallest edits/i);
    expect(preamble).toMatch(/REMOVE the excess/);
  });

  it('an impossible blocker must be declined out loud, not silently skipped', () => {
    const i = SRC.indexOf('## Reviewer Feedback — ADDRESS THESE');
    const preamble = SRC.slice(i, i + 1600);
    expect(preamble).toMatch(/cannot satisfy a blocker/i);
    expect(preamble, 'silence is what produced three identical rejections').toMatch(/unexplained omission/i);
  });
});

/**
 * AND AN APPROVAL THAT FOLLOWS AN UNRESOLVED BLOCKER, WITH THE CODE UNCHANGED, IS A GIVE-UP.
 *
 * The same run: blocker on cycles 1, 2 and 3; no test file ever created; cycle 4 APPROVED and
 * the story was marked complete. The loop approves on the reviewer's exit code alone, so
 * nothing compared the verdict against whether anything had actually changed.
 *
 * The rule needs no vocabulary and reads nothing about what the blocker SAID: if the previous
 * cycle rejected with a blocker and the codeline is byte-identical now, the verdict changed
 * while the code did not. A reworded blocker or a reworded approval cannot fool it.
 */
describe('an approval after an unresolved blocker is refused', () => {
  const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
  const OSRC = readFileSync(ORCH, 'utf8');

  /** Run the shipped decision function directly. */
  function isGiveUp(prevBlocker: string, prevFp: string, nowFp: string): boolean {
    const i = OSRC.indexOf('_review_approval_is_giveup() {');
    expect(i, 'the decision function moved').toBeGreaterThan(-1);
    const fn = OSRC.slice(i, OSRC.indexOf('\n}\n', i) + 3);
    const r = spawnSync('bash', ['-c',
      `${fn}\n_review_approval_is_giveup ${JSON.stringify(prevBlocker)} ${JSON.stringify(prevFp)} ${JSON.stringify(nowFp)}`]);
    return r.status === 0;
  }

  it('THE CASE: blocker last cycle + identical tree = give-up', () => {
    expect(isGiveUp('1', 'abc123', 'abc123')).toBe(true);
  });

  it('blocker last cycle but the code CHANGED = a real fix, approve', () => {
    expect(isGiveUp('1', 'abc123', 'def456')).toBe(false);
  });

  it('no blocker last cycle = an ordinary approval, whatever the tree', () => {
    expect(isGiveUp('0', 'abc123', 'abc123')).toBe(false);
  });

  it('a first-cycle approval has no previous state and is not a give-up', () => {
    expect(isGiveUp('0', '', '')).toBe(false);
    expect(isGiveUp('1', '', 'abc123')).toBe(false);
  });

  it('the loop actually calls it before accepting an approval', () => {
    const i = OSRC.indexOf('team-lead-review.sh" "$PHASE"; then');
    const after = OSRC.slice(i, i + 900);
    expect(after, 'the check exists but the approval path does not consult it')
      .toMatch(/_review_approval_is_giveup/);
    expect(after, 'it must escalate rather than approve').toMatch(/Escalating instead of approving/);
  });

  it('UNKNOWN is not UNCHANGED: a greenfield run with no codeline root is never a give-up', () => {
    // The sentinel is a constant, so without this guard every post-blocker approval in a run
    // with no JIRA_CODELINE_ROOT would be condemned — a false positive that would break
    // greenfield entirely.
    expect(isGiveUp('1', 'no-codeline-root', 'no-codeline-root')).toBe(false);
  });

  it('the fingerprint covers the codeline, not the engine repo', () => {
    const i = OSRC.indexOf('_review_tree_fingerprint() {');
    const fn = OSRC.slice(i, OSRC.indexOf('\n}\n', i));
    expect(fn).toMatch(/JIRA_CODELINE_ROOT/);
    expect(fn, 'a diff of the engine repo would change on every log write').toMatch(/git -C/);
  });

  it('no codeline root yields a stable sentinel rather than an empty match', () => {
    const i = OSRC.indexOf('_review_tree_fingerprint() {');
    const fn = OSRC.slice(i, OSRC.indexOf('\n}\n', i) + 3);
    const r = spawnSync('bash', ['-c', `JIRA_CODELINE_ROOT= ${''}\n${fn}\n_review_tree_fingerprint`], { encoding: 'utf8' });
    expect(r.stdout.trim(), 'two empty fingerprints would compare equal and fake a give-up').toBe('no-codeline-root');
  });
});
