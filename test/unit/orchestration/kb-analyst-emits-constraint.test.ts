/**
 * Prose-channel removal, step 1: the analyst produces ENFORCEMENT, not advice.
 *
 * agent-attempt-analyst.sh diagnosed a failed attempt and returned a 1-3 sentence
 * directive, which brownfield-repro-test-writer.sh prepended to the next attempt
 * as "CORRECTIVE GUIDANCE FROM SELF-HEAL (address this FIRST): ...". That is a
 * self-heal KB push into a prompt, which is banned outright: appended text is
 * silently trimmed on long runs and nothing verifies the agent obeyed it.
 *
 * Rather than build a second constraint-emitting path in bash, the analyst now
 * feeds the machinery that already exists and is tested: it records its diagnosis
 * as an EPISODE, then triggers synthesis. Synthesis is the one place an LLM
 * re-enters the loop, and its output space is already bounded by kb_schema.py, so
 * a proposal with no mechanism is unconstructable rather than merely rejected.
 *
 * Threshold 1 for this path, deliberately. Synthesis normally waits for a repeat,
 * but self-heal here is same-story: the retry happens seconds later, and waiting
 * for a second identical failure would leave the very next attempt unguided —
 * which is the attempt that matters most. The drift protections that justify a
 * higher threshold (arbitration, TTL ageing, quarantine) are all in place now, so
 * a single-episode rule is safe: if it is wrong, it ages out.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const ANALYST = join(SCRIPTS, 'agent-attempt-analyst.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Stub ai-run.sh. The analyst calls it to diagnose; synthesis calls it to propose. */
function stubRunner(body: string) {
  const d = mkdtempSync(join(tmpdir(), 'an-run-')); dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const RULE = JSON.stringify({
  enforcement: { kind: 'effort_tier', tier: 'high' },
  reason: 'agent exhausted its turns before writing the deliverable',
});

function runAnalyst(runnerBody: string, failureClass = 'max_iterations') {
  const kbRoot = mkdtempSync(join(tmpdir(), 'an-kb-')); dirs.push(kbRoot);
  const logDir = mkdtempSync(join(tmpdir(), 'an-log-')); dirs.push(logDir);
  const logFile = join(logDir, 'agent.log');
  writeFileSync(logFile, "src/a.ts(12,5): error TS2532: Object is possibly 'undefined'.");
  let out = '', code = 0, err = '';
  try {
    out = execFileSync('bash', [ANALYST, failureClass, logFile], {
      encoding: 'utf8',
      env: { ...process.env, KB_ROOT: kbRoot, AI_RUNNER_CMD: stubRunner(runnerBody),
             AGENT_ANALYST_STORY_ID: 'S-1', STORY_ROLE: 'impl-agent' },
    });
  } catch (e: any) { out = e.stdout || ''; err = e.stderr || ''; code = e.status ?? 1; }
  const cf = join(kbRoot, 'constraints.json');
  const constraints = existsSync(cf) ? JSON.parse(readFileSync(cf, 'utf8')) : [];
  const ef = join(kbRoot, 'healing-events.jsonl');
  const episodes = existsSync(ef)
    ? readFileSync(ef, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { out, err, code, constraints, episodes, kbRoot };
}

describe('the analyst feeds the KB instead of the prompt', () => {
  it('records its diagnosis as an episode', () => {
    const { episodes } = runAnalyst(`cat <<'J'\n${RULE}\nJ`);
    expect(episodes.length,
      'the analyst produced no episode — its diagnosis is lost the moment it returns').toBeGreaterThan(0);
  });

  it('produces an enforceable constraint, not a prose directive', () => {
    const { constraints } = runAnalyst(`cat <<'J'\n${RULE}\nJ`);
    expect(constraints.length,
      'no constraint synthesised — the retry would run with no enforcement at all').toBe(1);
    expect(constraints[0].enforcement.kind).toBe('effort_tier');
    expect(constraints[0].enforcement.tier).toBe('high');
  });

  it('emits no prose on stdout for a caller to prepend to a prompt', () => {
    const { out } = runAnalyst(`cat <<'J'\n${RULE}\nJ`);
    expect(out,
      'the analyst still returns prompt text — the banned channel is still open')
      .not.toMatch(/exhausted its turns|you have|do NOT keep exploring/i);
  });

  it('binds its own output to the Constraint schema', () => {
    const src = readFileSync(join(SCRIPTS, 'lib', 'kb-synthesizer.js'), 'utf8');
    expect(src,
      'the one LLM step that produces rules is not itself schema-bound — it can ' +
      'still emit prose that has to be salvaged by a parser')
      .toMatch(/EPAM_RESPONSE_SCHEMA/);
  });
});

describe('a broken analyst still cannot fail the story', () => {
  it('exits non-zero but leaves the store consistent when the model fails', () => {
    const { code, constraints } = runAnalyst('echo "boom" >&2; exit 1');
    expect(code, 'a failed analyst must remain detectable (B30)').not.toBe(0);
    expect(constraints.length, 'a failed diagnosis must not create a rule').toBe(0);
  });
});
