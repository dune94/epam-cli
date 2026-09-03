/**
 * THE SHELL HALF OF THIS ENGINE IS MEASURED, AND MEASURED THE SAME WAY THE JS HALF IS.
 *
 * 138 files and 28,558 code lines are bash. The JS instrument sees none of them, so every shell file
 * counted as wholly uncovered and no shell-heavy stage could ever clear a threshold — which reads as
 * "shell is untestable" when it is really a missing conversion step.
 *
 * Two failures matter more than the happy path:
 *
 *   A COLLECTOR THAT PRODUCED NOTHING MUST NOT REPORT 0%. That looks identical to "the tests are
 *   bad" and sends someone writing tests that already exist.
 *
 *   THE NUMERATOR AND DENOMINATOR MUST USE ONE DEFINITION. If the converter credits a line the gate
 *   does not count as executable, a file can report more covered lines than it has.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const CONVERTER = join(REPO, 'orchestrations/scripts/lib/handlers/shell-trace-to-lcov.js');
const NODE = process.execPath;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { executableLineNumbers, isStructural } = require(
  join(REPO, 'orchestrations/scripts/lib/handlers/executable-lines.js'));

/** A real shell tree, traced by really running it — no hand-authored trace fixture. */
function traced(scripts: Record<string, string>, entry: string) {
  const dir = mkdtempSync(join(tmpdir(), 'shcov-'));
  mkdirSync(join(dir, 'orchestrations/scripts'), { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, 'orchestrations/scripts', name), body);
  }
  const enabler = join(dir, 'on.sh');
  writeFileSync(enabler, [
    'if [ -n "${SHCOV_TRACE:-}" ]; then',
    '  exec 9>>"$SHCOV_TRACE"',
    '  BASH_XTRACEFD=9',
    "  PS4='@@${BASH_SOURCE}:${LINENO}@@\n'",
    '  set -x',
    'fi',
  ].join('\n'));
  const trace = join(dir, 'trace');
  writeFileSync(trace, '');
  const r = spawnSync('bash', [join(dir, 'orchestrations/scripts', entry)], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SHCOV_TRACE: trace, BASH_ENV: enabler },
  });
  return { dir, trace, run: r };
}

function convert(dir: string, trace: string) {
  const out = join(dir, 'out.lcov');
  const cfg = join(dir, 'stage-coverage.json');
  writeFileSync(cfg, JSON.stringify({
    roots: ['orchestrations/scripts'], excludePattern: 'node_modules',
  }));
  const r = spawnSync(NODE, [CONVERTER, trace, out], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SHELL_COVERAGE_ROOT: dir, STAGE_COVERAGE_CONFIG: cfg },
  });
  let lcov = '';
  try { lcov = readFileSync(out, 'utf8'); } catch { /* absent is the finding */ }
  return { status: r.status, stderr: r.stderr ?? '', lcov };
}

/** DA lines for one file, as line -> hit. */
function daFor(lcov: string, file: string) {
  const block = lcov.split('SF:').find((b) => b.startsWith(file));
  const map = new Map<number, number>();
  if (!block) return map;
  for (const m of block.matchAll(/DA:(\d+),(\d+)/g)) map.set(Number(m[1]), Number(m[2]));
  return map;
}

