/**
 * mock1-paused-run.sh — the operator-driven pause/restart launcher.
 *
 * THE BUG THIS EXISTS FOR (2026-08-03, live, real money). The first version put the mock
 * codeline INSIDE this repo, at orchestrations/projects/<p>/runs/<id>/workspace/, so it
 * would survive for a later resume. Vitest walks UP the directory tree looking for a
 * config, found epam-cli's own vitest.config.ts —
 *
 *     include: ['test/**\/*.test.ts', 'greet.test.ts']
 *
 * — and the mock's test at src/hello.test.ts matched nothing:
 *
 *     filter:  src/hello.test.ts
 *     include: test/**\/*.test.ts, greet.test.ts
 *     No test files found, exiting with code 1
 *
 * The repro-gate then correctly BLOCKED the story ("the new test could not be
 * parsed/compiled and therefore never ran"), gate remediation fired, and the phase
 * restarted — a full retry cycle caused entirely by where the fixture was placed. The
 * one-word code change was fine the whole time.
 *
 * It also violated a standing rule already in memory (project_test_app_isolation): test
 * app files live OUTSIDE the epam-cli repo; only orchestration scripts and PRDs live in.
 *
 * These tests execute the real script. None of them spend a cent or call an LLM — the
 * launcher's own paths (--list, bad --resume, workspace location) are all reachable
 * without starting a pipeline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(join(__dirname, '../../../'));
const RUNNER = join(REPO_ROOT, 'orchestrations/scripts/mock1-paused-run.sh');
const src = readFileSync(RUNNER, 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [RUNNER, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Ask the script itself where it would put a workspace — no pipeline is started. */
function resolvedWorkspace(env: Record<string, string> = {}): string {
  const probe = spawnSync(
    'bash',
    ['-c', `set -uo pipefail\nMOCK1_PRINT_WORKSPACE=1 bash ${JSON.stringify(RUNNER)} --where`],
    { encoding: 'utf8', timeout: 20000, cwd: REPO_ROOT, env: { ...process.env, ...env } },
  );
  return `${probe.stdout || ''}`.trim();
}

