/**
 * REPLAY CAN ACTUALLY BE TURNED ON.
 *
 * Operator, 2026-09-05: "replay needs to be on". Two things stood in the way, and both are the
 * same shape — the installer asking the wrong question and answering confidently.
 *
 * 1. THE DOCUMENTED FLAG DOES NOT EXIST. orchestrations/config/env-vars.json describes both
 *    Langfuse keys as belonging to "replay (--replay on / EPAM_REPLAY=on)". install.sh parses
 *    --dest, --ref, --repo, --stack, --no-docker, --docker, --check, --uninstall and --help, and
 *    nothing else: `--replay on` exits 1 with "unknown option '--replay'". The documentation
 *    describes an interface the script never had.
 *
 * 2. THE KEY CHECK READS THE WRONG ENVIRONMENT. The Replay step tests ${LANGFUSE_SECRET_KEY:-}
 *    from the INSTALLER's own shell. The install's .env is loaded ~180 lines earlier, but inside a
 *    command substitution — `_missing_creds="$( set -a; . "$ROOT/.env"; ... )"` — so it dies with
 *    that subshell and never reaches this check. An operator whose .env is correctly filled in
 *    (pipeline-tests-26 has both keys) is told:
 *
 *        replay: on but missing: LANGFUSE_SECRET_KEY LANGFUSE_PUBLIC_KEY
 *
 *    and the install FAILS. The credential step three sections earlier reads the same file
 *    correctly and reports "required credentials are filled in" — so the installer contradicts
 *    itself about one file in one run.
 *
 * WHY THE FAILURE MUST SURVIVE. Recording without keys is silent: LangfuseTracer gates on both,
 * the containers come up, and nothing is captured. A run not recorded can never be replayed, and
 * that loss is one-way. So the fix must make a GENUINELY configured install pass without making an
 * unconfigured one pass — which is why both ends are asserted here.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.join(__dirname, '../../../');
const INSTALLER = path.join(REPO, 'orchestrations-installer/install.sh');

/** A tree install.sh will run against, shaped like the real one. */
function fixture(envBody: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(dir, 'orchestrations-installer/install.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/install.sh'), 0o755);
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib/container-runtime.sh'),
    path.join(dir, 'orchestrations-installer/lib/container-runtime.sh'));
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'EPAM_PROVIDER_SET=claude\n');
  fs.writeFileSync(path.join(dir, '.env'), envBody);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function install(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'),
    '--no-docker', ...args], {
    cwd: dir, encoding: 'utf8', timeout: 180_000,
    // A CLEAN environment. Inheriting the developer's own LANGFUSE_* would make the whole point
    // of this file — that the keys are read from .env — impossible to observe.
    env: {
      PATH: process.env.PATH || '', HOME: process.env.HOME || '',
      LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '', ...env,
    },
  });
  return { rc: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const FILLED = 'LANGFUSE_SECRET_KEY=sk-lf-real\nLANGFUSE_PUBLIC_KEY=pk-lf-real\n';
const EMPTY = 'LANGFUSE_SECRET_KEY=\nLANGFUSE_PUBLIC_KEY=\n';

describe('--replay, the flag the configuration already documents', () => {
  it('env-vars.json really does document it — otherwise this file is arguing with nothing', () => {
    const raw = fs.readFileSync(path.join(REPO, 'orchestrations/config/env-vars.json'), 'utf8');
    expect(raw, 'the documented interface moved; update this test rather than the installer')
      .toMatch(/--replay on/);
  });

  it('--replay on is accepted', () => {
    const f = fixture(FILLED);
    try {
      const r = install(f.dir, ['--replay', 'on']);
      expect(r.out, [
        'install.sh rejected a flag its own configuration documents. An operator following',
        'env-vars.json gets "unknown option \'--replay\'" and exit 1.',
      ].join('\n')).not.toMatch(/unknown option/);
    } finally { f.cleanup(); }
  });

  it('--replay on turns replay on, and says so', () => {
    const f = fixture(FILLED);
    try {
      const r = install(f.dir, ['--replay', 'on']);
      expect(r.out).toMatch(/replay: on/);
      const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'install-manifest.json'), 'utf8'));
      expect(manifest.replay, 'the manifest still records off, so --check would report off')
        .toBe('on');
    } finally { f.cleanup(); }
  });

  it('--replay off is accepted and stays off', () => {
    const f = fixture(FILLED);
    try {
      const r = install(f.dir, ['--replay', 'off']);
      expect(r.out).toMatch(/replay: off/);
    } finally { f.cleanup(); }
  });

  it('a bogus --replay value is refused AT THE ARGUMENT, before any install work', () => {
    /**
     * Silently defaulting to off would produce an install recording nothing while the operator
     * believes it records — a one-way loss.
     *
     * Asserting only a non-zero exit proved nothing: a downstream `case` on REPLAY_MODE already
     * fails the run, so mutation showed this test staying green with the argument check deleted.
     * The behaviour actually added is rejecting it AS AN ARGUMENT — so the operator is told
     * immediately, instead of after a full install that was always going to fail.
     */
    const f = fixture(FILLED);
    try {
      const r = install(f.dir, ['--replay', 'maybe']);
      expect(r.rc, 'a bogus replay mode was accepted').not.toBe(0);
      expect(r.out, 'the bad value was not named, so the operator cannot see what to fix')
        .toMatch(/--replay.*maybe|maybe.*--replay|'maybe'/);
      expect(r.out, [
        'the installer ran its steps before rejecting the flag — the argument was validated only',
        'at the end, so an operator waits through a whole install to be told the value was never',
        'valid.',
      ].join('\n')).not.toMatch(/Prerequisites|Credentials/);
    } finally { f.cleanup(); }
  });

  it('the env var still works — the flag is an addition, not a replacement', () => {
    const f = fixture(FILLED);
    try {
      expect(install(f.dir, [], { EPAM_REPLAY: 'on' }).out).toMatch(/replay: on/);
    } finally { f.cleanup(); }
  });
});

