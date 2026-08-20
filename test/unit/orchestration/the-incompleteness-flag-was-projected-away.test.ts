// THE PARSER SET THE FLAG, THE WRITER DELETED IT, AND THE GUARD READ FALSE FOREVER.
//
// Live metrolinx run 4, 2026-08-20. The reviewer produced 292 output tokens and an EMPTY string.
// team-lead-review-json.py did the right thing:
//
//     result = {'verdict': 'changes_requested', 'reviewIncomplete': True, 'issues': [...]}
//
// and its comment says exactly why the flag exists: "the orchestration loop keys on it to re-run
// the REVIEW instead of re-implementing a story nobody actually looked at."
//
// run-agent-orchestration.sh has that guard — review_feedback_is_incomplete() — and it reads
// `.reviewIncomplete // false` from review-feedback-<id>.json. But team-lead-review.sh writes that
// file with:
//
//     jq -c '{verdict, summary, issues}'
//
// The projection drops the flag. Not stale, not missing: DELETED between the component that sets it
// and the component that depends on it. So the guard evaluated false on every review that ever ran,
// and the writer was sent to fix feedback that did not exist — cycle 3 to 4 on a verdict nobody
// wrote.
//
// A signal produced correctly and discarded at a seam is worse than one never produced: the code
// reads as though the case is handled.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PARSER = join(SCRIPTS, 'lib/handlers/team-lead-review-json.py');
const REVIEW = join(SCRIPTS, 'team-lead-review.sh');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'incomplete-')); made.push(d); return d; };

/** The parser, fed what the model actually returned. */
function parse(raw: string): Record<string, unknown> {
  const r = spawnSync('python3', [PARSER], { input: raw, encoding: 'utf8' });
  return JSON.parse(r.stdout || '{}');
}

/** The projection team-lead-review.sh applies before writing the per-story feedback file. */
function writtenFeedback(reviewJson: Record<string, unknown>): Record<string, unknown> {
  const src = readFileSync(REVIEW, 'utf8');
  const m = /jq -c '(\{[^']*\})'\s*\\?\s*\n?\s*>\s*"\$\{LOG_DIR/.exec(src);
  expect(m, 'the per-story feedback write is no longer where this test looks').not.toBeNull();
  const r = spawnSync('jq', ['-c', m![1]], { input: JSON.stringify(reviewJson), encoding: 'utf8' });
  return JSON.parse(r.stdout || '{}');
}

/** Ask the ORCHESTRATOR's own guard, against a fixture LOG_DIR. */
function guardSaysIncomplete(feedback: Record<string, unknown>): boolean {
  const d = tmp();
  writeFileSync(join(d, 'review-feedback-S-1.json'), JSON.stringify(feedback));
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('review_feedback_is_incomplete() {');
  expect(start, 'the guard is gone').toBeGreaterThan(-1);
  let end = start;
  while (end < src.length && src.slice(end, end + 2) !== '\n}') end += 1;
  const fn = src.slice(start, end + 2);
  const r = spawnSync('bash', ['-c',
    `set -uo pipefail
     LOG_DIR=${JSON.stringify(d)}
     PHASE=core
     ${fn}
     review_feedback_is_incomplete && echo INCOMPLETE || echo COMPLETE`,
  ], { encoding: 'utf8' });
  return /INCOMPLETE/.test(r.stdout || '');
}

describe('the parser still refuses to invent a verdict', () => {
  it('an EMPTY response is marked incomplete — the live run-4 case', () => {
    const p = parse('');
    expect(p.verdict).toBe('changes_requested');
    expect(p.reviewIncomplete, 'nothing marks this as a review that did not happen').toBe(true);
  });

  it('a real verdict is not marked incomplete', () => {
    const p = parse(JSON.stringify({ verdict: 'approved', issues: [] }));
    expect(p.verdict).toBe('approved');
    expect(p.reviewIncomplete).toBeUndefined();
  });
});

describe('the flag survives the write', () => {
  it('the projection keeps reviewIncomplete', () => {
    const written = writtenFeedback(parse(''));
    expect(written.reviewIncomplete,
      'the flag is deleted between the parser that sets it and the guard that needs it').toBe(true);
  });

  it('and still carries what a real rejection needs', () => {
    const written = writtenFeedback({
      verdict: 'changes_requested', summary: 's', issues: [{ severity: 'blocker', description: 'd' }],
    });
    expect(written.verdict).toBe('changes_requested');
    expect(written.summary).toBe('s');
    expect(Array.isArray(written.issues)).toBe(true);
  });
});

describe('and the guard finally fires', () => {
  it('an incomplete review is reported as incomplete', () => {
    expect(guardSaysIncomplete(writtenFeedback(parse(''))),
      'the loop would re-implement against feedback nobody wrote').toBe(true);
  });

  it('a genuine rejection is NOT treated as incomplete', () => {
    // The re-implementation loop is how over-engineering gets corrected; it must not be disabled.
    const real = writtenFeedback({
      verdict: 'changes_requested', summary: 's',
      issues: [{ severity: 'blocker', description: 'unhandled promise rejection' }],
    });
    expect(guardSaysIncomplete(real)).toBe(false);
  });
});
