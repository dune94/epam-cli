/**
 * A NEW GREENFIELD PROJECT IS DATA, AND THE GENERIC LAUNCHER RUNS IT.
 *
 * tier3-run.sh — "launch ANY project's multi-codeline run. The project is an argument." — was built
 * for the brownfield shape and reads none of the greenfield declarations. The greenfield lifecycle
 * lived only in tier3-skyscanner-app-run.sh: tear down and recreate OUTPUT_DIR, seed .epam/ with
 * the project's manifests, restore the PRD from PRD_CANONICAL, run EPAM_PHASES in order with
 * pre-phase remediation and the exit-2 self-heal retry. That launcher names its project by hand
 * (project_config_dir skyscanner; the travel-app canonical path), so a second greenfield project
 * could not be launched without engine code — the exact thing "a new project is data" forbids.
 * Found 2026-09-11 when regintel was created as data and had nothing to launch it.
 *
 * lib/greenfield-lifecycle.sh carries that lifecycle, driven by the project's own config.env, and
 * tier3-run.sh calls it when the project declares EPAM_BROWNFIELD=0. Brownfield is untouched.
 * Every case here EXECUTES the library against fixtures and asserts what is on disk or what a
 * stub orchestrator was invoked with — never what the script's text says.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/greenfield-lifecycle.sh');
const LAUNCHER = join(SCRIPTS, 'tier3-run.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

function sh(script: string, env: Record<string, string> = {}) {
  const d = tmp('gf-');
  const f = join(d, 's.sh');
  writeFileSync(f, `#!/bin/bash\nset -uo pipefail\ninfo(){ echo "[t] $*"; }; success(){ echo "[t] ok $*"; }; fail(){ echo "[t] FAIL $*" >&2; exit 1; }\nsource ${JSON.stringify(LIB)}\n${script}\n`);
  const r = spawnSync('bash', [f], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** A project directory declaring the greenfield shape, plus the manifests a run seeds into .epam/. */
function fixtureProject(outputDir: string, canonical: string) {
  const proj = tmp('gf-proj-');
  writeFileSync(join(proj, 'config.env'), [
    'EPAM_BROWNFIELD=0', 'EPAM_PHASES="scaffold core"', `OUTPUT_DIR=${outputDir}`,
    `PRD_CANONICAL=${canonical}`, `PRD_FILE=${join(proj, 'prd.json')}`,
  ].join('\n') + '\n');
  for (const m of ['dependency-check.json', 'contract-generation.json', 'known-fixes.json']) {
    writeFileSync(join(proj, m), JSON.stringify({ manifest: m }));
  }
  return proj;
}

