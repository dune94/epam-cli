// THE REVIEWER APPROVED A BLOCKER IT HAD RAISED, BECAUSE IT WAS NEVER TOLD IT HAD RAISED ONE.
//
// Live metrolinx AMSD-2041, run 2, 2026-08-20:
//
//   [ERROR] Step 3.6: review APPROVED after a blocker-level rejection, with the codeline UNCHANGED
//   [ERROR] Step 3.6: the verdict changed and the code did not — the blocker was never resolved.
//                     Escalating instead of approving.
//   run-agent-orchestration.sh: line 8051: _escalate_story_review: command not found
//
// team-lead-review.sh is the ONLY reviewer the pipeline actually executes — run-agent-
// orchestration.sh:8045 is its single call site, and code-review-cycle.sh is referenced only in
// comments and provenance lines. Its prompt values are:
//
//   __REVIEW_PROFILE__ __BLOCKER_DISCIPLINE__ __TEST_OWNERSHIP__ __STORY_ID__ __STORY_TITLE__
//   __STORY_DESC__ __STORY_ACS__ __STORY_DIFF__ __STORY_FILES__ __TEST_FILES__ __PROJECT_ROOT__
//   __FIX_ANALYSIS_BLOCK__ __UNCOVERED_VC_BLOCK__ __VC_BLOCK__ __CODEGRAPH_TOOL_BLOCK__
//   __LEARNED_RULES_BLOCK__ __PROJECT_TOOLS_BLOCK__
//
// No prior verdicts. No iteration number. Zero occurrences of PRIOR or __ITERATION__ in the whole
// script. So every cycle reviews as if for the first time: it did not change its mind, it never
// knew. Consistency was impossible by construction, and the guard that noticed called an
// escalation function that does not exist.
//
// The record already exists and is append-only: code-reviews.jsonl, written with `>>` at
// team-lead-review.sh:769. The reviewer simply was never shown its own history.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/prior-reviews.py');
const REVIEWER = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/team-lead-review.json');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function logWith(records: Record<string, unknown>[]): string {
  const d = mkdtempSync(join(tmpdir(), 'prior-rev-')); made.push(d);
  const p = join(d, 'code-reviews.jsonl');
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

const priorFor = (log: string, story: string): string => {
  const r = spawnSync('python3', [HANDLER, log, story], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`handler exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};

const rec = (o: Record<string, unknown>) => ({ story: 'S-1', ...o });

describe('the reviewer is handed its own history', () => {
  it('a handler exists to produce it', () => {
    expect(() => priorFor(logWith([]), 'S-1')).not.toThrow();
  });

  it('reports nothing when the story has no prior review', () => {
    expect(priorFor(logWith([]), 'S-1').trim()).toBe('');
  });

  it('surfaces an unresolved blocker from an earlier verdict', () => {
    const log = logWith([
      rec({ verdict: 'changes_requested', issues: [{ severity: 'blocker', description: 'hand-rolls query building' }] }),
    ]);
    const out = priorFor(log, 'S-1');
    expect(out).toMatch(/blocker/i);
    expect(out).toMatch(/hand-rolls query building/);
  });

  it('ignores other stories', () => {
    const log = logWith([
      { story: 'OTHER', verdict: 'changes_requested', issues: [{ severity: 'blocker', description: 'not mine' }] },
    ]);
    expect(priorFor(log, 'S-1')).not.toMatch(/not mine/);
  });

  it('keeps the ORDER of verdicts so the latest state is visible', () => {
    const log = logWith([
      rec({ verdict: 'changes_requested', issues: [{ severity: 'blocker', description: 'first problem' }] }),
      rec({ verdict: 'changes_requested', issues: [{ severity: 'major', description: 'second problem' }] }),
    ]);
    const out = priorFor(log, 'S-1');
    expect(out.indexOf('first problem')).toBeLessThan(out.indexOf('second problem'));
  });

  it('survives a malformed line rather than losing the history', () => {
    const d = mkdtempSync(join(tmpdir(), 'prior-bad-')); made.push(d);
    const p = join(d, 'code-reviews.jsonl');
    writeFileSync(p, 'not json\n' + JSON.stringify(rec({ verdict: 'changes_requested', issues: [{ severity: 'blocker', description: 'still here' }] })) + '\n');
    expect(priorFor(p, 'S-1')).toMatch(/still here/);
  });
});

describe('the reviewer is wired to receive it', () => {
  const script = () => readFileSync(REVIEWER, 'utf8');

  it('the producer builds the prior-review block', () => {
    expect(script()).toMatch(/prior-reviews\.py/);
  });

  it('and passes it as a value', () => {
    expect(script()).toMatch(/__PRIOR_REVIEW__/);
  });

  it('the template declares the placeholder', () => {
    expect(JSON.parse(readFileSync(TEMPLATE, 'utf8')).placeholders).toContain('__PRIOR_REVIEW__');
  });
});

describe('and told what consistency requires', () => {
  const body = (): string => {
    const j = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    return String(j.body ?? Object.values(j.bodies ?? {}).join('\n')).toLowerCase();
  };

  it('may not approve while a blocker it raised is unresolved', () => {
    expect(body(), 'nothing forbids approving an unresolved blocker — the live failure')
      .toMatch(/unresolved|still stands|not.{0,20}approve/);
  });

  it('must repeat an unfixed finding rather than drop it', () => {
    // The dead script's anti-context said "do not repeat these same findings", which on an
    // unchanged codeline points straight at approval. The rule is the opposite.
    expect(body()).toMatch(/repeat|raise it again|restate/);
  });
});
