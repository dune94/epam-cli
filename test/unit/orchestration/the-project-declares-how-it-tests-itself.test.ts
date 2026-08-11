/**
 * RUNNING THE SUITE IS A PROJECT FACT, NOT AN ENGINE FACT.
 *
 * `run_external_verification` is the check that runs INSIDE the writer's retry loop — the one
 * that decides whether an attempt is kept or retried. It read `technicalNotes.testCommand` from
 * the PRD, and when that was empty it fell back to a block that hardcoded four ecosystem facts:
 *
 *     [ -f "$PROJECT_ROOT/package.json" ]                      # manifest filename
 *     jq -r '.scripts.test' package.json                       # a key inside it
 *     test_cmd="npm test"                                      # the command
 *     select(test("\\.(test|spec)\\.[jt]sx?$"))                # test-file naming convention
 *
 * Hardcoding is permitted in plugins. None of that is a plugin.
 *
 * WHAT IT COST, live 2026-08-11 (AMSD-2041/gotransit). The fallback also required the STORY to
 * declare a test file of its own (`_owns_test_file > 0`). A brownfield story modifying existing
 * code declares source files, never test files, so that is 0 by definition. The chain ran:
 *
 *     testCommand empty -> repo HAS scripts.test -> story owns 0 test files
 *       -> fallback declines -> test_cmd stays empty -> `[ -z "$test_cmd" ] && return 0`
 *
 * return 0 is PASS. The writer was told its change passed the tests; nothing had run. It had
 * added an import of a package that ships untranspiled sources, and ten previously-green suites
 * failed at import time. Every one of the writer's 8 retry attempts was blind to it.
 *
 * THE GUARD IT MISFIRED FROM WAS CORRECT. It was added 2026-07-08 for a scaffold story whose
 * only job was writing a manifest: running the suite then failed because no test files existed
 * ANYWHERE yet, the analyst misdiagnosed "missing test files", tried to create one, and the
 * scope-guard blocked the write — a guaranteed infinite loop. That state is real and must still
 * be skipped. But "this repo has no tests at all" and "this story declares no test file" are
 * different states, and only the first justifies skipping.
 *
 * So: the project declares how it runs its suite and how it recognises a test file; the plugin
 * answers both; the engine keeps only the generic decision.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const PLUGIN = join(ROOT, 'orchestrations/plugins/verification-plugin.js');
const CLAUDE = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo(manifest: unknown | null, files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'testdecl-')); dirs.push(d);
  if (manifest !== null) {
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/verification.json'), JSON.stringify(manifest, null, 2));
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(d, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return d;
}

function plugin() {
  delete require.cache[require.resolve(PLUGIN)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require(PLUGIN);
}

describe('the plugin exposes a suite contract', () => {
  it('runTests, detectTests and isTestFile are exported', () => {
    const p = plugin();
    expect(typeof p.runTests, 'runTests must be exported').toBe('function');
    expect(typeof p.detectTests, 'detectTests must be exported').toBe('function');
    expect(typeof p.isTestFile, 'isTestFile must be exported').toBe('function');
    expect(typeof p.repoHasTests, 'repoHasTests must be exported').toBe('function');
  });
});

describe('UNDECLARED IS NOT A PASS', () => {
  it('a repo with no manifest reports unknown', () => {
    const r = plugin().runTests(repo(null));
    expect(r.status, 'an undeclared suite must never report pass').toBe('unknown');
    expect(r.reason).toBeTruthy();
  });

  it('a manifest with no test section reports unknown', () => {
    const r = plugin().runTests(repo({ typecheck: { command: 'true' } }));
    expect(r.status).toBe('unknown');
  });

  it('a test section with an empty command reports unknown', () => {
    const r = plugin().runTests(repo({ test: { command: '   ' } }));
    expect(r.status).toBe('unknown');
  });
});

describe('the declared command is what runs', () => {
  it('a passing command reports pass with its output', () => {
    const r = plugin().runTests(repo({ test: { command: 'echo 12 passed' } }));
    expect(r.status).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('12 passed');
  });

  it('a failing command reports fail, its exit code and its own output', () => {
    const r = plugin().runTests(repo({ test: { command: 'echo 10 failed >&2; exit 3' } }));
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(3);
    expect(r.output, 'the runner output is what the writer needs to act on').toContain('10 failed');
  });

  it('${PROJECT_ROOT} is substituted, so one manifest survives a worktree checkout', () => {
    const d = repo({ test: { command: 'echo ROOT=${PROJECT_ROOT}' } });
    const r = plugin().runTests(d);
    expect(r.output).toContain(d);
  });
});

describe('WHICH FILES ARE TESTS is declared, not assumed', () => {
  it('isTestFile uses the project pattern', () => {
    const d = repo({ test: { command: 'true', testFilePattern: '_test\\.py$' } });
    const p = plugin();
    expect(p.isTestFile(d, 'app/thing_test.py')).toBe(true);
    expect(p.isTestFile(d, 'app/thing.spec.ts'), 'an undeclared convention must not match').toBe(false);
  });

  it('a repo declaring no pattern cannot claim a file is or is not a test', () => {
    const d = repo({ test: { command: 'true' } });
    expect(plugin().isTestFile(d, 'anything.spec.ts')).toBeNull();
  });
});

describe('THE SCAFFOLD GUARD: "no tests anywhere" is not "this story owns none"', () => {
  it('a repo with no test files at all reports false', () => {
    const d = repo(
      { test: { command: 'true', testFilePattern: '\\.spec\\.ts$' } },
      { 'src/app.ts': 'export const a = 1;' },
    );
    expect(plugin().repoHasTests(d), 'the scaffold case the original guard existed for').toBe(false);
  });

  it('a repo WITH test files reports true even when the story declares none', () => {
    // This is the brownfield case that was silently skipping the suite.
    const d = repo(
      { test: { command: 'true', testFilePattern: '\\.spec\\.ts$' } },
      { 'src/app.ts': 'export const a = 1;', 'src/app.spec.ts': 'it("x", () => {});' },
    );
    expect(
      plugin().repoHasTests(d),
      'a brownfield story declares source files, never test files — skipping on that basis ' +
      'made every brownfield change bypass suite verification',
    ).toBe(true);
  });

  it('a repo that declared no pattern reports null, not false', () => {
    // false would re-create the fail-open: "we could not tell" read as "there are none".
    const d = repo({ test: { command: 'true' } }, { 'src/app.spec.ts': '' });
    expect(plugin().repoHasTests(d)).toBeNull();
  });
});

describe('detection reads the repo, and never guesses', () => {
  it('an unrecognised repo yields null rather than an invented command', () => {
    expect(plugin().detectTests(repo(null))).toBeNull();
  });
});

describe('NO ECOSYSTEM FACT REMAINS IN THE ENGINE', () => {
  const fn = (() => {
    const src = readFileSync(CLAUDE, 'utf8');
    const start = src.indexOf('run_external_verification() {');
    expect(start, 'run_external_verification moved — this test is anchored on it').toBeGreaterThan(0);
    const end = src.indexOf('\n}\n', start);
    // Comments stripped: mutation-verified 2026-08-11 that a `toContain` assertion otherwise
    // passes on the explanatory comment naming the very thing it forbids.
    return src.slice(start, end)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  })();

  it('the function is non-empty, so these assertions are not vacuous', () => {
    expect(fn.length).toBeGreaterThan(200);
  });

  for (const banned of ['package.json', 'scripts.test', 'npm test', 'spec)\\.', 'jsx?$']) {
    it(`does not name '${banned}'`, () => {
      expect(
        fn,
        `'${banned}' is an ecosystem fact. The suite command and the test-file convention are ` +
        'PROJECT declarations — hardcoding is permitted in plugins, and this is not a plugin.',
      ).not.toContain(banned);
    });
  }

  it('it routes through the plugin-backed declaration instead', () => {
    // Each of these reads .epam/verification.json via verification-plugin.js.
    for (const helper of ['_project_repo_has_tests', '_project_test_command']) {
      expect(fn, `the engine must ask the project via ${helper}`).toContain(helper);
    }
  });

  it('the scaffold guard now asks whether the REPO has tests, not whether the STORY owns one', () => {
    // The original guard's question (`_owns_test_file > 0`) is 0 for every brownfield story,
    // which is what made the suite check a no-op on AMSD-2041.
    expect(fn).not.toContain('_owns_test_file');
    expect(fn).toContain('_repo_has_tests');
  });

  it('an UNDECLARED test-file convention does not silently skip the suite', () => {
    // "unknown" must not be treated as "false" — that is the fail-open being removed.
    expect(fn).toMatch(/"\$_repo_has_tests" = "false"/);
  });
});

/**
 * PROVISIONING — the seam where the declaration was silently absent.
 *
 * _epam_write_verification_manifest generated the manifest by calling detectVerification ONLY,
 * so the `test` section never existed in any codeline. Every reader of it therefore fell back
 * to whatever the engine assumed, which is the hardcoding this change removes. Detecting a test
 * command is worthless if nothing writes it down.
 */