describe('the keys are read from the install\'s own .env', () => {
  it('END ONE — replay: on PASSES when .env holds both keys', () => {
    const f = fixture(FILLED);
    try {
      const r = install(f.dir, ['--replay', 'on']);
      expect(r.out, [
        'the installer reported the Langfuse keys missing while they were filled in .env — it',
        'reads its own shell, and .env is loaded inside a command substitution that dies before',
        'this check runs. The credentials step three sections earlier reads the same file and',
        'reports it filled, so the installer contradicts itself in one run.',
      ].join('\n')).not.toMatch(/replay: on but missing/);
      expect(r.out).toMatch(/recording is active|keys present/i);
    } finally { f.cleanup(); }
  });

  it('END TWO — replay: on still FAILS when the keys are genuinely empty', () => {
    // The dangerous half. Recording without keys is silent, and a run not recorded can never be
    // replayed. Reading .env must not become a way to pass with nothing configured.
    const f = fixture(EMPTY);
    try {
      const r = install(f.dir, ['--replay', 'on']);
      expect(r.rc, 'an install with replay on and no keys succeeded — it would record nothing')
        .not.toBe(0);
      expect(r.out).toMatch(/LANGFUSE_SECRET_KEY|LANGFUSE_PUBLIC_KEY/);
    } finally { f.cleanup(); }
  });

  it('one key alone is not enough — the tracer gates on both', () => {
    const f = fixture('LANGFUSE_SECRET_KEY=sk-lf-real\nLANGFUSE_PUBLIC_KEY=\n');
    try {
      expect(install(f.dir, ['--replay', 'on']).rc,
        'a half-configured install passed; LangfuseTracer needs both keys and would record nothing')
        .not.toBe(0);
    } finally { f.cleanup(); }
  });

  it('an exported key still counts when .env lacks it', () => {
    // Backward compatible: operators who export the keys in their shell must not start failing.
    const f = fixture('LANGFUSE_SECRET_KEY=\nLANGFUSE_PUBLIC_KEY=\n');
    try {
      const r = install(f.dir, ['--replay', 'on'],
        { LANGFUSE_SECRET_KEY: 'sk-env', LANGFUSE_PUBLIC_KEY: 'pk-env' });
      expect(r.out, 'keys exported in the environment stopped being honoured')
        .not.toMatch(/replay: on but missing/);
    } finally { f.cleanup(); }
  });

  it('replay: off never demands keys at all', () => {
    const f = fixture(EMPTY);
    try {
      const r = install(f.dir, ['--replay', 'off']);
      expect(r.out).not.toMatch(/replay: on but missing/);
    } finally { f.cleanup(); }
  });
});
