/**
 * run_story_recovery_analyst — diagnose-then-restructure recovery for a
 * genuine watchdog double-timeout, scoped narrowly to that one failure
 * shape (not every kind of story failure).
 *
 * User request (2026-07-10, after SKY-002b and SKY-003-test both timed out
 * twice in the same live tier3-travel-app run): "we need to determine a self
 * heal approach a full blown prd recovery perhaps" — explicitly rejected a
 * plain retry-with-escalated-model as "not really a healing approach."
 * Instead of just giving the failed story more time/a different model, this
 * treats a double-timeout as evidence the story's own scope/ACs may be the
 * actual root cause: it asks an analyst whether the story is too large or
 * ambiguous, and if so, has it propose a trimmed acceptanceCriteria list —
 * applied through the SAME reviewer-gated ac_patch mechanism already used
 * elsewhere, then gives the story exactly one more attempt with the
 * narrowed scope.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('Step 1 loop — recovery wiring (static)', () => {
  it('run_story_recovery_analyst is invoked only when the story exit was non-zero', () => {
    const idx = orchSrc.indexOf('run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log" || _story_exit=$?');
    const block = orchSrc.slice(idx, idx + 700);
    expect(block).toMatch(/if \[ "\$_story_exit" -ne 0 \]; then/);
    expect(block).toMatch(/if run_story_recovery_analyst "\$story" "\$LOG_DIR\/main-\$\{story\}\.log"; then/);
    expect(block).toMatch(/_story_exit=0/);
  });

  it('recovery is scoped to technicalNotes.failureReason starting with watchdog_timeout', () => {
    const idx = orchSrc.indexOf('run_story_recovery_analyst() {');
    const block = orchSrc.slice(idx, idx + 800);
    expect(block).toMatch(/\.technicalNotes\.failureReason \/\/ ""/);
    expect(block).toMatch(/watchdog_timeout\*\)/);
  });

  it('gates the restructured ACs with an INLINE reviewer call, not a call to a function this script never defines', () => {
    // Root cause this guards against (found live, 2026-07-12, tier3-travel-app
    // run): this file used to call run_change_with_reviewer_retry(), a
    // function that only exists in claude.sh's scope -- this script never
    // sources it. The call failed with bash's own "command not found", and
    // because that failure's stdout is empty, the resulting $_verdict was ""
    // -- never equal to "fail" -- so the reviewer gate silently passed EVERY
    // restructure, unreviewed, every single time. Fixed by inlining the same
    // direct-LLM-call pattern already used by every other in-file reviewer
    // gate (e.g. pre-phase-assessment's profile-change gate) instead of
    // referencing an undefined cross-script function.
    const idx = orchSrc.indexOf('run_story_recovery_analyst() {');
    const block = orchSrc.slice(idx, idx + 6000);
    // The comment explaining the fix legitimately mentions the old function
    // name in prose -- what must never reappear is an actual INVOCATION of it.
    expect(block).not.toMatch(/[^#\n]*run_change_with_reviewer_retry "\$story_id"/);
    expect(block).toMatch(/"prd-change-reviewer" \/\/ ""/);
    expect(block).toMatch(/CHANGE TYPE: ac_patch/);
    expect(block).toMatch(/"\$AI_RUNNER_CMD"/);
  });

  it('gives the story exactly one retry via run_story_with_watchdog after restructuring', () => {
    const idx = orchSrc.indexOf('run_story_recovery_analyst() {');
    const end = orchSrc.indexOf('\n}', idx);
    const block = orchSrc.slice(idx, end);
    const calls = block.match(/run_story_with_watchdog "\$story_id" "\$log_file"/g) || [];
    expect(calls).toHaveLength(1);
  });
});

describe('run_story_recovery_analyst — REAL execution', () => {
  function extractFunction(name: string): string {
    const start = orchSrc.indexOf(`${name}() {`);
    const end = orchSrc.indexOf('\n}', start) + 2;
    return orchSrc.slice(start, end);
  }

  type Diagnosis = { restructure: boolean; new_acs?: string[]; reason?: string };

  function run(opts: {
    failureReason?: string;
    diagnosis: Diagnosis;
    reviewerVerdict?: 'pass' | 'fail';
    retryOutcome?: number; // exit code the stubbed run_story_with_watchdog returns
  }): { result: number; prd: any; auditRecords: any[]; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'story-recovery-'));
    const prdPath = join(dir, 'prd.json');
    const logPath = join(dir, 'main-SKY-002b.log');
    writeFileSync(
      logPath,
      'External verification failed for SKY-002b (exit 1)\n'.repeat(5) + 'Watchdog: SKY-002b timed out twice (600s then 900s)\n',
    );
    writeFileSync(
      prdPath,
      JSON.stringify(
        {
          stories: [
            {
              id: 'SKY-002b',
              status: 'failed',
              completed: false,
              acceptanceCriteria: ['does a lot of things', 'and also this', 'and this too', 'and more'],
              technicalNotes: {
                failureReason: opts.failureReason ?? 'watchdog_timeout: story exceeded timeout twice and was skipped',
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const stubPath = join(dir, 'ai-runner-stub.sh');
    writeFileSync(
      stubPath,
      ['#!/usr/bin/env bash', 'cat > /dev/null', `echo ${JSON.stringify(JSON.stringify(opts.diagnosis))}`].join('\n'),
    );
    chmodSync(stubPath, 0o755);

    // Stubs the REAL call path the inline reviewer gate uses (AI_RUNNER_CMD),
    // not a stub of a function name — this is what actually exercises the
    // fix instead of masking the bug the way the old
    // `run_change_with_reviewer_retry() { echo pass; }` stub used to (that
    // stub silently defined the very function whose absence in production
    // was the live bug, so the old tests never touched the real code path).
    const reviewerStubPath = join(dir, 'reviewer-ai-runner-stub.sh');
    writeFileSync(
      reviewerStubPath,
      [
        '#!/usr/bin/env bash',
        'cat > /dev/null',
        `echo '${JSON.stringify({ verdict: opts.reviewerVerdict ?? 'pass', issues: [], reason: '' })}'`,
      ].join('\n'),
    );
    chmodSync(reviewerStubPath, 0o755);

    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'prd-change-reviewer': 'You are a change reviewer.' }));

    const fnBody = extractFunction('run_story_recovery_analyst');
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'log() { echo "LOG: $*"; }',
      'warning() { echo "WARNING: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `LOG_DIR=${JSON.stringify(dir)}`,
      `AGENT_PROFILES_FILE=${JSON.stringify(profilesPath)}`,
      `ORCH_GATE_PROVIDER="fake"`,
      `AI_RUNNER_CMD=${JSON.stringify(reviewerStubPath)}`,
      'run_orch_prompt_with_tools() {',
      `  "${stubPath}"`,
      '}',
      `run_story_with_watchdog() { return ${opts.retryOutcome ?? 0}; }`,
      fnBody,
      `run_story_recovery_analyst "SKY-002b" ${JSON.stringify(logPath)}`,
      'echo "RESULT=$?"',
    ].join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);

    let stdout = '';
    try {
      stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
    }
    const m = stdout.match(/RESULT=(\d+)/);
    const result = m ? parseInt(m[1], 10) : -1;
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    let auditRecords: any[] = [];
    try {
      auditRecords = readFileSync(join(dir, 'story-recovery-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* no log written */
    }
    return { result, prd, auditRecords, dir };
  }

  it('is scoped to watchdog_timeout failures only — a different failure reason returns 1 without calling the analyst', () => {
    const { result, dir } = run({
      failureReason: 'some_other_reason: not a timeout',
      diagnosis: { restructure: true, new_acs: ['a'] },
    });
    expect(result).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('REPRODUCES the exact live shape and proves the fix: a genuinely too-broad story gets restructured and retried successfully', () => {
    const { result, prd, auditRecords, dir } = run({
      diagnosis: {
        restructure: true,
        new_acs: ['Client throws on missing API key', 'Client mocks fetch in test mode'],
        reason: 'Original ACs bundled 4 unrelated behaviors into one story',
      },
      retryOutcome: 0,
    });
    expect(result).toBe(0);
    const story = prd.stories.find((s: any) => s.id === 'SKY-002b');
    expect(story.status).toBe('pending');
    expect(story.completed).toBe(false);
    expect(story.acceptanceCriteria).toEqual(['Client throws on missing API key', 'Client mocks fetch in test mode']);
    expect(story.technicalNotes.recoveredFrom).toBe('watchdog_timeout');
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({ story_id: 'SKY-002b', event: 'story_restructured' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('analyst finds no structural issue: leaves the story failed, returns 1, no PRD mutation', () => {
    const { result, prd, dir } = run({
      diagnosis: { restructure: false, reason: 'Looks like a transient infra hiccup, not a scope problem' },
    });
    expect(result).toBe(1);
    const story = prd.stories.find((s: any) => s.id === 'SKY-002b');
    expect(story.status).toBe('failed');
    expect(story.acceptanceCriteria).toHaveLength(4); // unchanged
    rmSync(dir, { recursive: true, force: true });
  });

  it('reviewer rejects the proposed ACs: leaves the story failed, returns 1', () => {
    const { result, prd, dir } = run({
      diagnosis: { restructure: true, new_acs: ['bad ac'] },
      reviewerVerdict: 'fail',
    });
    expect(result).toBe(1);
    const story = prd.stories.find((s: any) => s.id === 'SKY-002b');
    expect(story.status).toBe('failed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('restructure applied but the retry itself still fails: returns 1 (counts as a phase failure)', () => {
    const { result, prd, dir } = run({
      diagnosis: { restructure: true, new_acs: ['narrower ac'] },
      retryOutcome: 1,
    });
    expect(result).toBe(1);
    // The PRD WAS restructured even though the retry failed -- the narrowed
    // scope is still a real improvement for whoever looks at this story next.
    const story = prd.stories.find((s: any) => s.id === 'SKY-002b');
    expect(story.acceptanceCriteria).toEqual(['narrower ac']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('restructure=true but new_acs is empty: treated as no restructure, returns 1', () => {
    const { result, prd, dir } = run({
      diagnosis: { restructure: true, new_acs: [] },
    });
    expect(result).toBe(1);
    const story = prd.stories.find((s: any) => s.id === 'SKY-002b');
    expect(story.status).toBe('failed');
    rmSync(dir, { recursive: true, force: true });
  });
});
