/**
 * THE MANIFEST IS REVIEWED BEFORE ANYTHING TOUCHES A CLIENT REPOSITORY.
 *
 * lib/manifest_schema.py describes itself as a reviewer that "checks the manifest against the REAL
 * codeline, not against itself". It was inert twice over: the schema was stale (fixed in fd9afedd),
 * and — still — NOTHING IN THE PIPELINE CALLS IT. Only tests do. A reviewer nobody invokes is the
 * same defect as lib/plan-fidelity-gate.sh, which was built, tested and called by nothing.
 *
 * WHY IT MATTERS HERE AND NOT SOMEWHERE ELSE. The earliest consumer of dependency-check.json is
 * brownfield-preflight-reset.sh, which the launcher runs BEFORE the orchestration starts. It reads
 * localDependencyOverrides[].localSourcePath, npm-installs from it, and runs `git reset --hard`
 * plus `clean -fd` on a CLIENT repository. The localSourcePath check that keeps an override out of
 * the wrong codeline tree is exactly the check that never ran.
 *
 * SO THE GATE FAILS THE LAUNCH. Operator, 2026-09-06: "fail the launch". A warning here would be
 * read after the reset had already happened.
 *
 * THE GATE MUST NOT BLOCK A RUN THAT WOULD HAVE WORKED. metrolinx's real manifest validates
 * against both of its real codelines when JIRA_CODELINE_ROOT is set, which is how the launcher
 * runs it — verified before this gate was written, because a gate that fails a good manifest is
 * worse than no gate.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const GATE = join(SCRIPTS, 'lib/manifest-preflight.sh');
const REAL_MANIFEST = join(SCRIPTS, '../projects/metrolinx/dependency-check.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A codeline that looks like one: a git repo with a manifest the ecosystem registry recognises. */
function codeline(name = 'next.gotransit.com') {
  const root = mkdtempSync(join(tmpdir(), 'mfgate-'));
  dirs.push(root);
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name, dependencies: { '@metrolinx/cx-shared': '1.0.0' },
  }));
  writeFileSync(join(repo, 'src', 'a.ts'), "import x from '@metrolinx/cx-shared';\n");
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  return { root, repo, name };
}

function runGate(manifest: unknown, cl: { root: string; repo: string }, opts: {
  python?: string | null; manifestPath?: string; codelineRoot?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mfgate-run-'));
  dirs.push(dir);
  let mf = opts.manifestPath;
  if (mf === undefined) {
    mf = join(dir, 'dependency-check.json');
    writeFileSync(mf, typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  }
  const script = join(dir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'error() { printf "ERR %s\\n" "$*"; }',
    'info()  { printf "%s\\n" "$*"; }',
    'warning() { printf "WARN %s\\n" "$*"; }',
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
    ...(opts.python !== undefined
      ? [`MANIFEST_PYTHON=${JSON.stringify(opts.python === null ? '/nonexistent/python' : opts.python)}`]
      : []),
    `. ${JSON.stringify(GATE)}`,
    `manifest_preflight_gate ${JSON.stringify(mf)} ${JSON.stringify(cl.repo)}`,
    'echo "GATE_RC=$?"',
  ].join('\n'));
  let out = '';
  try {
    out = execFileSync('bash', [script], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env,
             JIRA_CODELINE_ROOT: opts.codelineRoot !== undefined ? opts.codelineRoot : cl.root },
    });
  } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  const m = out.match(/GATE_RC=(\d+)/);
  return { out, rc: m ? Number(m[1]) : -1 };
}

/**
 * THE REAL MANIFEST, RETARGETED — never a hand-written one.
 *
 * A hand-built fixture omits required fields (manifestKeys, scanFileExtensions, installCommand)
 * and every test then fails on a schema error rather than on the thing it claims to measure. It
 * also drifts: the shipped manifest gains a field and the fixture never does, so the suite stops
 * describing what the pipeline actually validates. Each test starts from what metrolinx really
 * declares and changes exactly one thing.
 */
function VALID(name: string): any {
  const m = JSON.parse(readFileSync(REAL_MANIFEST, 'utf8'));
  for (const o of (m.localDependencyOverrides || [])) o.codeline = name;
  return m;
}

