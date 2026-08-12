/**
 * NOTHING RUN-SCOPED SURVIVES A RUN. THE OPERATOR NEVER GRANTED PERMISSION FOR ANY OF IT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * review-feedback-<story>.json is written when a team-lead review REQUESTS CHANGES, and
 * deleted only when a LATER review APPROVES. Its own comment states the intended contract:
 * "Consumed + deleted by claude.sh once applied." So its cleanup depends on a success that may
 * never come.
 *
 * Live: review-feedback-AMSD-2041.json was written 2026-08-09 08:26 and was still being read on
 * 2026-08-12. THREE DAYS. Every writer attempt in every run since was handed it under the
 * heading:
 *
 *     "## Reviewer Feedback — ADDRESS THESE
 *      The team-lead reviewer examined YOUR PREVIOUS ATTEMPT and requested the changes below.
 *      This is the highest priority."
 *
 * It was not the previous attempt. It was a different run, against code that no longer existed.
 * Its blockers said "ContentstackProvider was NOT modified at all (git_state confirms no change
 * to this file)" — TRUE ON AUGUST 9, false every run since — and demanded a dependency
 * (@contentstack/live-preview-sdk) that does not exist. The writer followed all of it, at
 * highest priority, and was blamed for "over-reaching".
 *
 * NOT A HARDCODING DEFECT: the path is derived, "${LOG_DIR}/review-feedback-${story_id}.json".
 * It is a LIFECYCLE defect, and it violates the operator's standing Clean Slate invariant —
 * "PRD + review artifacts reset every run" — which pre-run-reset.sh does not implement for this
 * file, or for anything else it does not individually remember.
 *
 * THE RULE: the reset enumerates run-scoped state BY PATTERN, never by a list of names that
 * goes stale. That is the same correction made to the ladder state earlier the same day, which
 * is exactly why a newly-added .effiter file was covered automatically.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the reset's run-artifact sweep against a real directory of leftovers. */
function sweep(files: string[]): string[] {
  const d = mkdtempSync(join(tmpdir(), 'runartifacts-')); dirs.push(d);
  for (const f of files) writeFileSync(join(d, f), '{}');

  const src = readFileSync(RESET, 'utf8');
  const start = src.indexOf('_RUN_ARTIFACT_DIR=');
  expect(start, 'the run-artifact sweep does not exist yet — that is what this test is for')
    .toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf('\nfi\n', start) + 4);

  const script = [
    "RED=''; GREEN=''; YELLOW=''; NC=''",
    'info() { :; }', 'success() { :; }', 'fail() { echo "$*" >&2; exit 1; }',
    `LOG_DIR='${d}'`,
    block,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, `sweep failed: ${r.stderr}`).toBe(0);
  return existsSync(d) ? readdirSync(d).sort() : [];
}

describe('the harness is real — otherwise every assertion is vacuous', () => {
  it('a file the sweep should NOT touch survives it', () => {
    // Proves the sweep runs and is selective, not a blanket delete of the log directory.
    expect(sweep(['agent-status.json'])).toContain('agent-status.json');
  });
});

describe('THE DEFECT: REVIEW FEEDBACK IS RUN-SCOPED AND MUST NOT SURVIVE', () => {
  it('review-feedback-<story>.json is cleared', () => {
    expect(sweep(['review-feedback-AMSD-2041.json']),
      'a rejected review from a previous RUN is handed to the writer as "your previous attempt"')
      .toEqual([]);
  });

  it('cleared for ANY story id — the pattern is not a name list', () => {
    expect(sweep([
      'review-feedback-AMSD-2041.json',
      'review-feedback-PROJ-1.json',
      'review-feedback-anything-at-all.json',
    ])).toEqual([]);
  });
});

describe('IT SWEEPS BY PATTERN, SO TOMORROW\'S ARTIFACT IS COVERED TOO', () => {
  it('a run-scoped artifact type that does not exist yet is still cleared', () => {
    // The assertion an allow-list cannot satisfy. pre-run-reset has now been caught TWICE
    // enumerating specific names: '*.count' while .model and .iterbump survived, and the
    // PRD/roster while review feedback survived.
    expect(sweep(['review-feedback-X.json', 'review-somethingaddedlater-X.json'])).toEqual([]);
  });
});

describe('THE RESET SAYS WHAT IT DID, AND FAILS IF IT COULD NOT', () => {
  it('leftovers it cannot remove abort the run rather than being announced as clean', () => {
    // Proceeding here means starting a run on another run's state, which is the whole defect.
    const src = readFileSync(RESET, 'utf8');
    const start = src.indexOf('_RUN_ARTIFACT_DIR=');
    const block = src.slice(start, src.indexOf('\nfi\n', start) + 4);
    // fail_contamination, specifically: plain fail() exits 1, which every launcher's `|| info`
    // swallowed as "Docker unavailable, continuing". Detection without enforcement.
    expect(block).toMatch(/fail_contamination /);
  });
});

describe('AND THE CONSUMER STILL TREATS IT AS THIS RUN\'S FEEDBACK', () => {
  it('the writer prompt calls it "your previous attempt" — so it MUST be this run\'s', () => {
    // Kept as a standing reminder of why the lifetime matters: the prompt asserts recency it
    // cannot verify, so the reset is the only thing that can make the claim true.
    const claude = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(claude).toMatch(/review-feedback-\$\{story_id\}\.json/);
    expect(claude).toMatch(/previous attempt/i);
  });
});
