/**
 * A generated test must TYPECHECK, not merely execute.
 *
 * Live metrolinx, 2026-07-25: the repro-test-writer produced a spec that ran
 * green — 35 files, 164 tests, vitest PASS — and then Step 19 killed the run:
 *
 *   apply-report-discounts.service.spec.ts(90,7): error TS2352
 *     Property 'product' is missing in type '{ id, quantity, prices }'
 *     but required in type 'OrderLineItem'
 *
 * The fix, the test, the repro-gate and the team-lead review had all passed. The
 * run died on a mock object missing a required field.
 *
 * _validate_written_test decides on numTotalTests > 0 — did tests EXECUTE. A test
 * can execute and still fail to compile, because vitest strips types rather than
 * checking them. So the writer accepted its own broken output at attempt 2, when
 * it still had a retry and a stronger model available, and the defect surfaced
 * five steps later where nothing could act on it.
 *
 * THE CONSTRAINT THAT MAKES THIS HARD: brownfield repos have PRE-EXISTING type
 * errors. Failing on any tsc error would reject good tests in every real client
 * repo — the same false-positive trap the tsc baseline gate elsewhere solves by
 * diffing. Here the scope is narrower and simpler: only errors IN THE FILE JUST
 * WRITTEN count.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const WRITER_SH = join(REPO, 'orchestrations/scripts/brownfield-repro-test-writer.sh');

function repoWith(specBody: string, extraFiles: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'typecheck-real-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'package.json'), '{"name":"t","private":true}');
  writeFileSync(join(d, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'ESNext',
      moduleResolution: 'node', skipLibCheck: true, types: [] },
    include: ['src/**/*.ts'],
  }));
  symlinkSync(join(REPO, 'node_modules'), join(d, 'node_modules'));
  // The project declares HOW it verifies itself. The engine no longer runs a compiler it chose;
  // it runs the project's declared command (orchestrations/plugins/verification-plugin.js), so a
  // fixture without this manifest is a repo that has declared nothing — which the gate correctly
  // reports as UNKNOWN rather than as passing. A real checkout gets this written at provisioning
  // time by _epam_write_verification_manifest.
  mkdirSync(join(d, '.epam'), { recursive: true });
  writeFileSync(join(d, '.epam', 'verification.json'), JSON.stringify({
    typecheck: { command: './node_modules/.bin/tsc --noEmit' },
  }));
  writeFileSync(join(d, 'src', 'x.spec.ts'), specBody);
  for (const [rel, body] of Object.entries(extraFiles)) writeFileSync(join(d, rel), body);
  return d;
}

function validate(dir: string): number {
  const fnFile = join(dir, '_fn.sh');
  execFileSync('bash', ['-c',
    // _run_project_verification is extracted too: the typecheck no longer invokes a compiler the
    // engine names, it calls that helper (which runs the project's DECLARED command). Without it
    // in the harness the call is a missing command, the grep matches nothing, and a spec that
    // does not compile is reported as passing — the harness would prove the opposite of its name.
    `for f in _run_project_verification _typecheck_written_test _validate_written_test; do ` +
    `sed -n "/^\${f}() {/,/^}/p" ${JSON.stringify(WRITER_SH)}; done > ${JSON.stringify(fnFile)}`]);
  const script = [
    'set -uo pipefail',
    `PROJECT_ROOT=${JSON.stringify(dir)}`,
    `NODE_BIN=${JSON.stringify(process.execPath)}`,
    // The verification helper resolves the plugin under AUTOMATION_DIR, which the real script
    // always has. Without it the helper cannot find the plugin, returns "missing", and the
    // harness reports a non-compiling spec as accepted.
    `AUTOMATION_DIR=${JSON.stringify(join(REPO, 'orchestrations'))}`,
    '_writer_log=/dev/null',
    `source ${JSON.stringify(fnFile)}`,
    '_validate_written_test "src/x.spec.ts"; echo "RC=$?"',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return Number((out.match(/RC=(\d+)/) || [])[1] ?? -1);
}

/**
 * Passes vitest, fails tsc — the live shape.
 *
 * Note the extra `prices` field. A plain SUBSET (`{id, quantity} as OrderLineItem`)
 * does NOT error: TypeScript considers it sufficiently overlapping and allows the
 * assertion. The live failure had a property absent from the target type, which is
 * what makes the two types non-overlapping and triggers TS2352. A fixture without
 * it silently proves nothing.
 */
const TYPE_ERROR_SPEC = `
import { describe, it, expect } from 'vitest';
interface OrderLineItem { id: string; product: string; quantity: number; }
describe('discount', () => {
  it('applies', () => {
    const item = { id: 'a', quantity: 1, prices: [{ quantity: 1, discounts: [] }] } as OrderLineItem;
    expect(item.id).toBe('a');
  });
});
`;

const CLEAN_SPEC = `
import { describe, it, expect } from 'vitest';
describe('discount', () => {
  it('applies', () => { expect(1 + 1).toBe(2); });
});
`;

describe('generated tests must typecheck, not just run', () => {
  it('REJECTS a test that passes vitest but fails tsc', () => {
    const rc = validate(repoWith(TYPE_ERROR_SPEC));
    expect(rc,
      'a test that runs green but does not compile was accepted — the run dies ' +
      'five steps later at the pre-review gate, where nothing can fix it')
      .not.toBe(0);
  }, 120000);

  it('ACCEPTS a clean test', () => {
    expect(validate(repoWith(CLEAN_SPEC)), 'a valid test was rejected').toBe(0);
  }, 120000);

  it('ACCEPTS a clean test in a repo with PRE-EXISTING type errors elsewhere', () => {
    // The brownfield reality. Failing on any tsc error would reject good tests in
    // every real client repo.
    const rc = validate(repoWith(CLEAN_SPEC, {
      'src/legacy.ts': 'export const broken: number = "not a number";\n',
    }));
    expect(rc,
      'a pre-existing error elsewhere in the repo rejected a perfectly good test')
      .toBe(0);
  }, 120000);
});
