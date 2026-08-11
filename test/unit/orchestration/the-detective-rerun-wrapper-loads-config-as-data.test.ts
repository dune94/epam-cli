/**
 * THE WRAPPER'S ONLY JOB IS THE ENVIRONMENT, SO THE ENVIRONMENT IS WHAT IS TESTED.
 *
 * detective-rerun.sh calls one node script. Everything else it does is assembling the same
 * environment the spec pass hands the detective — the project's models, provider routing,
 * secrets and brownfield flag. Two things have gone wrong at exactly this seam before:
 *
 *   1. A config file was EXECUTED rather than read (2026-08-05). A bare `cd` inside one sent
 *      every subsequent relative path to $HOME. Config is DATA.
 *   2. A shared secrets file clobbered a project's own connection settings, because it was
 *      loaded after the project config instead of before.
 *
 * And one thing specific to this step: the detective returns [] immediately unless
 * EPAM_BROWNFIELD=1. An empty answer from a misconfigured environment is indistinguishable
 * from a real "no fix sites here", and the step's whole contract is that empty means keep.
 * So the wrapper must refuse rather than run.
 *
 * The node step is stubbed via NODE_BIN, so these execute the real script without invoking a
 * model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const WRAPPER = join(ROOT, 'orchestrations/scripts/detective-rerun.sh');

// The wrapper resolves the project under the repo, so the fixture lives there and is removed.
const PROJECT = `.test-detrerun-${process.pid}`;
const PROJECT_DIR = join(ROOT, 'orchestrations/projects', PROJECT);
const OUT = join(PROJECT_DIR, 'invoked.txt');
const CANARY = join(PROJECT_DIR, 'canary.txt');

function writeProject(configExtra: string) {
  mkdirSync(PROJECT_DIR, { recursive: true });
  // Cleared per case: a record left by the previous case would let "the step was never
  // invoked" pass or fail for reasons that have nothing to do with the case under test.
  rmSync(OUT, { force: true });
  rmSync(CANARY, { force: true });
  writeFileSync(join(PROJECT_DIR, 'prd.json'), JSON.stringify({ project: { outputDirs: [] }, stories: [] }));
  writeFileSync(join(PROJECT_DIR, 'config.env'), configExtra);
  // A stub interpreter: records the arguments it was handed, and nothing else.
  const stub = join(PROJECT_DIR, 'node-stub.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${OUT}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function run(env: Record<string, string>, args: string[] = []) {
  return spawnSync('bash', [WRAPPER, '--project', PROJECT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: ROOT,
  });
}

beforeAll(() => { if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true, force: true }); });
afterAll(() => { rmSync(PROJECT_DIR, { recursive: true, force: true }); });

describe('the wrapper exists', () => {
  it('is present', () => {
    expect(existsSync(WRAPPER)).toBe(true);
  });
});

describe('CONFIG IS DATA — loading it must not execute it', () => {
  it('a command written into the config file never runs', () => {
    const stub = writeProject(
      'EPAM_BROWNFIELD=1\n'
      // If the loader executes rather than parses, this writes the canary.
      + `touch "${CANARY}"\n`
      + 'SPEC_MODE_PROVIDER=fixture\n',
    );
    const r = run({ NODE_BIN: stub });

    expect(existsSync(CANARY),
      'a command inside config.env executed — the loader is evaluating a data file').toBe(false);
    // And the values around the offending line still loaded.
    expect(r.stderr).toContain('provider=fixture');
  });
});

describe('THE BROWNFIELD GUARD — a misconfigured run must refuse, not answer emptily', () => {
  it('refuses when the brownfield flag is not set, and does not invoke the step', () => {
    const stub = writeProject('SPEC_MODE_PROVIDER=fixture\n');
    const r = run({ NODE_BIN: stub, EPAM_BROWNFIELD: '' });

    expect(r.status, 'a run that cannot investigate must fail, not return no findings').toBe(2);
    expect(existsSync(OUT), 'the node step was invoked despite the guard').toBe(false);
    expect(r.stderr).toMatch(/indistinguishable/i);
  });

  it('proceeds when the project declares brownfield', () => {
    const stub = writeProject('EPAM_BROWNFIELD=1\n');
    const r = run({ NODE_BIN: stub });
    expect(r.status).toBe(0);
    expect(existsSync(OUT), 'the node step was never invoked').toBe(true);
  });
});

describe('the step receives the PRD, the log dir, and whatever the operator passed', () => {
  it('passes --prd and --log-dir, and forwards the operator flags unchanged', () => {
    const stub = writeProject('EPAM_BROWNFIELD=1\n');
    const r = run({ NODE_BIN: stub }, ['--report', '--codelines', 'cl-one,cl-two']);
    expect(r.status).toBe(0);

    const argv = readFileSync(OUT, 'utf8').split('\n').filter(Boolean);
    expect(argv[0], 'the step script itself is the first argument').toMatch(/detective-rerun-step\.js$/);
    expect(argv).toContain('--prd');
    expect(argv[argv.indexOf('--prd') + 1]).toBe(join(PROJECT_DIR, 'prd.json'));
    expect(argv).toContain('--log-dir');
    // Operator flags survive verbatim — a wrapper that drops --report would spend money.
    expect(argv).toContain('--report');
    expect(argv[argv.indexOf('--codelines') + 1]).toBe('cl-one,cl-two');
  });

  it('a missing PRD fails before the step is invoked', () => {
    const stub = writeProject('EPAM_BROWNFIELD=1\n');
    rmSync(join(PROJECT_DIR, 'prd.json'));
    const r = run({ NODE_BIN: stub });
    expect(r.status).toBe(2);
    expect(existsSync(OUT)).toBe(false);
  });
});

describe('an unknown project is refused rather than half-configured', () => {
  it('a project with no config.env exits non-zero', () => {
    const r = spawnSync('bash', [WRAPPER, '--project', 'no-such-project-here'], {
      encoding: 'utf8', cwd: ROOT, env: process.env as Record<string, string>,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/config not found/i);
  });
});
