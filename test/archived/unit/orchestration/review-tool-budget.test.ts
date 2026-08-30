/**
 * The reviewer must be BOUNDED by a mechanism, not asked politely to stop.
 *
 * Measured on a full mock1 run (2026-07-26), where the only code change was one
 * string literal:
 *
 *   team-lead-agent   4 calls   25/15/11/7 turns   615,089 tokens in   $0.2993
 *   everything else                                115,726 tokens in   $0.0608
 *
 * 83% of the run's cost, to emit a five-line JSON verdict approving a one-line
 * diff. It reached exactly 25 turns — REVIEW_MAX_ITERATIONS — which is what an
 * agent does when nothing stops it: it explores to its limit.
 *
 * That limit was raised 12 -> 25 (c324001, 2026-07-24) because "twelve is what
 * thrashed". The codebase had ALREADY recorded that this is the wrong lever, in
 * AgentRunner's own tool-budget comment, about the detective:
 *
 *   "That was 'fixed' three times by raising the cap (10 -> 20 -> 25, and 40 was
 *    worst of all: 40 calls, 680K input tokens, no fix). The budget was never the
 *    constraint — the absence of a mechanism was."
 *
 * The mechanism exists and is plumbed end to end: EPAM_MAX_TOOL_CALLS ->
 * EnvVarOverrides -> ConfigResolver -> AgentRunner's tool budget, which withdraws
 * the tools and demands a final answer from the evidence already gathered. The
 * reviewer simply never set one, so its ceiling was the iteration cap.
 *
 * These tests drive the REAL run_review_prompt out of team-lead-review.sh with a
 * stub runner that records the environment it is invoked with. They assert the
 * bound is applied at the seam — not that a number appears in the source.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REVIEW_SH = join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh');
const src = readFileSync(REVIEW_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real function, lifted verbatim — no re-implementation of its logic. */
function runReviewPromptBody(): string {
  const i = src.indexOf('run_review_prompt() {');
  if (i < 0) throw new Error('run_review_prompt() not found');
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j + 3);
}

/**
 * Invoke the real reviewer function against a stub runner and return the
 * environment that runner saw.
 */
function invokeReviewer(env: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'review-budget-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'logs'), { recursive: true });

  // Records its environment, then answers with a valid verdict so the function
  // takes its success path.
  //
  // `export -p` is a bash BUILTIN, deliberately. Using `env` here captured zero
  // bytes under vitest while working perfectly from an interactive shell:
  // ~/.local/bin/env shadows coreutils in this environment and swallows the
  // command, and which one wins depends on the inherited PATH. A harness whose
  // result depends on that is not a harness.
  const stub = join(dir, 'ai-run.sh');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `export -p > ${JSON.stringify(join(dir, 'captured.env'))}`,
    'cat > /dev/null',
    `echo '{"verdict":"approved","issues":[],"summary":"ok"}'`,
  ].join('\n'));
  chmodSync(stub, 0o755);

  const drive = join(dir, 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash',
    // Collaborators the function calls. Stubbed so the test exercises the
    // invocation, not the ladder.
    'warning() { :; }',
    'error() { :; }',
    'info() { :; }',
    '_ladder_next_model() { echo ""; }',
    '_ladder_skip_reason() { echo "test"; }',
    '_provider_for_model() { echo "openrouter"; }',
    `AI_RUNNER_CMD=${JSON.stringify(stub)}`,
    `SCRIPT_DIR=${JSON.stringify(dir)}`,
    `AUTOMATION_DIR=${JSON.stringify(dir)}`,
    `PROJECT_ROOT=${JSON.stringify(dir)}`,
    'ORCH_GATE_MODEL="z-ai/glm-5.1"',
    'PHASE_ID=core',
    runReviewPromptBody(),
    'run_review_prompt "review this diff" >/dev/null 2>&1',
  ].join('\n'));

  const r = spawnSync('bash', [drive], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env },
  });

  const capturedPath = join(dir, 'captured.env');
  if (!existsSync(capturedPath)) {
    // Never return {} quietly: an empty capture would make every assertion below
    // fail with a message about the reviewer, when the truth is that the harness
    // never reached it.
    throw new Error(
      `stub runner was never invoked (status=${r.status})\n` +
      `--- stdout ---\n${(r.stdout || '').slice(0, 2000)}\n` +
      `--- stderr ---\n${(r.stderr || '').slice(0, 2000)}`,
    );
  }
  const raw = readFileSync(capturedPath, 'utf8');
  if (process.env.DEBUG_REVIEW_HARNESS) {
    console.error(`[harness] captured ${raw.length} bytes, status=${r.status}\n${raw.slice(0, 300)}`);
  }
  // `export -p` emits: declare -x NAME="value"
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^declare -x ([A-Za-z_][A-Za-z0-9_]*)(?:="(.*)")?$/.exec(line);
    if (m) out[m[1]] = m[2] ?? '';
  }
  return out;
}

describe('the reviewer is given a tool budget', () => {
  it('reaches the runner at all (harness sanity)', () => {
    // If this fails the other assertions prove nothing.
    const e = invokeReviewer();
    expect(Object.keys(e).length, 'the stub runner was never invoked').toBeGreaterThan(0);
  });

  it('sets EPAM_MAX_TOOL_CALLS', () => {
    const e = invokeReviewer();
    expect(e.EPAM_MAX_TOOL_CALLS,
      'the reviewer has no tool budget, so nothing stops it exploring to the ' +
      'iteration cap — 25 turns and 272K tokens to approve a one-line diff')
      .toBeTruthy();
  });

  it('bounds it to a number a reviewer can actually finish within', () => {
    const n = Number(invokeReviewer().EPAM_MAX_TOOL_CALLS);
    expect(Number.isFinite(n) && n > 0, 'the budget is not a positive number').toBe(true);
    // Read the diff, check for a reusable helper, confirm types and tests. A
    // reviewer needing more than a handful of calls is exploring, not reviewing.
    expect(n, 'the budget is too loose to change the behaviour it exists to bound')
      .toBeLessThanOrEqual(12);
  });

  it('stays overridable per project', () => {
    // No stack or client specifics in the engine: a project whose review genuinely
    // needs more room must be able to say so without editing the script.
    const e = invokeReviewer({ REVIEW_MAX_TOOL_CALLS: '9' });
    expect(e.EPAM_MAX_TOOL_CALLS,
      'the budget is hardcoded — a project cannot raise it without a code change')
      .toBe('9');
  });

  it('still passes the iteration cap, so the two bounds coexist', () => {
    // The tool budget replaces exploration, not the loop guard: an agent that
    // stalls without calling tools must still be stopped.
    expect(invokeReviewer().EPAM_MAX_ITERATIONS,
      'the iteration cap was dropped — a stalling reviewer is now unbounded')
      .toBeTruthy();
  });
});