describe('the manifest gate', () => {
  it('GUARD: the REAL metrolinx manifest PASSES against a real codeline', () => {
    // The gate must not block the configuration that ran green on 2026-09-05. If this ever fails,
    // the gate is refusing a launch that would have worked, which is worse than not gating.
    const cl = codeline();
    mkdirSync(join(cl.root, 'cx-shared'), { recursive: true });
    const r = runGate(null, cl, { manifestPath: REAL_MANIFEST });
    expect(r.rc, `the real manifest was refused:\n${r.out}`).toBe(0);
  });

  it('a localSourcePath that does not exist FAILS the launch', () => {
    /**
     * THE CONTRACT, READ FROM THE CHECK ITSELF rather than assumed. manifest_schema.py permits an
     * absolute path deliberately — "a project may legitimately point outside the root, and this
     * field already ships absolute values". What it refuses is a path that is not THERE, because
     * brownfield-preflight-reset.sh would npm-install from it against a client repository.
     */
    const cl = codeline();
    const m: any = VALID(cl.name);
    m.localDependencyOverrides[0].localSourcePath = '/nonexistent/cx-shared';
    const r = runGate(m, cl);
    expect(r.rc, `an override pointing at a path that does not exist was allowed:\n${r.out}`)
      .not.toBe(0);
  });

  it('a RELATIVE localSourcePath with no declared codeline root FAILS the launch', () => {
    /**
     * The defect this check was written for: a relative path resolved against the CWD passed on
     * one machine and pointed at the real client working copies on another — "real path, wrong
     * tree", silently, against a standing rule that the test project never addresses them.
     */
    const cl = codeline();
    mkdirSync(join(cl.root, 'cx-shared'), { recursive: true });
    const m: any = VALID(cl.name);
    m.localDependencyOverrides[0].localSourcePath = 'cx-shared';
    const r = runGate(m, cl, { codelineRoot: '' });
    expect(r.rc, 'a relative override was resolved without a declared root').not.toBe(0);
    expect(r.out).toMatch(/JIRA_CODELINE_ROOT|relative/i);
  });

  it('an unknown field FAILS — a mistyped setting must not vanish', () => {
    const cl = codeline();
    const m: any = VALID(cl.name);
    m.vendorDirz = ['node_modules'];
    const r = runGate(m, cl);
    expect(r.rc, 'a typo was accepted, so the setting it was meant to be silently did nothing')
      .not.toBe(0);
  });

  it('an importPattern that does not compile FAILS', () => {
    const cl = codeline();
    const m: any = VALID(cl.name);
    m.importPattern = '([unclosed';
    const r = runGate(m, cl);
    expect(r.rc).not.toBe(0);
  });

  it('autoInstall: "false" FAILS — a truthy string on the install switch', () => {
    // Plain bool coerces, so the STRING 'false' reads as enabled on the setting that decides
    // whether the pipeline installs packages onto a client codeline.
    const cl = codeline();
    const m: any = VALID(cl.name);
    m.autoInstall = 'false';
    const r = runGate(m, cl);
    expect(r.rc).not.toBe(0);
  });

  it('documentation keys are documentation — _what and $why PASS', () => {
    const cl = codeline();
    mkdirSync(join(cl.root, 'cx-shared'), { recursive: true });
    const m: any = VALID(cl.name);
    m._what = 'what this manifest is for';
    m.$why = 'why it is shaped this way';
    const r = runGate(m, cl);
    expect(r.rc, `documentation keys were rejected as configuration:\n${r.out}`).toBe(0);
  });

  it('A GATE THAT CANNOT RUN FAILS THE LAUNCH — it never passes by default', () => {
    // The failure mode this repo has shipped before: a gate whose verdict nobody reads, and a
    // gate that silently stands down. An unavailable interpreter is not evidence of a good
    // manifest.
    const cl = codeline();
    mkdirSync(join(cl.root, 'cx-shared'), { recursive: true });
    const r = runGate(VALID(cl.name), cl, { python: null });
    expect(r.rc, 'the gate stood down when python was unavailable and let the launch proceed')
      .not.toBe(0);
    expect(r.out).toMatch(/manifest/i);
  });

  it('NO MANIFEST is not a failure — a project need not declare one', () => {
    const cl = codeline();
    const r = runGate(null, cl, { manifestPath: join(cl.root, 'absent.json') });
    expect(r.rc, 'a project with no dependency manifest was refused a launch').toBe(0);
  });

  it('SAYS WHAT IS WRONG — a refusal with no issue is unactionable', () => {
    const cl = codeline();
    const m: any = VALID(cl.name);
    m.localDependencyOverrides[0].localSourcePath = '/nonexistent/cx-shared';
    const r = runGate(m, cl);
    expect(r.out).toMatch(/localSourcePath|override/i);
  });
});