describe('shell coverage measures shell', () => {
  it('a line that RAN is covered and a line that did not is not — really executed, not simulated', () => {
    const { dir, trace, run } = traced({
      'main.sh': [
        '#!/usr/bin/env bash',                       // 1 comment
        'ran_this=1',                                // 2 RUNS
        'if [ "1" = "2" ]; then',                    // 3 RUNS (the test itself)
        '  never_ran=1',                             // 4 NEVER
        'fi',                                        // 5 structural
        'echo "$ran_this" > /dev/null',              // 6 RUNS
      ].join('\n'),
    }, 'main.sh');
    expect(run.status, run.stderr).toBe(0);
    const { status, lcov, stderr } = convert(dir, trace);
    expect(status, stderr).toBe(0);
    const da = daFor(lcov, 'orchestrations/scripts/main.sh');
    expect(da.size, 'nothing was emitted for a file that demonstrably ran').toBeGreaterThan(0);
    expect(da.get(2), 'a line that ran is reported uncovered').toBe(1);
    expect(da.get(6), 'a line that ran is reported uncovered').toBe(1);
    expect(da.get(4), 'a line inside a false branch is reported COVERED').toBe(0);
    expect(da.has(5), 'a structural `fi` is in the denominator — nobody can ever hit it').toBe(false);
  }, 120_000);

  it('and it follows into a file the script SOURCES — the real library, not a copy', () => {
    // The point of tracing rather than instrumenting: a test that sources lib.sh measures lib.sh.
    const { dir, trace } = traced({
      'lib.sh': ['#!/usr/bin/env bash',              // 1
        'used() { echo used; }',                     // 2 declaration — never traced
        'unused() { echo unused; }',                 // 3 declaration — never traced
      ].join('\n'),
      'main.sh': ['#!/usr/bin/env bash',
        '. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"',
        'used > /dev/null',
      ].join('\n'),
    }, 'main.sh');
    const { lcov } = convert(dir, trace);
    expect(lcov, 'the sourced library does not appear at all').toContain('SF:orchestrations/scripts/lib.sh');
    const da = daFor(lcov, 'orchestrations/scripts/lib.sh');
    // `echo used` executes on line 2, inside the function body on the same physical line.
    expect([...da.values()].some((v) => v === 1), 'nothing in the sourced file registered').toBe(true);
  }, 120_000);

  it('a file NOTHING ran still appears, every line uncovered — that is the list worth having', () => {
    const { dir, trace } = traced({
      'main.sh': '#!/usr/bin/env bash\necho hi > /dev/null\n',
      'never-run.sh': '#!/usr/bin/env bash\nnothing_calls_this=1\necho x > /dev/null\n',
    }, 'main.sh');
    const { lcov } = convert(dir, trace);
    expect(lcov, 'an unexercised file was omitted, hiding it from the denominator')
      .toContain('SF:orchestrations/scripts/never-run.sh');
    const da = daFor(lcov, 'orchestrations/scripts/never-run.sh');
    expect(da.size, 'no lines counted for the unexercised file').toBeGreaterThan(0);
    expect([...da.values()].every((v) => v === 0), 'an unexecuted file reported covered lines')
      .toBe(true);
  }, 120_000);

  it('AN EMPTY TRACE IS A BROKEN COLLECTOR, NOT 0% COVERAGE', () => {
    // Reporting 0 here looks exactly like "the tests are bad" and sends someone writing tests that
    // already exist. The collector must say it did not run.
    const dir = mkdtempSync(join(tmpdir(), 'shcov-empty-'));
    mkdirSync(join(dir, 'orchestrations/scripts'), { recursive: true });
    writeFileSync(join(dir, 'orchestrations/scripts/a.sh'), '#!/usr/bin/env bash\nx=1\necho $x\n');
    const trace = join(dir, 'trace');
    writeFileSync(trace, '');
    const { status, stderr } = convert(dir, trace);
    expect(status, 'an empty trace was reported as a coverage result').not.toBe(0);
    expect(stderr, 'the refusal does not say the collector failed to run')
      .toMatch(/recorded NOTHING|not a coverage result|did not run/i);
  }, 120_000);

  it('the numerator never credits a line the denominator does not count', () => {
    // bash attributes some constructs to a neighbouring physical line. Crediting a hit on a line the
    // shared definition calls structural would let a file report more covered lines than it has.
    const { dir, trace } = traced({
      'main.sh': ['#!/usr/bin/env bash',
        'for i in 1 2; do',
        '  echo "$i" > /dev/null',
        'done',
        'x=$(echo hello)',
        'echo "$x" > /dev/null',
      ].join('\n'),
    }, 'main.sh');
    const { lcov } = convert(dir, trace);
    const da = daFor(lcov, 'orchestrations/scripts/main.sh');
    const src = readFileSync(join(dir, 'orchestrations/scripts/main.sh'), 'utf8');
    const executable: Set<number> = executableLineNumbers(src);
    for (const line of da.keys()) {
      expect(executable.has(line),
        `line ${line} is in the lcov but the shared definition says it cannot execute`).toBe(true);
    }
    const lf = Number(/LF:(\d+)/.exec(lcov.split('SF:orchestrations/scripts/main.sh')[1])?.[1]);
    expect(lf, 'the denominator disagrees with the shared definition').toBe(executable.size);
  }, 120_000);

  it('a function declaration is excluded — bash never traces it, so counting it is an unhittable miss', () => {
    expect(isStructural('foo() {'), 'a declaration is counted, guaranteeing a permanent miss').toBe(true);
    expect(isStructural('function foo {')).toBe(true);
    expect(isStructural('done')).toBe(true);
    expect(isStructural('echo hi'), 'a real command was excluded from the denominator').toBe(false);
    expect(isStructural('x=1')).toBe(false);
  });
});
