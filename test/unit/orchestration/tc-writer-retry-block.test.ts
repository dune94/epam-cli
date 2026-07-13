/**
 * TC writer — retry + block-story instead of exit 1 (both inline and batch
 * call sites, run-agent-orchestration.sh).
 *
 * Root cause: a story with no valid testCriteria after the writer ran used
 * to hard `exit 1`, aborting the ENTIRE pipeline over ONE story — the most
 * severe failure mode of any guarded step in this pipeline (worse than a
 * silent revert: it took down every OTHER story in the phase too). Fixed
 * with a 3-attempt retry, and on exhaustion: mark just that story
 * status="blocked" (a new PRD status value), log to blocked-stories.jsonl,
 * and skip it — not abort. Step 1's own live-status re-check (which already
 * skips "deprecated" stories) now also skips "blocked" ones.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('Inline TC writer gate (Step 1 loop) — static wiring', () => {
  const startIdx = orchSrc.indexOf('if [ -n "$_needs_tc" ]; then');
  const endIdx = orchSrc.indexOf('log "  Running: $story"', startIdx);
  const block = orchSrc.slice(startIdx, endIdx);

  it('retries up to 3 attempts instead of a bare single call', () => {
    expect(block).toMatch(/for _tc_inline_attempt in 1 2 3; do/);
  });

  it('does NOT exit 1 on exhaustion — blocks the story instead', () => {
    // Excludes comment prose (this block's own docstring explains the OLD
    // behavior it replaced, "hard `exit 1`...") — only a literal executable
    // `exit 1` statement would be a regression.
    expect(block).not.toMatch(/^\s*exit 1\s*$/m);
    expect(block).toMatch(/\.status = "blocked"/);
  });

  it('logs the block reason to blocked-stories.jsonl', () => {
    expect(block).toMatch(/blocked-stories\.jsonl/);
  });

  it('logs the outcome to guarded-step-retries.jsonl', () => {
    expect(block).toMatch(/guarded-step-retries\.jsonl/);
  });

  it('continues the loop (skips this story) rather than aborting', () => {
    expect(block).toMatch(/\n\s*continue\s*\n/);
  });
});

describe('Step 1 loop — live-status re-check now also skips "blocked" stories (static)', () => {
  it('skips deprecated (existing) AND blocked (new) stories', () => {
    const idx = orchSrc.indexOf('_story_current_status=$(jq -r --arg id "$story"');
    const block = orchSrc.slice(idx, idx + 1000);
    expect(block).toMatch(/if \[ "\$_story_current_status" = "deprecated" \]; then/);
    expect(block).toMatch(/if \[ "\$_story_current_status" = "blocked" \]; then/);
  });
});

describe('Batch TC writer gate (Step 1.6) — static wiring', () => {
  const idx = orchSrc.indexOf('for _tc_batch_attempt in 1 2 3; do');
  const block = orchSrc.slice(idx - 200, idx + 2600);

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

describe('Inline TC writer gate — REAL execution', () => {
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

    // Extract just the retry block as a standalone snippet, stubbing
    // post-impl-tc-writer.sh with a fixture script controlled by the test.
    // Same anchors as the static describe block above — the block runs from
    // the "$_needs_tc" check up to (not including) the next statement after
    // the whole TC-writer if/fi ("Running: $story").
    const startIdx = orchSrc.indexOf('if [ -n "$_needs_tc" ]; then');
    const endIdx = orchSrc.indexOf('log "  Running: $story"', startIdx);
    const block = orchSrc.slice(startIdx, endIdx);

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

    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      `SCRIPT_DIR=${JSON.stringify(dir)}`,
      'PHASE=core',
      `OUTPUT_DIR=${JSON.stringify(dir)}`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`,
      'story="SKY-002-test"',
      'log() { echo "LOG: $*" >&2; }',
      'warning() { echo "WARN: $*" >&2; }',
      'success() { echo "SUCCESS: $*" >&2; }',
      'error() { echo "ERROR: $*" >&2; }',
      `_needs_tc="SKY-002-test"`,
      block,
      'echo "REACHED_END rc=$?"',
    ].join('\n');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);

    let stdout = '';
    let caughtContinue = false;
    try {
      stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).toString();
    } catch (e: any) {
      // `continue` outside a loop is a bash error in this standalone
      // extraction context (the real code runs inside a `while`/`for`
      // loop) — that's expected and fine; it proves the block chose the
      // "skip this story" path instead of falling through/exiting 1.
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
      caughtContinue = /continue.*only meaningful in/i.test(stdout) || e.status === 1;
    }

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
    return { prd, blockedLog, retriesLog, stdout: stdout + (caughtContinue ? ' [continue-outside-loop, expected]' : '') };
  }

  it('REPRODUCES the live defect and proves the fix: after 3 attempts with no real facts, the story is BLOCKED (not the whole pipeline aborted)', () => {
    const { prd, blockedLog, retriesLog } = run({ alwaysEmptyFacts: true });
    const story = prd.stories.find((s: any) => s.id === 'SKY-002-test');
    expect(story.status).toBe('blocked');
    expect(blockedLog).toHaveLength(1);
    expect(blockedLog[0].storyId).toBe('SKY-002-test');
    expect(retriesLog[0].outcome).toBe('blocked');
    expect(retriesLog[0].attempts).toBe(3);
  });

  it('succeeds on the first real attempt: story is NOT blocked, facts are populated', () => {
    const { prd, blockedLog, retriesLog } = run({ alwaysEmptyFacts: false });
    const story = prd.stories.find((s: any) => s.id === 'SKY-002-test');
    expect(story.status).not.toBe('blocked');
    expect(story.testCriteria.facts).toEqual(['real fact']);
    expect(blockedLog).toHaveLength(0);
    expect(retriesLog[0].outcome).toBe('pass');
    expect(retriesLog[0].attempts).toBe(1);
  });
});