describe('the gate runs BEFORE any client repository is touched', () => {
  /**
   * Placement is the whole point. brownfield-preflight-reset.sh npm-installs from the manifest and
   * then runs `git reset --hard` plus `clean -fd` on a client repo, so a verdict that arrives
   * afterwards has prevented nothing. The launcher region is lifted and driven with a recording
   * stub in place of the reset, and the assertion is an INVOCATION COUNT — the operator's sentence
   * ("fail the launch") turned into "brownfield-preflight-reset.sh runs 0 times".
   */
  const LAUNCHER = join(SCRIPTS, 'tier3-metrolinx-run.sh');

  function runRegion(manifest: any, cl: { root: string; repo: string }) {
    const dir = mkdtempSync(join(tmpdir(), 'mfwire-'));
    dirs.push(dir);
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'dependency-check.json'), JSON.stringify(manifest, null, 2));
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ project: { outputDirs: [{ path: cl.repo }] } }));

    // A stub SCRIPT_DIR whose brownfield-preflight-reset.sh only records that it was called.
    const stubs = join(dir, 'scripts');
    mkdirSync(join(stubs, 'lib'), { recursive: true });
    const calls = join(dir, 'reset-calls.txt');
    writeFileSync(join(stubs, 'brownfield-preflight-reset.sh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
    chmodSync(join(stubs, 'brownfield-preflight-reset.sh'), 0o755);
    for (const f of ['manifest-preflight.sh', 'manifest_schema.py']) {
      writeFileSync(join(stubs, 'lib', f), readFileSync(join(SCRIPTS, 'lib', f), 'utf8'));
    }
    // The gate resolves the reviewer through SCRIPT_DIR, and python through the real venv.
    const src = readFileSync(LAUNCHER, 'utf8');
    const start = src.indexOf('_scoped=0');
    const resetAt = src.indexOf('bash "$SCRIPT_DIR/brownfield-preflight-reset.sh"');
    const end = src.indexOf('\ndone\n', resetAt) + 6;
    expect(start, 'the launcher region was not found').toBeGreaterThan(0);
    // A slice that stopped before the reset loop would make the "0 resets" assertion vacuous.
    expect(resetAt, 'the reset call was not found — the region would prove nothing')
      .toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain('brownfield-preflight-reset.sh');

    const script = join(dir, 'drive.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash', 'set -uo pipefail',
      'error() { printf "ERR %s\\n" "$*"; }',
      'info()  { printf "%s\\n" "$*"; }',
      'warning() { printf "WARN %s\\n" "$*"; }',
      'require_codeline_root() { return 0; }',
      // The real scope resolver, so what counts as "in scope" is not re-implemented here.
      `. ${JSON.stringify(join(SCRIPTS, 'lib/codeline-scope.sh'))}`,
      `SCRIPT_DIR=${JSON.stringify(stubs)}`,
      `MANIFEST_PYTHON=${JSON.stringify(join(SCRIPTS, '.venv/bin/python'))}`,
      `PRD_FILE=${JSON.stringify(prd)}`,
      `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}`,
      src.slice(start, end),
      'echo "REGION_RC=$?"',
    ].join('\n'));

    let out = '';
    try {
      out = execFileSync('bash', [script], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, JIRA_CODELINE_ROOT: cl.root },
      });
    } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
    const resets = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    return { out, resets };
  }

  it('a BAD manifest stops the launch with the client repo untouched', () => {
    const cl = codeline();
    const m: any = VALID(cl.name);
    m.localDependencyOverrides[0].localSourcePath = '/nonexistent/cx-shared';
    const r = runRegion(m, cl);
    expect(r.resets,
      'brownfield-preflight-reset.sh ran on an unreviewed manifest — it npm-installs and then '
      + 'git-reset --hard a CLIENT repository').toBe(0);
    expect(r.out).toMatch(/refusing to launch/i);
  });

  it('GUARD: a GOOD manifest still lets the reset run — the gate is not blocking everything', () => {
    // Without this the test above passes on a region that never reaches the reset at all.
    const cl = codeline();
    mkdirSync(join(cl.root, 'cx-shared'), { recursive: true });
    const r = runRegion(VALID(cl.name), cl);
    expect(r.resets, `the gate refused a valid manifest:\n${r.out}`).toBe(1);
  });
});