describe('PROVISIONING writes both sections and preserves operator edits', () => {
  const GITOPS = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');

  function provision(dir: string): { code: number } {
    const { spawnSync } = require('node:child_process');
    // EXPORTED, not an assignment prefix. `VAR=x . file; func` scopes VAR to the `.` builtin
    // only, so the function ran with AUTOMATION_DIR unset, the plugin path failed to resolve,
    // and `[ -f "$_plugin" ] || return 0` returned silently — a green-looking no-op. The first
    // version of this test failed for exactly that reason and the code was fine.
    const r = spawnSync('bash', ['-c',
      `export AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"; export NODE_CMD="${process.execPath}"; ` +
      `. "${GITOPS}" >/dev/null 2>&1; _epam_write_verification_manifest "${dir}"`,
    ], { encoding: 'utf8' });
    return { code: r.status ?? 1 };
  }

  it('writes a test section, not just typecheck', () => {
    const d = repo(null, {
      'package.json': JSON.stringify({ scripts: { test: 'jest', 'check-types': 'tsc --noEmit' } }),
    });
    provision(d);
    const m = JSON.parse(readFileSync(join(d, '.epam/verification.json'), 'utf8'));
    expect(m.typecheck, 'typecheck must still be written').toBeTruthy();
    expect(m.test, 'the test section was never written before this change').toBeTruthy();
    expect(m.test.command).toBeTruthy();
    expect(m.test.testFilePattern).toBeTruthy();
  });

  it('does NOT overwrite a declaration the operator already tuned', () => {
    const d = repo(
      { test: { command: 'my-custom-runner --ci', testFilePattern: 'CUSTOM$' } },
      { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) },
    );
    provision(d);
    const m = JSON.parse(readFileSync(join(d, '.epam/verification.json'), 'utf8'));
    expect(
      m.test.command,
      'detection is a default, not an authority — a hand-tuned command must survive provisioning',
    ).toBe('my-custom-runner --ci');
  });

  it('a repo whose stack is unrecognised gets no invented manifest', () => {
    const d = repo(null, { 'README.md': 'nothing detectable' });
    provision(d);
    expect(existsSync(join(d, '.epam/verification.json'))).toBe(false);
  });
});
