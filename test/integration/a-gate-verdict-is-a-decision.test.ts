/**
 * A GATE'S ANSWER MUST BECOME A DECISION, AND THE DECISION MUST BE RIGHT.
 *
 * 14 of the 40 declared seams are verdict-kind: their entire output is a judgement. The logic
 * turning one into fail/warn/pass sat inside run-agent-orchestration.sh, which cannot be sourced
 * without running the pipeline — so none of it had ever been executed by a test.
 *
 * That matters more here than anywhere. A gate that logs a block without enforcing it, and a gate
 * that blocks on a claim about a file that does not exist, look identical in a log to one working
 * correctly. Both have happened in this pipeline.
 *
 * runtime-boundary is the sharpest case: it resolved to no seam until today, so its rules had
 * never run at all.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/gate-verdicts.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function verdict(logBody: string, opts: { withRealFile?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-')); dirs.push(dir);
  const root = join(dir, 'repo'); mkdirSync(root, { recursive: true });
  if (opts.withRealFile) writeFileSync(join(root, 'real.ts'), 'export const x = 1;\n');
  const log = join(dir, 'gate.log');
  writeFileSync(log, logBody);
  const r = spawnSync('bash', ['-c',
    `set -uo pipefail; SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; . ${JSON.stringify(LIB)}; ` +
    `runtime_boundary_verdict ${JSON.stringify(log)} ${JSON.stringify(root)}`,
  ], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').trim();
}

const failOn = (file: string) => JSON.stringify({
  verdict: 'fail',
  findings: [{ file, severity: 'blocking', claim: 'a boundary is crossed here' }],
});

describe('a gate verdict is a decision', () => {
  it('a pass is a pass', () => {
    expect(verdict(JSON.stringify({ verdict: 'pass', findings: [] }))).toBe('pass');
  });

  it('a warn is a warn', () => {
    expect(verdict(JSON.stringify({ verdict: 'warn', findings: [] }))).toBe('warn');
  });

  it('a fail BLOCKS when its finding names a file that exists', () => {
    expect(verdict(failOn('real.ts'), { withRealFile: true })).toBe('fail');
  });

  it('a fail is downgraded to warn when the file it names does not exist', () => {
    // A claim about a file that is not there is not evidence, and a gate that blocks on one
    // teaches the operator to ignore it.
    expect(verdict(failOn('imaginary.ts'), { withRealFile: true })).toBe('warn');
  });

  it('an EMPTY log is a warn, never a pass', () => {
    // A gate that could not produce an answer has not cleared the change. This is the fail-open
    // shape that has bitten this pipeline more than once.
    expect(verdict('')).toBe('warn');
  });

  it('an UNPARSEABLE log is a warn, never a pass', () => {
    expect(verdict('the model wrote prose instead of a verdict')).toBe('warn');
  });

  it('a missing log is a warn, never a pass', () => {
    const r = spawnSync('bash', ['-c',
      `set -uo pipefail; SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; . ${JSON.stringify(LIB)}; ` +
      'runtime_boundary_verdict /nonexistent/gate.log /tmp',
    ], { encoding: 'utf8', timeout: 60000 });
    expect((r.stdout || '').trim()).toBe('warn');
  });
});
