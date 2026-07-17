/**
 * TC writer — retry + block-story instead of exit 1 (inline gate, shared
 * across ALL lanes: main-branch Step 1 AND worktree Step 3a/3b), plus the
 * batch call site (Step 1.6, run-agent-orchestration.sh).
 *
 * Root cause (2026-07-13): a story with no valid testCriteria after the
 * writer ran used to hard `exit 1`, aborting the ENTIRE pipeline over ONE
 * story — the most severe failure mode of any guarded step in this
 * pipeline. Fixed with a 3-attempt retry, and on exhaustion: mark just that
 * story status="blocked" (a new PRD status value), log to
 * blocked-stories.jsonl, and skip it — not abort.
 *
 * Root cause (2026-07-14): this gate used to be duplicated inline inside
 * run-agent-orchestration.sh's Step 1 main-branch loop ONLY — worktree lanes
 * (Step 3a "primary" / Step 3b "independent") never passed through that
 * loop at all, so a pure-test story assigned to a worktree lane ran its
 * entire first execution with testCriteria.facts=[]. Per explicit
 * instruction ("all lanes must have the same flow no deviations"), the
 * gate is now a single shared function, run_inline_tc_writer_gate() in
 * orchestrations/scripts/lib/tc-writer-gate.sh, sourced and called from
 * BOTH run-agent-orchestration.sh (Step 1, main lane) and claude.sh
 * (run_implementation(), primary/independent worktree lanes).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const GATE_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const gateSrc = readFileSync(GATE_LIB, 'utf8');

function extractFunctionBody(src: string, name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(src);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

describe('Inline TC writer gate — single shared implementation (lib/tc-writer-gate.sh)', () => {
  const block = extractFunctionBody(gateSrc, 'run_inline_tc_writer_gate');

  it('retries up to 3 attempts instead of a bare single call', () => {
    expect(block).toMatch(/for _tc_gate_attempt in 1 2 3; do/);
  });

  it('only fires for a story that itself needs TCs (test file owner, empty facts, not deprecated)', () => {
    expect(gateSrc).toMatch(/endswith\(".test.ts"\)/);
    expect(gateSrc).toMatch(/testCriteria\.facts/);
    expect(gateSrc).toContain('status != "deprecated"');
  });

  it('does NOT exit 1 on exhaustion — blocks the story instead', () => {
    expect(block).not.toMatch(/^\s*exit 1\s*$/m);
    expect(block).toMatch(/\.status = "blocked"/);
  });

  it('logs the block reason to blocked-stories.jsonl', () => {
    expect(block).toMatch(/blocked-stories\.jsonl/);
  });

  it('logs the outcome via the shared retry-history logger (double-write to per-run + persistent history)', () => {
    expect(block).toMatch(/_tc_writer_gate_log_retry "\$\(jq -n -c/);
    const loggerBody = extractFunctionBody(gateSrc, '_tc_writer_gate_log_retry');
    expect(loggerBody).toContain('guarded-step-retries.jsonl');
    expect(loggerBody).toContain('guarded-step-retries-history.jsonl');
  });

  it('returns 1 (caller must skip the story) on exhaustion, 0 otherwise', () => {
    expect(block).toMatch(/return 1/);
    expect(block).toMatch(/return 0/);
  });
});

describe('Inline TC writer gate — sourced and called identically by every lane', () => {
  it('run-agent-orchestration.sh (main lane, Step 1) sources the shared lib and calls the gate', () => {
    expect(orchSrc).toContain('source "$SCRIPT_DIR/lib/tc-writer-gate.sh"');
    // Gate call and run_story_with_watchdog now live inside _run_one_main_story()
    const fnStart = orchSrc.indexOf('_run_one_main_story() {');
    const loopBody = orchSrc.slice(fnStart, orchSrc.indexOf('done <<< "$non_review_main"', fnStart));
    expect(loopBody).toMatch(/if ! run_inline_tc_writer_gate "\$story" "\$PHASE"; then/);
    const gateIdx = loopBody.indexOf('run_inline_tc_writer_gate');
    const runIdx = loopBody.indexOf('run_story_with_watchdog');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(gateIdx);
  });

  it('the main-lane call site skips this story (returns early) when the gate blocks it', () => {
    // The loop body is now a function; skip is implemented as `return 0` (not
    // `continue`) so the outer while-loop moves to the next story.
    const fnStart = orchSrc.indexOf('_run_one_main_story() {');
    const loopBody = orchSrc.slice(fnStart, orchSrc.indexOf('done <<< "$non_review_main"', fnStart));
    const idx = loopBody.indexOf('if ! run_inline_tc_writer_gate');
    const snippet = loopBody.slice(idx, idx + 120);
    expect(snippet).toMatch(/return 0/);
  });

  it('claude.sh (worktree lanes, run_implementation()) sources the shared lib and calls the SAME gate', () => {
    expect(claudeSrc).toContain('source "$SCRIPT_DIR/lib/tc-writer-gate.sh"');
    const loopStart = claudeSrc.indexOf('for story_id in "${stories[@]}"; do');
    const loopBody = claudeSrc.slice(loopStart, claudeSrc.indexOf('# Setup git worktrees for parallel execution', loopStart));
    expect(loopBody).toMatch(/if ! run_inline_tc_writer_gate "\$story_id" "\$_wt_tc_phase"; then/);
    const gateIdx = loopBody.indexOf('run_inline_tc_writer_gate');
    const implIdx = loopBody.indexOf('implement_story "$story_id"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(implIdx).toBeGreaterThan(gateIdx);
  });

  it('the worktree-lane call site skips (does not implement) the story when the gate blocks it', () => {
    const loopStart = claudeSrc.indexOf('for story_id in "${stories[@]}"; do');
    const loopBody = claudeSrc.slice(loopStart, claudeSrc.indexOf('# Setup git worktrees for parallel execution', loopStart));
    const idx = loopBody.indexOf('if ! run_inline_tc_writer_gate');
    const snippet = loopBody.slice(idx, idx + 150);
    expect(snippet).toMatch(/continue/);
  });

  it('claude.sh worktree loop also re-checks deprecated/blocked status live, same as the main lane', () => {
    const loopStart = claudeSrc.indexOf('for story_id in "${stories[@]}"; do');
    const loopBody = claudeSrc.slice(loopStart, claudeSrc.indexOf('# Setup git worktrees for parallel execution', loopStart));
    expect(loopBody).toMatch(/_wt_story_status" = "deprecated"/);
    expect(loopBody).toMatch(/_wt_story_status" = "blocked"/);
  });
});

describe('Step 1 loop — live-status re-check skips "blocked" stories (static)', () => {
  it('skips deprecated (existing) AND blocked (new) stories', () => {
    const idx = orchSrc.indexOf('_story_current_status=$(jq -r --arg id "$story"');
    const block = orchSrc.slice(idx, idx + 1000);
    expect(block).toMatch(/if \[ "\$_story_current_status" = "deprecated" \]; then/);
    expect(block).toMatch(/if \[ "\$_story_current_status" = "blocked" \]; then/);
  });
});

describe('Batch TC writer gate (Step 1.6) — static wiring', () => {
  const idx = orchSrc.indexOf('for _tc_batch_attempt in 1 2 3; do');
  // Widened 2600 -> 3400 (2026-07-13): the violationTypes derivation +
  // _log_guarded_step_retry call added between the retry loop and the
  // "blocks only the specific IDs" section pushed it further from the anchor.
  const block = orchSrc.slice(idx - 200, idx + 3400);

  it('retries up to 3 attempts', () => {
    expect(block).toMatch(/for _tc_batch_attempt in 1 2 3; do/);
  });

  it('blocks only the specific still-missing story IDs, not the whole phase', () => {
    expect(block).toMatch(/IFS=',' read -ra _tc_blocked_ids/);
    expect(block).toMatch(/\.status = "blocked"/);
  });

  it('a genuine JSON-corruption crash still stays a hard exit 1 (not silently blocked)', () => {
    expect(block).toMatch(/if ! jq empty "\$PRD_FILE" 2>\/dev\/null; then/);
    expect(block).toMatch(/exit 1/);
  });
});

describe('Inline TC writer gate — REAL execution (shared lib, exercised standalone)', () => {
  function run(opts: { alwaysEmptyFacts: boolean }): {
    prd: any;
    blockedLog: any[];
    retriesLog: any[];
    stdout: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'tc-inline-block-'));
    const prdPath = join(dir, 'prd.json');
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });

    const initialPrd = {
      implementationOrder: { core: ['SKY-002-test'] },
      stories: [
        {
          id: 'SKY-002-test',
          status: 'pending',
          technicalNotes: { files: ['src/client.test.ts'] },
          testCriteria: { facts: [] },
        },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(initialPrd));

    const fakeWriter = join(dir, 'post-impl-tc-writer.sh');
    writeFileSync(
      fakeWriter,
      [
        '#!/usr/bin/env bash',
        'PRD_FILE=""',
        'STORY=""',
        'while [ $# -gt 0 ]; do case $1 in --prd) PRD_FILE="$2"; shift 2;; --story) STORY="$2"; shift 2;; *) shift;; esac; done',
        opts.alwaysEmptyFacts
          ? 'echo "wrote nothing useful"'
          : `jq --arg id "$STORY" '(.stories[] | select(.id == $id)).testCriteria.facts = ["real fact"]' "$PRD_FILE" > "$PRD_FILE.tmp" && mv "$PRD_FILE.tmp" "$PRD_FILE"`,
        'exit 0',
      ].join('\n'),
    );
    execFileSync('chmod', ['+x', fakeWriter]);

    const gateBody = extractFunctionBody(gateSrc, 'run_inline_tc_writer_gate');
    const upgradeBody = extractFunctionBody(gateSrc, '_tc_writer_gate_maybe_upgrade_model');
    const loggerBody = extractFunctionBody(gateSrc, '_tc_writer_gate_log_retry').replace(
      /\$SCRIPT_DIR\/\.\.\/logs/g,
      join(dir, 'history-logs'),
    );

    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      `SCRIPT_DIR=${JSON.stringify(dir)}`,
      `OUTPUT_DIR=${JSON.stringify(dir)}`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`,
      'log() { echo "LOG: $*" >&2; }',
      'warning() { echo "WARN: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'error() { echo "ERROR: $*" >&2; }',
      upgradeBody,
      loggerBody,
      gateBody,
      'run_inline_tc_writer_gate "SKY-002-test" "core"',
      'echo "REACHED_END rc=$?"',
    ].join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);

    const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).toString();

    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    let blockedLog: any[] = [];
    let retriesLog: any[] = [];
    try {
      blockedLog = readFileSync(join(logDir, 'blocked-stories.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* not created when nothing was blocked */ }
    try {
      retriesLog = readFileSync(join(logDir, 'guarded-step-retries.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    return { prd, blockedLog, retriesLog, stdout };
  }

  it('REPRODUCES the live defect and proves the fix: after 3 attempts with no real facts, the story is BLOCKED (not the whole pipeline aborted)', () => {
    const { prd, blockedLog, retriesLog, stdout } = run({ alwaysEmptyFacts: true });
    expect(stdout).toContain('REACHED_END rc=1');
    const story = prd.stories.find((s: any) => s.id === 'SKY-002-test');
    expect(story.status).toBe('blocked');
    expect(blockedLog).toHaveLength(1);
    expect(blockedLog[0].storyId).toBe('SKY-002-test');
    expect(retriesLog[0].outcome).toBe('blocked');
    expect(retriesLog[0].attempts).toBe(3);
  });

  it('succeeds on the first real attempt: story is NOT blocked, facts are populated', () => {
    const { prd, blockedLog, retriesLog, stdout } = run({ alwaysEmptyFacts: false });
    expect(stdout).toContain('REACHED_END rc=0');
    const story = prd.stories.find((s: any) => s.id === 'SKY-002-test');
    expect(story.status).not.toBe('blocked');
    expect(story.testCriteria.facts).toEqual(['real fact']);
    expect(blockedLog).toHaveLength(0);
    expect(retriesLog[0].outcome).toBe('pass');
    expect(retriesLog[0].attempts).toBe(1);
  });
});
