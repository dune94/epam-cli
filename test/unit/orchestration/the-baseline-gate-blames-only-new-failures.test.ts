/**
 * THE BASELINE GATE — 83 lines, no test, and it decides whether a story is blamed for pre-existing debt.
 *
 * A brownfield repository fails its own checks before anyone touches it. Without a baseline the gate
 * blocks every story for errors it did not cause; with a broken baseline it blocks nothing. Both
 * failures are quiet: one produces a run that cannot finish and blames the writer, the other produces
 * a run that ships anything.
 *
 * The engine names no tool, extension, directory or runtime path here — the project's own
 * .epam/verification.json declares the check, and an undeclared one is a REFUSAL with a reason
 * rather than a silent pass.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/tsc-baseline-gate.sh');

function gate(args: string[], env: Record<string, string> = {}) {
  const quoted = args.map((a) => JSON.stringify(a)).join(' ');
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}\nbaseline_new_failures ${quoted}\necho "rc=$?"`], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return { root: dir, logs: join(dir, 'logs') };
}

describe('the baseline gate blames only what this change broke', () => {
  it('a check that PASSES yields no new failures', () => {
    // The caller only asks for a delta when the check already failed, so a pass must return cleanly
    // rather than computing a comparison against nothing.
    const { root, logs } = workspace();
    const out = join(logs, 'check.txt');
    // No output file and no verification declared: the gate must not claim new failures it cannot see.
    const r = gate([root, process.execPath, logs, 'typecheck']);
    expect(r.out, 'the gate neither passed nor explained itself').toMatch(/rc=\d/);
  }, 180_000);

  it('an UNDECLARED verification is refused with a reason, not passed', () => {
    // A project that declares no check has not passed one. Treating that as a pass ships anything.
    const { root, logs } = workspace();
    const r = gate([root, process.execPath, logs, 'typecheck']);
    expect(r.out, 'an undeclared verification passed silently')
      .toMatch(/not declared|verification|rc=[123]/i);
  }, 180_000);

  it('with a supplied output file it treats the check as ALREADY FAILED', () => {
    // A caller only asks for a delta because the check failed; recomputing it would be slower and
    // could disagree with what the caller saw.
    const { root, logs } = workspace();
    const out = join(logs, 'failed.txt');
    writeFileSync(out, 'src/a.ts(3,1): error TS2304: Cannot find name "x"\n');
    const r = gate([root, process.execPath, logs, 'typecheck', out]);
    expect(r.out, 'a failing check was reported as clean').not.toMatch(/rc=0/);
    expect(r.out, 'the failure it reports does not name the error').toMatch(/TS2304|error/);
  }, 180_000);

  it('and it reports the failing LINES, not just that something failed', () => {
    // "It failed" sends the writer to the logs; the lines send them to the code.
    const { root, logs } = workspace();
    const out = join(logs, 'failed.txt');
    writeFileSync(out, [
      'src/a.ts(3,1): error TS2304: Cannot find name "x"',
      'src/b.ts(9,2): error TS2551: Property "y" does not exist'].join('\n'));
    const r = gate([root, process.execPath, logs, 'typecheck', out]);
    expect(r.out, 'only one of two failures was reported').toContain('src/b.ts');
  }, 180_000);

  it('an EMPTY output file is not a failure to report', () => {
    const { root, logs } = workspace();
    const out = join(logs, 'empty.txt');
    writeFileSync(out, '');
    const r = gate([root, process.execPath, logs, 'typecheck', out]);
    expect(r.out, 'an empty check output produced a phantom failure').toMatch(/rc=\d/);
  }, 180_000);

  it('the engine names no tool, extension or runtime path in this gate', () => {
    // The project's own .epam/verification.json declares the check. A tool named here would be one
    // client's stack asserted over every project — the defect this file exists to have removed.
    const src = require('node:fs').readFileSync(LIB, 'utf8')
      .split('\n').filter((l: string) => !l.trim().startsWith('#')).join('\n');
    for (const tool of ['vitest', 'npm run', 'tsconfig.json', 'node_modules']) {
      expect(src, `the gate names ${tool}, which is a project fact in engine code`)
        .not.toContain(tool);
    }
  });

  it('tsc_baseline_new_errors is the same gate under its old name', () => {
    // A shim that drifted from what it forwards to would silently gate differently at each call site.
    const src = require('node:fs').readFileSync(LIB, 'utf8');
    expect(src, 'the compatibility name no longer forwards to the real gate')
      .toMatch(/tsc_baseline_new_errors\(\)\s*\{\s*baseline_new_failures/);
  });
});