describe('the generic launcher runs a greenfield project', () => {
  it('the library exists — otherwise nothing below is tested', () => {
    expect(existsSync(LIB), 'orchestrations/scripts/lib/greenfield-lifecycle.sh is missing').toBe(true);
  });

  it('prepares the output directory: previous contents gone, sibling worktrees gone, a fresh repo with one empty commit, .epam/ seeded from the project', () => {
    const out = join(tmp('gf-out-'), 'app');
    mkdirSync(join(out, 'node_modules/locked'), { recursive: true });
    writeFileSync(join(out, 'node_modules/locked/f'), 'x'); chmodSync(join(out, 'node_modules/locked'), 0o555);
    writeFileSync(join(out, 'leftover.txt'), 'old');
    mkdirSync(`${out}-wt-abc`); writeFileSync(join(`${out}-wt-abc`, 'x'), 'x');
    const proj = fixtureProject(out, '/nonexistent');
    const r = sh(`greenfield_prepare_output_dir ${JSON.stringify(out)} ${JSON.stringify(proj)} fixture-app`);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(out, 'leftover.txt')), 'previous contents survived the teardown').toBe(false);
    expect(existsSync(`${out}-wt-abc`), 'a sibling worktree survived').toBe(false);
    const log = execFileSync('git', ['-C', out, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n');
    expect(log, 'expected exactly one empty init commit').toHaveLength(1);
    expect(log[0]).toMatch(/init: fixture-app/);
    for (const m of ['dependency-check.json', 'contract-generation.json', 'known-fixes.json']) {
      expect(JSON.parse(readFileSync(join(out, '.epam', m), 'utf8')).manifest, `.epam/${m} not seeded`).toBe(m);
    }
  });

  it('restores the PRD from PRD_CANONICAL, resolving a repo-relative path against the repo root', () => {
    const repo = tmp('gf-repo-'); mkdirSync(join(repo, 'orchestrations'));
    writeFileSync(join(repo, 'orchestrations/x.canonical.json'), JSON.stringify({ stories: [{ id: 'A' }, { id: 'B' }] }));
    const prd = join(repo, 'orchestrations/x.json'); writeFileSync(prd, JSON.stringify({ stories: [{ id: 'STALE', status: 'done' }] }));
    const r = sh(`greenfield_restore_prd "orchestrations/x.canonical.json" ${JSON.stringify(prd)} ${JSON.stringify(repo)}`);
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(readFileSync(prd, 'utf8')).stories.map((s: any) => s.id)).toEqual(['A', 'B']);
  });

  it('refuses when PRD_CANONICAL is declared but missing — never launches on a stale PRD', () => {
    const repo = tmp('gf-repo-'); const prd = join(repo, 'p.json'); writeFileSync(prd, '{}');
    const r = sh(`greenfield_restore_prd "nope.json" ${JSON.stringify(prd)} ${JSON.stringify(repo)}`);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/PRD_CANONICAL|canonical/);
  });

  it('runs the declared phases in order, each with pre-phase remediation, through the orchestrator', () => {
    const d = tmp('gf-phases-');
    const calls = join(d, 'calls.txt');
    const orch = join(d, 'orch.sh'); writeFileSync(orch, `#!/bin/bash\necho "orch $*" >> ${JSON.stringify(calls)}\nexit 0\n`); chmodSync(orch, 0o755);
    const rem = join(d, 'rem.sh'); writeFileSync(rem, `#!/bin/bash\necho "remediate $*" >> ${JSON.stringify(calls)}\nexit 0\n`); chmodSync(rem, 0o755);
    const r = sh(`greenfield_run_phases "scaffold core" ${JSON.stringify(join(d, 'prd.json'))} ${JSON.stringify(join(d, 'run.log'))}`,
      { EPAM_ORCHESTRATOR_BIN: orch, EPAM_PRD_REMEDIATE_BIN: rem });
    expect(r.status, r.out).toBe(0);
    const seq = readFileSync(calls, 'utf8').trim().split('\n');
    expect(seq).toEqual([
      expect.stringMatching(/^remediate .*--phase scaffold/), expect.stringMatching(/^orch --phase scaffold --reset/),
      expect.stringMatching(/^remediate .*--phase core/), expect.stringMatching(/^orch --phase core --reset/),
    ]);
  });

  it('on exit 2 (gate remediation applied) it remediates mid-phase and retries that phase once, with SKIP_GATE_REMEDIATION=1', () => {
    const d = tmp('gf-retry-');
    const calls = join(d, 'calls.txt'); const n = join(d, 'n');
    const orch = join(d, 'orch.sh');
    writeFileSync(orch, `#!/bin/bash\nc=$(cat ${JSON.stringify(n)} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${JSON.stringify(n)}\necho "orch $* skip=\${SKIP_GATE_REMEDIATION:-}" >> ${JSON.stringify(calls)}\n[ "$c" = 1 ] && exit 2\nexit 0\n`); chmodSync(orch, 0o755);
    const rem = join(d, 'rem.sh'); writeFileSync(rem, `#!/bin/bash\necho "remediate $*" >> ${JSON.stringify(calls)}\nexit 0\n`); chmodSync(rem, 0o755);
    const r = sh(`greenfield_run_phases "core" ${JSON.stringify(join(d, 'prd.json'))} ${JSON.stringify(join(d, 'run.log'))}`,
      { EPAM_ORCHESTRATOR_BIN: orch, EPAM_PRD_REMEDIATE_BIN: rem });
    expect(r.status, r.out).toBe(0);
    const seq = readFileSync(calls, 'utf8').trim().split('\n');
    expect(seq).toEqual([
      expect.stringMatching(/^remediate .*--phase core$/),
      expect.stringMatching(/^orch --phase core --reset skip=$/),
      expect.stringMatching(/^remediate .*--phase core --mid-phase-retry/),
      expect.stringMatching(/^orch --phase core --reset skip=1$/),
    ]);
  });

  it('a phase that fails for real aborts the run — no silent continuation to the next phase', () => {
    const d = tmp('gf-fail-');
    const calls = join(d, 'calls.txt');
    const orch = join(d, 'orch.sh'); writeFileSync(orch, `#!/bin/bash\necho "orch $*" >> ${JSON.stringify(calls)}\nexit 1\n`); chmodSync(orch, 0o755);
    const rem = join(d, 'rem.sh'); writeFileSync(rem, '#!/bin/bash\nexit 0\n'); chmodSync(rem, 0o755);
    const r = sh(`greenfield_run_phases "scaffold core" ${JSON.stringify(join(d, 'prd.json'))} ${JSON.stringify(join(d, 'run.log'))}`,
      { EPAM_ORCHESTRATOR_BIN: orch, EPAM_PRD_REMEDIATE_BIN: rem });
    expect(r.status).not.toBe(0);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('tier3-run.sh --describe shows the greenfield plan for the skyscanner project, from its own declarations', () => {
    const r = spawnSync('bash', [LAUNCHER, '--project', 'skyscanner', '--describe'], { encoding: 'utf8', timeout: 60_000, cwd: ROOT, env: { ...process.env } });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/brownfield:\s+0/);
    expect(out, 'the generic launcher does not show the declared phases').toMatch(/phases:\s+scaffold core/);
    expect(out, 'the generic launcher does not show the output dir').toMatch(/output dir:\s+\/home\/bradleyjerome\/projects\/skyscanner-app/);
    expect(out, 'the generic launcher does not show the PRD source').toMatch(/prd source:\s+.*travel-app-prd\.canonical\.json/);
  });

  it('the authored PRD is restored BEFORE pre-flight judges anything: a declared-but-missing canonical is refused before pre-flight, the coverage gate or any teardown runs', () => {
    // Live 2026-09-11: the restore ran after the operator confirmed, so pre-flight judged the runtime
    // PRD — the previous run's model assignments — and refused a fresh launch over a rung the current
    // set does not declare. The canonical is the base state; it is in place before anything reads
    // the file. Nothing here reaches pre-flight, so nothing here is heavy.
    const out = join(tmp('gf-out-'), 'app');
    const proj = fixtureProject(out, 'orchestrations/does-not-exist.canonical.json');
    writeFileSync(join(proj, 'prd.json'), JSON.stringify({ stories: [{ id: 'STALE', model: 'a-model-of-the-last-run' }] }));
    const r = spawnSync('bash', [LAUNCHER], { encoding: 'utf8', timeout: 60_000, cwd: ROOT, input: '',
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: proj, PROJECT_NAME: 'fixture-app' } });
    const text = (r.stdout || '') + (r.stderr || '');
    expect(r.status, text).not.toBe(0);
    expect(text).toMatch(/PRD_CANONICAL is declared but not found/);
    expect(text, 'pre-flight ran before the PRD was restored').not.toMatch(/Pre-flight for/);
    expect(text, 'the coverage gate ran before the PRD was restored').not.toMatch(/\[coverage-gate\]/);
    expect(text, 'the output directory was touched before the PRD was restored').not.toMatch(/Tearing down/);
    expect(existsSync(join(out, '.git')), 'the output directory was rebuilt before the PRD was restored').toBe(false);
    expect(JSON.parse(readFileSync(join(proj, 'prd.json'), 'utf8')).stories[0].id, 'a refusal must leave the PRD as it found it').toBe('STALE');
  });
});
