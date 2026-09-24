/**
 * AN ESCALATED FIX CLIMBS THE OWNER'S LADDER.
 *
 * regintel 20260919T224649Z resume 7 (2026-09-20 07:30–08:35): REGI-005b escalated a defect in
 * classifier.py to its owner REGI-005a. resolve_escalation ran implement_story with
 * MAX_RETRIES=1: one attempt at the owner's rung 0 (MiniMax-M3), then "[HealingBroken] At max
 * rung — aborting" — a one-rung ladder has no rung to climb to. The next escalation ran the same
 * model with the same amendment; the third would have run NOTHING (persisted count 2 > MAX 1, the
 * loop never entered) and still reported "failed after 2 attempts". Three stories burned their
 * ladders re-escalating into a fix that could not change.
 *
 * The rule every seam obeys: ladder + self-heal + retries, no subset. The escalated fix is a
 * story attempt on the OWNER's ladder: it runs at the owner's persisted rung, gets a bounded
 * number of attempts per escalation (config: retries.escalationAttempts → EPAM_ESCALATION_ATTEMPTS),
 * persists the advanced count, and the next escalation resumes from there — climbing.
 *
 * Executes the real story-retry-state helpers and the real resolve_escalation() (implement_story
 * stubbed to report what it was given), and mutation-checks the retry loop's use of the budget.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const RETRY_LIB = join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const src = engineSource(join(ROOT, 'orchestrations/scripts/claude.sh'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fnBody(name: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (start === -1) throw new Error(`no ${name}`);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) { body.push(lines[i]); if (lines[i] === '}') return body.join('\n'); }
  throw new Error(`unterminated ${name}`);
}
function bash(script: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(RETRY_LIB)}\n${script}`], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

describe('the per-escalation attempt budget (story-retry-state.sh)', () => {
  it('with no budget declared every attempt is allowed — an ordinary story is unchanged', () => {
    expect(bash('escalation_budget_allows 1 && echo YES', { EPAM_ESCALATION_ATTEMPT_BUDGET: '' }).out).toContain('YES');
    expect(bash('escalation_budget_allows 9 && echo YES', { EPAM_ESCALATION_ATTEMPT_BUDGET: '' }).out).toContain('YES');
  });
  it('a budget of 1 allows the first attempt and refuses the second', () => {
    expect(bash('escalation_budget_allows 0 && echo YES', { EPAM_ESCALATION_ATTEMPT_BUDGET: '1' }).out).toContain('YES');
    expect(bash('escalation_budget_allows 1 && echo YES || echo NO', { EPAM_ESCALATION_ATTEMPT_BUDGET: '1' }).out).toContain('NO');
  });
  it('a budget of 2 allows two', () => {
    expect(bash('escalation_budget_allows 1 && echo YES', { EPAM_ESCALATION_ATTEMPT_BUDGET: '2' }).out).toContain('YES');
    expect(bash('escalation_budget_allows 2 && echo YES || echo NO', { EPAM_ESCALATION_ATTEMPT_BUDGET: '2' }).out).toContain('NO');
  });
});

describe('resolve_escalation runs the owner on ITS ladder, budgeted per escalation', () => {
  function resolve(persistedCount: number, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'esc-ladder-')); dirs.push(dir);
    const logs = join(dir, 'logs'); mkdirSync(logs);
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [
      { id: 'REGI-005a', specification: { createdFrom: 'REGI-005' }, technicalNotes: { files: ['regintel/classifier.py'] } },
      { id: 'REGI-005b', specification: { createdFrom: 'REGI-005' }, technicalNotes: { files: ['tests/test_escalation.py'] } },
    ] }));
    mkdirSync(join(dir, '.epam/escalations'), { recursive: true });
    writeFileSync(join(dir, '.epam/escalations/REGI-005b.json'), JSON.stringify({ targetFile: 'regintel/classifier.py', diagnosis: 'async where sync is required', requiredFix: 'make it sync' }));
    if (persistedCount) { mkdirSync(join(logs, 'story-retry-state')); writeFileSync(join(logs, 'story-retry-state/REGI-005a.count'), `${persistedCount}\n`); }
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      `source ${JSON.stringify(RETRY_LIB)}`,
      `PROJECT_ROOT="${dir}"`, `PRD_FILE="${dir}/prd.json"`, `LOG_DIR="${logs}"`, `MAX_RETRIES=7`,
      `log() { echo "LOG: $*"; }`, `warning() { echo "WARN: $*"; }`, `success() { echo "SUCCESS: $*"; }`,
      // The owner's implement_story reports the ladder it was handed and the rung it would start at.
      `implement_story() { echo "OWNER=$1 MAX_RETRIES=$MAX_RETRIES BUDGET=\${EPAM_ESCALATION_ATTEMPT_BUDGET:-unset} START=$(read_story_retry_count "$LOG_DIR" "$1")"; return 1; }`,
      fnBody('resolve_escalation'),
      'resolve_escalation REGI-005b; echo "EXIT:$?"',
      'echo "AFTER_BUDGET=${EPAM_ESCALATION_ATTEMPT_BUDGET:-unset} AFTER_MAX=$MAX_RETRIES"',
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, ...env } });
    return `${r.stdout}${r.stderr}`;
  }

  it('hands the owner its FULL ladder, not a one-rung one', () => {
    const out = resolve(0, { EPAM_ESCALATION_ATTEMPTS: '1' });
    expect(out, out).toMatch(/OWNER=REGI-005a MAX_RETRIES=7/);
  });
  it('bounds the attempts per escalation by the declared budget', () => {
    expect(resolve(0, { EPAM_ESCALATION_ATTEMPTS: '1' })).toMatch(/BUDGET=1/);
    expect(resolve(0, { EPAM_ESCALATION_ATTEMPTS: '2' })).toMatch(/BUDGET=2/);
  });
  it('the owner starts at its persisted rung — the second escalation climbs, it does not restart', () => {
    expect(resolve(2, { EPAM_ESCALATION_ATTEMPTS: '1' })).toMatch(/START=2/);
  });
  it('restores the caller\'s ladder and clears the budget afterwards — the escalating story is unaffected', () => {
    const out = resolve(0, { EPAM_ESCALATION_ATTEMPTS: '1' });
    expect(out).toMatch(/AFTER_BUDGET=unset AFTER_MAX=7/);
  });
  // REVERSED 2026-09-24. This used to require a refusal ("ladder exhausted", EXIT:1). Live that
  // refusal threw away the diagnosis of the one defect failing the regintel codeline, on a count
  // spent in earlier runs. An escalation is new evidence with its own budget: a spent owner takes
  // it on its top rung. See an-escalation-reaches-an-owner-whose-ladder-is-spent.test.ts.
  it('an owner whose ladder is spent still takes the escalated fix, and the log says it runs on its top rung', () => {
    const out = resolve(8, { EPAM_ESCALATION_ATTEMPTS: '1' });
    expect(out, 'the escalation was refused on a spent ladder').not.toMatch(/no further scoped fix is possible/);
    expect(out).toMatch(/OWNER=REGI-005a/);
    expect(out).toMatch(/REGI-005a.*top rung/i);
    expect(out).toMatch(/BUDGET=1/);
  });
});

describe('the retry loop honours the budget (mutation-checked wiring)', () => {
  it('the loop condition consults escalation_budget_allows with the attempts made so far', () => {
    const loop = src.split('\n').find((l) => /^\s*while \[ \$retry_count -le \$MAX_RETRIES \]/.test(l)) || '';
    // the attempts that COUNT — a free retry (resolved escalation, deterministic check) is free of the
    // budget too, or the promised retry never runs (£0 escalation-chain run 6, 2026-09-24)
    expect(loop, 'the retry loop does not consult the per-escalation budget').toMatch(/escalation_budget_allows "\$\(\(_total_attempts - _free_attempts\)\)"/);
  });
  it('the persisted count is written before the loop can be left on budget (a killed process must not lose the rung)', () => {
    // write_story_retry_count runs on every failure BEFORE the loop re-tests its condition.
    const body = fnBody('implement_story');
    const iWrite = body.indexOf('write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"\n            # The model belongs with the count');
    const iLoopEnd = body.lastIndexOf('\n    done\n');
    expect(iWrite).toBeGreaterThan(0);
    expect(iWrite).toBeLessThan(iLoopEnd);
  });
});