describe('the mock workspace never lands inside the engine repo', () => {
  it('--where reports a workspace path', () => {
    const w = resolvedWorkspace();
    expect(w, 'the launcher cannot say where it would put the workspace').not.toBe('');
    expect(isAbsolute(w), `workspace path is not absolute: ${w}`).toBe(true);
  });

  it('REPRODUCES THE LIVE BUG: the workspace is NOT under the epam-cli repo', () => {
    const w = resolvedWorkspace();
    const rel = relative(REPO_ROOT, w);
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    expect(
      inside,
      `the mock codeline would be created at ${w}, INSIDE ${REPO_ROOT}. Vitest walks up the ` +
        "tree for a config and finds this repo's vitest.config.ts (include: " +
        "['test/**/*.test.ts','greet.test.ts']), so the mock's src/hello.test.ts matches " +
        'nothing, the repro-gate blocks the story, and the phase retries. Live 2026-08-03.',
    ).toBe(false);
  });

  it('no vite/vitest config exists ABOVE the workspace, up to the filesystem root', () => {
    const w = resolvedWorkspace();
    const offenders: string[] = [];
    let dir = w;
    for (let i = 0; i < 40; i += 1) {
      for (const name of ['vitest.config.ts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js']) {
        if (existsSync(join(dir, name))) offenders.push(join(dir, name));
      }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    expect(
      offenders,
      'a parent vitest config will capture the mock codeline and its include pattern will ' +
        "not match the mock's own test file — exactly the live failure",
    ).toEqual([]);
  });

  it('does not hardcode a project name into the workspace path', () => {
    // The engine must run on the next unknown project unmodified.
    expect(resolvedWorkspace()).not.toMatch(/metrolinx|gotransit|upexpress/i);
  });
});

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT. Builds the REAL seed fixture and runs vitest
 * against it — the same discovery the repro-gate performs. No LLM, no pipeline, no spend.
 */
describe('vitest actually discovers the seed fixture\'s test', () => {
  function buildSeed(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mock1-seed-'));
    dirs.push(dir);
    const target = join(dir, 'ws');
    const r = spawnSync('bash', [RUNNER, '--seed', target], {
      encoding: 'utf8', timeout: 120000, cwd: REPO_ROOT,
    });
    expect(r.status, `--seed failed: ${r.stdout}${r.stderr}`).toBe(0);
    return join(target, 'codelines', 'mock-hello-world');
  }

  it('the seed builds a real repo with the test beside the source', () => {
    const clone = buildSeed();
    expect(existsSync(join(clone, 'src/hello.ts'))).toBe(true);
    expect(existsSync(join(clone, 'src/hello.test.ts'))).toBe(true);
  });

  it('the seed ships its OWN vitest config — it must never inherit one', () => {
    const clone = buildSeed();
    expect(
      existsSync(join(clone, 'vitest.config.ts')),
      'without its own config vitest adopts whatever sits above it on disk — which is ' +
        'exactly how the live 2026-08-03 retry cycle happened',
    ).toBe(true);
  });

  it('REPRODUCES THE LIVE FAILURE MODE: vitest FINDS the test, it is not "No test files found"', () => {
    const clone = buildSeed();
    const r = spawnSync(
      'npx', ['vitest', 'run', 'src/hello.test.ts', '--reporter', 'basic'],
      { cwd: clone, encoding: 'utf8', timeout: 180000, env: { ...process.env, CI: '1' } },
    );
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    expect(
      out,
      'vitest could not discover the seed test. This is the exact live failure: the ' +
        'repro-gate runs this discovery, gets "No test files found", BLOCKS the story, ' +
        'and the phase restarts — for a one-word code change.',
    ).not.toMatch(/No test files found/i);
  });

  it('and the seed test PASSES on the baseline — the gate starts from a green repo', () => {
    const clone = buildSeed();
    const r = spawnSync(
      'npx', ['vitest', 'run', 'src/hello.test.ts', '--reporter', 'basic'],
      { cwd: clone, encoding: 'utf8', timeout: 180000, env: { ...process.env, CI: '1' } },
    );
    expect(r.status, `baseline seed test did not pass:\n${r.stdout}${r.stderr}`).toBe(0);
  });

  it('the seed test genuinely asserts the OLD value, so the story has something to change', () => {
    const clone = buildSeed();
    expect(readFileSync(join(clone, 'src/hello.test.ts'), 'utf8')).toContain('hello world');
    expect(readFileSync(join(clone, 'src/hello.ts'), 'utf8')).toContain('hello world');
  });

  it('the seed is a real git repo on a real baseline branch', () => {
    const clone = buildSeed();
    const branch = spawnSync('git', ['-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8' }).stdout.trim();
    expect(branch).toBe('main');
    const dirty = spawnSync('git', ['-C', clone, 'status', '--porcelain'],
      { encoding: 'utf8' }).stdout.trim();
    expect(dirty, 'the seed starts dirty, so teardown/baseline logic sees noise').toBe('');
  });

  it('node_modules is available to the seed, or nothing can run in it', () => {
    const clone = buildSeed();
    expect(existsSync(join(clone, 'node_modules'))).toBe(true);
  });
});

/**
 * THE CLASS, NOT THE INSTANCE. Moving the workspace out of this repo fixes the one place
 * it broke. Owning the vitest config fixes it ANYWHERE — including a parent directory
 * nobody anticipated. This plants a deliberately hostile config above the seed, with the
 * exact include pattern that caused the live failure, and asserts discovery still works.
 */
describe('a hostile parent vitest config cannot capture the seed', () => {
  it('discovery survives a parent config whose include matches nothing here', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock1-hostile-'));
    dirs.push(dir);
    // The precise pattern from epam-cli's own vitest.config.ts that broke the live run.
    writeFileSync(
      join(dir, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config';\n" +
        "export default defineConfig({ test: { include: ['test/**/*.test.ts', 'greet.test.ts'] } });\n",
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hostile-parent', private: true }));

    const target = join(dir, 'nested', 'ws');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const seeded = spawnSync('bash', [RUNNER, '--seed', target], {
      encoding: 'utf8', timeout: 120000, cwd: REPO_ROOT,
    });
    expect(seeded.status, `--seed failed: ${seeded.stdout}${seeded.stderr}`).toBe(0);

    const clone = join(target, 'codelines', 'mock-hello-world');
    const r = spawnSync('npx', ['vitest', 'run', 'src/hello.test.ts', '--reporter', 'basic'], {
      cwd: clone, encoding: 'utf8', timeout: 180000, env: { ...process.env, CI: '1' },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    expect(
      out,
      'a parent vitest config captured the seed and its include matched nothing — the ' +
        'seed must own its config so location can never cause this again',
    ).not.toMatch(/No test files found/i);
    expect(r.status, `seed test failed under a hostile parent config:\n${out}`).toBe(0);
  });
});

describe('--seed is inert', () => {
  it('starts no pipeline and no Jira stub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock1-inert-'));
    dirs.push(dir);
    const r = spawnSync('bash', [RUNNER, '--seed', join(dir, 'ws')], {
      encoding: 'utf8', timeout: 120000, cwd: REPO_ROOT,
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(0);
    expect(out, '--seed launched the pipeline').not.toMatch(/tier3-mock|Specification pass|mock Jira/i);
    expect(out).toMatch(/no pipeline started/i);
  });

  it('--seed without a directory is an error', () => {
    const r = run(['--seed']);
    expect(r.status).toBe(2);
  });
});

describe('operator paths behave without starting a pipeline', () => {
  it('--list exits 0', () => {
    const r = run(['--list']);
    expect(r.status).toBe(0);
  });

  it('an unknown --resume id refuses and exits non-zero', () => {
    const r = run(['--resume', '19990101T000000Z']);
    expect(r.status, 'a bad run number was accepted').not.toBe(0);
    expect(r.out).toMatch(/cannot resume|no workspace|no checkpoint/i);
  });

  it('--resume without an id is an error, not a silent fresh run', () => {
    const r = run(['--resume']);
    expect(r.status, 'a missing run number started a brand new run instead of failing').not.toBe(0);
  });

  it('an unknown option is rejected', () => {
    const r = run(['--nonsense']);
    expect(r.status).toBe(2);
  });

  it('prints the RUN NUMBER before doing any work — the operator needs a handle', () => {
    // The banner must precede the pipeline launch in the source, not follow it.
    const banner = src.indexOf('RUN NUMBER');
    const launch = src.indexOf('tier3-mock-run.sh');
    expect(banner, 'no RUN NUMBER banner').toBeGreaterThan(-1);
    expect(
      banner < launch,
      'the run number is printed after the pipeline starts, so a run that dies early has no handle',
    ).toBe(true);
  });
});

describe('a resume is distinguishable from a fresh start', () => {
  it('a fresh start refuses to reuse an existing workspace', () => {
    expect(src, 'a re-run with the same id would silently reuse a dirty workspace')
      .toMatch(/workspace already exists/i);
  });

  it('a resume sets EPAM_RESUME_RUN and clears the pause flag', () => {
    expect(src).toMatch(/export EPAM_RESUME_RUN/);
    expect(src, 'resuming while still asking to pause would stop again immediately')
      .toMatch(/unset EPAM_PAUSE_BEFORE_WRITER/);
  });

  it('a fresh start sets the pause flag', () => {
    expect(src).toMatch(/export EPAM_PAUSE_BEFORE_WRITER=1/);
  });
});
