/**
 * A CHECK THE PROJECT NEVER DECLARED WAS REPORTED TO THE WRITER AS TYPE ERRORS.
 *
 * _run_project_verification exits 2 when the project declares no typecheck command:
 *
 *     if (r.status === "unknown") { console.log("verification not declared: " + r.reason); exit(2) }
 *
 * The gate treats any non-zero exit as a failed type check, so the writer is told:
 *
 *     "The orchestrator ran the project type check after your files were written and it failed
 *      (exit code 2). Fix the type errors so tsc exits 0."
 *
 * There are no type errors to fix. Live 2026-08-18, mock-a: `npx tsc --noEmit` exits 0, and the
 * plugin's own verdict is "verification manifest declares no typecheck command". The writer spent
 * its attempts hunting errors that do not exist, HealingBroken fired on the repeated diagnosis,
 * and the failure analyst — once it could build its prompt — said so plainly:
 *
 *     "verification.json lacks a typecheck section; code and tests are correct."
 *
 * The sibling lane proves the remedy: mock-b's writer added the typecheck block and its
 * verification now returns status: pass.
 *
 * REFUSING AN UNDECLARED CHECK IS CORRECT and stays — an undeclared repo must not silently pass.
 * What must change is what the writer is TOLD: declare the command, not chase type errors.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const src = () => readFileSync(CLAUDE_SH, 'utf8');

/** The gate's own source, sliced between the verification call and the failure branch. */
function gateBlock() {
  const s = src();
  const start = s.indexOf('_tsc_output=$(_run_project_verification');
  expect(start, 'the verification call moved — this test is blind').toBeGreaterThan(-1);
  return s.slice(start, start + 6000);
}

describe('an undeclared check was reported as type errors', () => {
  it('THE GATE DISTINGUISHES "NOT DECLARED" FROM "FAILED" — exit 2 is not exit 1', () => {
    expect(gateBlock(), 'every non-zero exit is still read as a type-check failure')
      .toMatch(/_tsc_exit["'\s]*(-eq|==|=)\s*["']?2/);
  });

  it('AND TELLS THE WRITER TO DECLARE THE COMMAND, not to fix type errors', () => {
    const block = gateBlock();
    const i = block.search(/_tsc_exit["'\s]*(-eq|==|=)\s*["']?2/);
    const arm = block.slice(i, i + 1200);
    expect(arm, 'the undeclared case does not name the manifest the writer must fix')
      .toMatch(/verification\.json|verification manifest/i);
    expect(arm, 'the undeclared case does not say a typecheck command must be declared')
      .toMatch(/typecheck/i);
  });

  it('does not tell the writer to fix type errors in the undeclared case', () => {
    const block = gateBlock();
    const i = block.search(/_tsc_exit["'\s]*(-eq|==|=)\s*["']?2/);
    const arm = block.slice(i, i + 900);
    expect(arm, 'the writer is still told to fix type errors that do not exist')
      .not.toMatch(/Fix the type errors/);
  });

  it('A REAL TYPE FAILURE IS STILL A FAILURE — the gate is not weakened', () => {
    const block = gateBlock();
    expect(block, 'the genuine type-error path was removed').toMatch(/Fix the type errors/);
    expect(block, 'the failure branch no longer feeds the retry loop')
      .toMatch(/TypeScript errors/);
  });

  it('THE PLUGIN REALLY DOES ANSWER "unknown" FOR AN UNDECLARED REPO — not assumed', () => {
    // Executed against the real plugin with a repo that declares nothing, so the exit-2 path
    // this test pins is the one that actually occurs.
    const r = spawnSync(process.execPath, ['-e', `
      const p = require(${JSON.stringify(join(ROOT, 'orchestrations/plugins/verification-plugin.js'))});
      const out = p.runVerification(process.argv[1]);
      console.log(out.status);
    `, '/nonexistent-repo-for-this-test'], { encoding: 'utf8' });
    expect(`${r.stdout}`.trim(), 'an undeclared repo no longer reports "unknown"').toBe('unknown');
  });
});
