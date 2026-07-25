/**
 * B22 — validation classified a WORKING test as unparseable and threw it away.
 *
 * Live (metrolinx 20:09 run): the repro-test-writer produced a test that ran fine —
 * `4 tests | 1 failed`, i.e. a genuine reproducing test failing one assertion,
 * exactly what we want. All three attempts were DISCARDED as `invalid_test`, the
 * ladder escalated to kimi-k3, and the repro-gate then blocked for "no test file".
 * The pipeline threw away a working test three times and failed the run.
 *
 * CAUSE: validation scraped human-readable runner output with a regex list. One
 * pattern was `ERROR: Expected` — meant to catch esbuild's parse error
 * (`ERROR: Expected ";" but found ":"`) — matched case-insensitively against
 * vitest's ordinary `AssertionError: expected undefined to deeply equal ...`.
 * Two unrelated messages, one regex.
 *
 * The exit code cannot separate them (both non-zero), which is what pushed the
 * original implementation to text. But the runner emits a MACHINE-READABLE answer:
 *
 *   assertion failure (VALID):   numTotalTests=1  numFailed=1  suiteMessage=false
 *   parse error      (INVALID):  numTotalTests=0  numFailed=0  suiteMessage=true
 *
 * `numTotalTests > 0` answers the real question — did any test EXECUTE — with a
 * number rather than prose. Verified against a real vitest run of both cases.
 *
 * This was the systemic "prose instead of mechanism" defect committed inside the
 * fix that diagnosed it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = (p: string) => join(__dirname, '../../../orchestrations/scripts/', p);
const WRITER = readFileSync(root('brownfield-repro-test-writer.sh'), 'utf8');
const GATE = readFileSync(root('brownfield-repro-test-gate.sh'), 'utf8');
/** Comment lines stripped: both files DOCUMENT the broken pattern, and a
 *  code-scanning assertion must scan code, not prose about the code. */
const code = (s: string) => s.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const WRITER_CODE = code(WRITER);
const GATE_CODE = code(GATE);

describe('B22 — validation must be deterministic, not regex-on-prose', () => {
  it('the writer asks the runner for machine-readable output', () => {
    expect(WRITER).toMatch(/--reporter[= ]json/);
  });

  it('the writer decides on numTotalTests, not on English phrases', () => {
    expect(WRITER).toMatch(/numTotalTests/);
  });

  it('the gate uses the same deterministic signal', () => {
    expect(GATE).toMatch(/--reporter[= ]json/);
    expect(GATE).toMatch(/numTotalTests/);
  });

  it('the ERROR: Expected pattern that ate AssertionError is gone from both', () => {
    // `AssertionError: expected ...` contains `Error: expected`, which matched
    // `ERROR: Expected` case-insensitively.
    expect(WRITER_CODE).not.toMatch(/ERROR: Expected/);
    expect(GATE_CODE).not.toMatch(/ERROR: Expected/);
  });

  it('an assertion failure is documented as VALID — the point of a repro test', () => {
    // A reproducing test SHOULD fail before the fix; treating that as garbage is
    // the exact defect.
    expect(WRITER).toMatch(/assertion failure[\s\S]{0,200}(valid|ran|executed)/i);
  });

  it('keeps a text fallback for runners with no JSON reporter (never silently strict)', () => {
    expect(WRITER).toMatch(/fallback|no JSON|json unavailable/i);
  });
});

/**
 * BEHAVIOURAL proof, not source-text. The source assertions above would still pass
 * if the logic were subtly wrong; this exercises the real script against a real
 * vitest run of the two cases that matter.
 */
describe('B22 — behaviour against a REAL vitest run', () => {
  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const REPO = join(__dirname, '../../../');

  function repoWith(testBody: string) {
    const d = mkdtempSync(join(tmpdir(), 'validate-real-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), '{"name":"t","private":true}');
    symlinkSync(join(REPO, 'node_modules'), join(d, 'node_modules'));
    writeFileSync(join(d, 'src', 'x.spec.ts'), testBody);
    return d;
  }

  /** Runs the writer's own _validate_written_test against a real file.
   *  The function is extracted to a file and SOURCED — an unquoted $(sed ...) in
   *  command position gets word-split and mangles the definition (rc 127). */
  function validate(dir: string): number {
    const WRITER_SH = join(REPO, 'orchestrations/scripts/brownfield-repro-test-writer.sh');
    const fnFile = join(dir, '_fn.sh');
    execFileSync('bash', ['-c',
      `sed -n '/^_validate_written_test() {/,/^}/p' ${JSON.stringify(WRITER_SH)} > ${JSON.stringify(fnFile)}`]);
    const script = [
      'set -uo pipefail',
      `PROJECT_ROOT=${JSON.stringify(dir)}`,
      `NODE_BIN=${JSON.stringify(process.execPath)}`,
      '_writer_log=/dev/null',
      `source ${JSON.stringify(fnFile)}`,
      '_validate_written_test "src/x.spec.ts"; echo "RC=$?"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    return Number((out.match(/RC=(\d+)/) || [])[1] ?? -1);
  }

  it('an ASSERTION FAILURE is VALID (rc 0) — this is what broke the live run', () => {
    // Exactly the shape that was discarded 3x: `AssertionError: expected ...`
    const d = repoWith(
      "import { it, expect } from 'vitest';\n" +
      "it('reproduces', () => { expect(undefined).toEqual({ name: '' }); });\n");
    try { expect(validate(d), 'a running test that fails an assertion must be VALID').toBe(0); }
    finally { rmSync(d, { recursive: true, force: true }); }
  }, 60000);

  it('a PARSE ERROR is INVALID (rc 1)', () => {
    const d = repoWith("const x = { a: 1 } as any,\n  prices: [\n");
    try { expect(validate(d)).toBe(1); }
    finally { rmSync(d, { recursive: true, force: true }); }
  }, 60000);

  it('a PASSING test is VALID (rc 0)', () => {
    const d = repoWith("import { it, expect } from 'vitest';\nit('ok', () => expect(1).toBe(1));\n");
    try { expect(validate(d)).toBe(0); }
    finally { rmSync(d, { recursive: true, force: true }); }
  }, 60000);
});
