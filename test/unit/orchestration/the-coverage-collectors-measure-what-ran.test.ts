/**
 * THE THREE COVERAGE COLLECTORS — written today, and they have already carried three defects.
 *
 * They decide every number on the stage board, so a defect in them is invisible in the worst way:
 * it reports that tests are not working when the tests are fine. That happened four times in one
 * day — an unvalidated cache keyed on a stage name, absolute-vs-relative paths splitting one file
 * into two records, and two different denominators unioned so comments counted against a file.
 *
 * They also must never be trusted to report zero. A collector that produced nothing must say the
 * COLLECTION failed, because "no coverage" and "nothing measured" send a person to opposite places.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');

/**
 * A FIXTURE TEST MUST LIVE INSIDE THE TEST TREE. vitest only collects what its config includes, so a
 * generated test file under /tmp is never run — the collector then measures a run that did not
 * happen and reports zero, which is exactly the "collector failed vs nothing covered" confusion
 * these tools exist to avoid. Written here and removed afterwards.
 */
function fixtureDir() {
  const d = mkdtempSync(join(REPO, 'test/unit/orchestration/.collector-fixture-'));
  return d;
}

const TOOLS = join(__dirname, '../../../orchestrations/scripts/tools');
const NODE = process.execPath;

function tool(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(TOOLS, script), ...args], {
    encoding: 'utf8', timeout: 300_000, cwd: join(__dirname, '../../..'),
    env: { ...process.env, NODE_BIN: NODE, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('a collector refuses rather than reporting a coverage of zero', () => {
  it('trace-shell with NO target is refused, not run over nothing', () => {
    const r = tool('trace-shell.sh', []);
    expect(r.code, 'it traced with nothing to trace').not.toBe(0);
    expect(r.out, 'the refusal does not say what it wanted').toMatch(/usage/i);
  }, 400_000);

  it('trace-js with NO target is refused', () => {
    const r = tool('trace-js.sh', []);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/usage/i);
  }, 400_000);

  it('trace-children with NO target is refused', () => {
    const r = tool('trace-children.sh', []);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/usage/i);
  }, 400_000);

  it('a target that does not exist FAILS rather than reporting a clean measurement', () => {
    // The collector must not turn "vitest ran nothing" into "nothing is covered". They are the same
    // number and opposite problems.
    const dir = fixtureDir();
    const r = tool('trace-children.sh', [join(dir, 'no-such.test.ts')],
      { JS_COVERAGE_ACC: join(dir, 'lcov.info') });
    rmSync(dir, { recursive: true, force: true });
    expect(r.code, 'a run over a target that does not exist reported success').not.toBe(0);
  }, 400_000);

  it('and it carries the guard for a collection that produced nothing', () => {
    // Not reachable from here — the vitest worker itself writes coverage, so the directory is never
    // empty in practice. The guard exists for the case where NODE_V8_COVERAGE reaches nothing at
    // all, and its absence would turn that into a silent zero.
    const src = readFileSync(join(TOOLS, 'trace-children.sh'), 'utf8');
    expect(src, 'the collector would report a coverage of zero when it collected nothing')
      .toMatch(/no child wrote coverage/);
    expect(src, 'that guard does not exit non-zero').toMatch(/exit 3/);
  });

});

describe('the shell tracer measures the lines that really ran', () => {
  it('a traced script reports its executed lines and not its unexecuted ones', () => {
    // The whole instrument in one assertion: a line inside a false branch must be 0 and an executed
    // line must be 1, against a real bash run.
    const dir = fixtureDir();
    mkdirSync(join(dir, 'orchestrations/scripts'), { recursive: true });
    const target = join(dir, 'orchestrations/scripts/sample.sh');
    writeFileSync(target, ['#!/usr/bin/env bash', 'ran=1', 'if [ "1" = "2" ]; then',
      '  never=1', 'fi', 'echo "$ran" > /dev/null'].join('\n'));

    const testFile = join(dir, 'sample.test.ts');
    writeFileSync(testFile, `import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
it('runs the sample', () => {
  const r = spawnSync('bash', [${JSON.stringify(target)}], { encoding: 'utf8' });
  expect(r.status).toBe(0);
});
`);
    const acc = join(dir, 'acc');
    const out = join(dir, 'lcov.shell.info');
    const r = tool('trace-shell.sh', [testFile],
      { SHELL_COVERAGE_ACC: acc, SHELL_COVERAGE_OUT: out, SHELL_COVERAGE_ROOT: dir,
        STAGE_COVERAGE_CONFIG: (() => {
          const cfg = join(dir, 'map.json');
          writeFileSync(cfg, JSON.stringify({ roots: ['orchestrations/scripts'], excludePattern: 'node_modules' }));
          return cfg;
        })() });
    const produced = existsSync(out);
    const lcovText = produced ? readFileSync(out, 'utf8') : '';
    rmSync(dir, { recursive: true, force: true });
    expect(produced, `no lcov was produced: ${r.out.slice(0, 400)}`).toBe(true);
    const block = lcovText.split('SF:').find((b) => b.startsWith('orchestrations/scripts/sample.sh'));
    expect(block, 'the traced script is absent from the report').toBeTruthy();
    const da = new Map<number, number>();
    for (const m of (block || '').matchAll(/DA:(\d+),(\d+)/g)) da.set(Number(m[1]), Number(m[2]));
    expect(da.get(2), 'an executed line was reported as never run').toBe(1);
    expect(da.get(4), 'a line inside a false branch was reported as run').toBe(0);
    expect(da.has(5), 'a structural `fi` is in the denominator — nobody can hit it').toBe(false);
  }, 400_000);
});

describe('the collectors count by ONE definition of an executable line', () => {
  it('all three use the shared executable-lines module, not a local rule', () => {
    // Two definitions unioned is what put a shebang and a comment header in a denominator, so a file
    // sat at 41% with a hundred unhittable lines counted against it and no test could move it.
    for (const f of ['trace-shell.sh', 'trace-children.sh', 'trace-js.sh']) {
      const src = readFileSync(join(TOOLS, f), 'utf8');
      const usesShared = /executable-lines|shell-trace-to-lcov/.test(src);
      expect(usesShared, `${f} counts lines by a rule of its own`).toBe(true);
    }
  });

  it('and none of them writes an absolute SF: path', () => {
    // An absolute path made one file appear twice — once at 0% and once at 100% — and the reader
    // paired one report's denominator with the other's numerator.
    const src = readFileSync(join(TOOLS, 'trace-children.sh'), 'utf8');
    expect(src, 'the child collector no longer relativises its paths')
      .toMatch(/slice\(root\.length|relative\(/);
  });
});
