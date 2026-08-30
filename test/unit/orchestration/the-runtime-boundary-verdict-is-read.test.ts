/**
 * A GATE THAT RUNS AND IS NOT READ IS NOT A GATE.
 *
 * runtime-boundary's result handling read the EXIT CODE and nothing else:
 *
 *   wait $_rb_pid || _rb_exit=$?
 *   if [ $_rb_exit -eq 0 ]; then step_emit "22g" "pass" ...
 *
 * $_rb_log was written, passed to the gate, and never read again. So the agent could report — in
 * grounded detail — that an import throws at module load in a context that cannot supply its
 * credentials, and the run would print "Step 22g: Runtime boundary — pass", because the process
 * exited 0. The finding reached nobody: not the reviewer, not the writer, not the operator.
 *
 * Its sibling two lines below (fuzz-weaver) greps the log for "verdict":"fail" and blocks. This
 * brings runtime-boundary to the same standard, with the same grounding discipline: a "fail" blocks
 * only when a finding points at a file that actually exists, an unparseable log is a non-blocking
 * warn (a gate that could not run is not a confirmed failure), and silence is a pass.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { orchestratorSource } from '../../helpers/orchestrator-source';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const GATE_LIB = join(__dirname, '../../../orchestrations/scripts/lib/gate-verdicts.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project with one real file, and a gate log to judge. */
function scene(log: string) {
  const d = mkdtempSync(join(tmpdir(), 'rb-verdict-')); dirs.push(d);
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'real.ts'), 'export const x = 1;\n');
  const f = join(d, 'gate.log');
  writeFileSync(f, log);
  return { root: d, log: f };
}

function verdict(logText: string) {
  const s = scene(logText);
  const r = spawnSync('bash', ['-c',
    `warning(){ echo "WARN $*"; }; error(){ echo "ERR $*"; }; success(){ :; }; log(){ :; }
     # SCRIPT_DIR as the run defines it: the function reaches its grounding handler through it,
     # and without it every fail silently degrades to warn — which is how a gate looks wired and
     # is not.
     SCRIPT_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations/scripts'))}
         # The function now lives in lib/gate-verdicts.sh — lifted out of the orchestrator so it
         # could be executed by a test at all. Sourced whole rather than sliced out by pattern.
         . ${JSON.stringify(GATE_LIB)}
     runtime_boundary_verdict ${JSON.stringify(s.log)} ${JSON.stringify(s.root)}`,
  ], { encoding: 'utf8', timeout: 60000 });
  return ((r.stdout || '').trim().split('\n').pop() || '').trim();
}

const grounded = JSON.stringify({
  verdict: 'fail',
  findings: [{ file: 'src/real.ts', detail: 'imports a module that throws at load in a client context' }],
});
const ungrounded = JSON.stringify({
  verdict: 'fail',
  findings: [{ file: 'src/does-not-exist.ts', detail: 'invented' }],
});

describe('THE VERDICT DECIDES, NOT THE EXIT CODE', () => {
  it('blocks on a fail whose finding points at a real file', () => {
    expect(verdict(grounded),
      'the gate reported a grounded runtime failure and the run called it a pass').toBe('fail');
  });

  it('downgrades a fail whose findings point at nothing real', () => {
    // Same discipline as fuzz-weaver: a claim about a file that does not exist is not evidence.
    expect(verdict(ungrounded)).toBe('warn');
  });

  it('passes a clean verdict', () => {
    expect(verdict(JSON.stringify({ verdict: 'pass', findings: [] }))).toBe('pass');
  });

  it('carries a warn verdict through as warn', () => {
    expect(verdict(JSON.stringify({ verdict: 'warn', findings: [] }))).toBe('warn');
  });

  it('treats an unparseable log as a non-blocking warn, never a pass', () => {
    // A gate that could not produce structured output has not cleared the change.
    expect(verdict('the model rambled and produced no json at all')).toBe('warn');
  });

  it('treats an empty log as a warn, not a pass', () => {
    expect(verdict('')).toBe('warn');
  });
});

describe('AND THE RUN ACTUALLY ASKS FOR IT', () => {
  // A verdict function nothing calls is the same defect wearing a nicer shape: the log was always
  // written and always ignored. This asserts the RECEIVER — that the gate's own log reaches the
  // verdict — because everything above passes just as happily while the caller reads only $?.
  it('the gate log is handed to the verdict, not just the exit code', () => {
    const text = orchestratorSource();
    const at = text.indexOf('_run_qa_gate_with_retry "$_rb_prompt"');
    expect(at, 'the runtime-boundary gate call is gone').toBeGreaterThan(-1);

    // everything the run does with the result, up to the next gate's handling
    const after = text.slice(at, at + 4000);
    expect(after, 'the result handling never reads the gate log — a grounded "cannot execute" '
      + 'finding would be reported as a pass because the process exited 0')
      .toMatch(/runtime_boundary_verdict\s+"\$_rb_log"/);
  });

  it('a blocking verdict actually fails the phase', () => {
    const text = orchestratorSource();
    const at = text.indexOf('case "$(runtime_boundary_verdict');
    expect(at, 'the verdict is not consulted at all').toBeGreaterThan(-1);
    const block = text.slice(at, text.indexOf('esac', at));
    expect(block, 'a fail verdict that does not set failed=1 blocks nothing')
      .toMatch(/fail\)[\s\S]*failed=1/);
    expect(block, 'a failing gate must reach the self-heal remediation list, as its siblings do')
      .toMatch(/_failing_logs\+=\("\$_rb_log"\)/);
  });
});
