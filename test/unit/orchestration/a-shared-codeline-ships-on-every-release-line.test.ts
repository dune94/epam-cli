/**
 * A SHARED CODELINE SHIPS ON EVERY RELEASE LINE ITS STORY'S PLAN NAMES — ONE STORY BRANCH PER LINE, N FROM THE PLAN.
 *
 * Operator, 2026-10-06 (AMSD-2974): "Why are there not two branches created on cx-shared? that is the right
 * approach", "Why one? That does not work for brownfield for a shared repo", "You cannot hard code 1:1 just because",
 * "The pipeline never encountered a shared codeline until now". The pipeline gave a codeline one base and one story
 * branch; the library had to ship its fix on 8.x AND as a 7.x back-port from v7.14.0 for two consumers locked to ^7,
 * and the only remedy the agents could name was moving those consumers' ranges.
 *
 * The plan (detective-overall-plan) names each release line, its base and whether the codeline's own base is
 * already on it (onCodelineBase). The lane works the story on its own base as before; then once more per line the
 * plan marks onCodelineBase:false — that line's base, its own story branch, its own logs, its own PRD copy where the
 * story is pending again. The count is the plan's: 0, 1 or N. A line whose onCodelineBase is not stated is not
 * guessed at.
 *
 * EXECUTED: lib/release-lines.sh — _run_release_lines and the per-line passes it wraps, _run_release_lines_each — with the real handlers and a stand-in for the lane's phase run that records each
 * call; ensure_story_branch and codeline_baseline_ref on a real repository with an origin and release tags.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LINES = join(SCRIPTS, 'lib/release-lines.sh');
const GITOPS = join(SCRIPTS, 'lib/git-ops.sh');
const PERIM = join(SCRIPTS, 'lib/codeline-write-perimeter.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { spawnSync('bash', ['-c', `. "${PERIM}"; perimeter_unlock "${d}"`]); rmSync(d, { recursive: true, force: true }); } });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const LOGS = 'warning() { echo "WARN: $*"; }; error() { echo "ERROR: $*"; }; success() { echo "OK: $*"; }; info() { echo "INFO: $*"; }; log() { echo "LOG: $*"; }';

type Line = { line: string; base: string; version: string; onCodelineBase?: boolean; carries?: string };
const plan = (provider: string, lines: Line[]) => ({
  codelines: [{ codeline: provider, part: 'ship the change on every line', order: 1 }, { codeline: 'site', part: 'none', order: 2 }],
  packages: [{ package: '@scope/lib', providedBy: provider, releaseLines: lines, consumers: [] }],
});
const lanePrd = (p: object | null) => ({
  project: { outputDir: '/w/lib', outputDirs: [{ codeline: 'lib', path: '/w/lib' }, { codeline: 'site', path: '/w/site' }] },
  implementationOrder: { core: ['S-1'] },
  stories: [{ id: 'S-1', phase: 'core', codeline: 'lib', codelines: ['lib', 'site'], status: 'completed', completed: true, passes: true, ...(p ? { overallPlan: p } : {}) }],
});

/** Run the lane's release-line passes for codeline `cl`, with a phase runner that records each call. */
function runLines(cl: string, prd: object, runnerExit = 0, opts: { env?: Record<string, string>; seed?: Record<string, object>; wt?: string } = {}) {
  const d = tmp('release-lines-');
  const prdFile = join(d, 'lane-prd.json'); writeFileSync(prdFile, JSON.stringify(prd));
  const calls = join(d, 'calls.jsonl');
  const runner = join(d, 'phase-runner.sh');
  writeFileSync(runner, `#!/bin/bash
BR=$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null); export BR
${JSON.stringify(process.execPath)} -e 'const p=require(process.env.PRD_FILE);process.stdout.write(JSON.stringify({branch:process.env.BR||"",args:process.argv.slice(1),phase:process.env.PHASE,base:process.env.JIRA_BASELINE_BRANCH,suffix:process.env.EPAM_BRANCH_SUFFIX||"",line:process.env.EPAM_RELEASE_LINE||"",spec:process.env.EPAM_SPEC_MODE||"",logDir:process.env.LOG_DIR,codeline:process.env.EPAM_CODELINE,root:process.env.PROJECT_ROOT,stories:p.stories.map(s=>({id:s.id,status:s.status,completed:s.completed})),plan:(p.stories[0]||{}).overallPlan})+"\\n")' -- "$@" >> ${JSON.stringify(calls)}
# A line pass leaves the codeline on the line's story branch, as ensure_story_branch does.
[ -d "$PROJECT_ROOT/.git" ] && git -C "$PROJECT_ROOT" checkout -q -B "AI-S-1$EPAM_BRANCH_SUFFIX"
exit ${runnerExit}
`);
  chmodSync(runner, 0o755);
  const laneLog = join(d, 'lanes', cl); mkdirSync(laneLog, { recursive: true });
  // A line an earlier invocation of this run already worked: its PRD where the line pass left it.
  for (const [slug, linePrd] of Object.entries(opts.seed || {})) { mkdirSync(join(laneLog, 'lines', slug), { recursive: true }); writeFileSync(join(laneLog, 'lines', slug, 'prd.json'), JSON.stringify(linePrd)); }
  const r = spawnSync('bash', ['-c', `${LOGS}\nSCRIPT_DIR=${JSON.stringify(SCRIPTS)}\nNODE_BIN=${JSON.stringify(process.execPath)}\n. ${JSON.stringify(LINES)}\n _run_release_lines ${cl} ${JSON.stringify(prdFile)} ${JSON.stringify(opts.wt || `/w/${cl}`)} ${JSON.stringify(laneLog)} ${JSON.stringify(join(d, 'orch.log'))} "" ${JSON.stringify(runner)}`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: '', LOG_DIR: d, ...(opts.env || {}) } });
  const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, recorded, laneLog };
}

describe('the lane works the story once more per release line the plan names off its own base', () => {
  it('0 lines: the plan names none — nothing more runs', () => {
    const { r, recorded } = runLines('lib', lanePrd(plan('lib', [])));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('no plan at all: nothing more runs', () => {
    const { r, recorded } = runLines('lib', lanePrd(null));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('1 line off the codeline\'s base: one more pass — that line\'s base, its own branch suffix, its own logs, the story pending again', () => {
    const { r, recorded, laneLog } = runLines('lib', lanePrd(plan('lib', [
      { line: '2.x', base: 'v2.4.0', version: '2.5.0', onCodelineBase: true },
      { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false },
    ])));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded.length, `the 1.x line never ran:\n${r.stdout}${r.stderr}`).toBeGreaterThan(0);
    for (const c of recorded) {
      expect(c.base).toBe('v1.9.0');
      expect(c.line).toBe('1.x');
      expect(c.suffix).toMatch(/1\.x/);
      expect(c.codeline).toBe('lib');
      expect(c.root).toBe('/w/lib');
      expect(c.logDir.startsWith(laneLog) && c.logDir !== laneLog, 'the line shares the lane\'s logs').toBe(true);
      expect(c.args).toContain('--reset');
      expect(c.stories).toEqual([{ id: 'S-1', status: 'pending', completed: false }]);
    }
    expect(new Set(recorded.map((c) => c.phase))).toEqual(new Set(['core']));
  });

  it('3 lines, one on the codeline\'s base: exactly two more passes, each with its own base, branch and logs', () => {
    const { r, recorded } = runLines('lib', lanePrd(plan('lib', [
      { line: '3.x', base: 'v3.0.0', version: '3.0.1', onCodelineBase: true },
      { line: '2.x', base: 'v2.4.0', version: '2.4.1', onCodelineBase: false },
      { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false },
    ])));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded.map((c) => c.base).sort()).toEqual(['v1.9.0', 'v2.4.0']);
    expect(new Set(recorded.map((c) => c.suffix)).size).toBe(2);
    expect(new Set(recorded.map((c) => c.logDir)).size).toBe(2);
  });

  // A STEP NEVER RUNS TWICE: a story already specified for this codeline is not specified again on another line (the
  // rehearsal's 7.x pass re-ran the spec pass because the resume had switched it on for the canonical PRD).
  it('a story already specified is not specified again on the line; one never specified is', () => {
    const specified = { ...lanePrd(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }])) };
    specified.stories = specified.stories.map((x) => ({ ...x, specification: { runId: 'R', appliedAgents: ['openspec'] }, fixSiteAnalysisPerCodeline: { lib: [{ file: 'src/a.ts' }] } }));
    const a = runLines('lib', specified);
    expect(a.r.status, a.r.stdout + a.r.stderr).toBe(0);
    expect(a.recorded.length).toBeGreaterThan(0);
    expect(a.recorded.every((c) => c.spec === '0'), 'an already-specified story was specified again').toBe(true);
    const b = runLines('lib', lanePrd(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }])));
    expect(b.recorded.length).toBeGreaterThan(0);
    expect(b.recorded.every((c) => c.spec !== '0'), 'a story never specified skipped its spec').toBe(true);
  });

  it('a line whose onCodelineBase the plan did not state is not guessed at', () => {
    const { r, recorded } = runLines('lib', lanePrd(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1' }])));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('another codeline\'s release lines are not this codeline\'s to run', () => {
    const { r, recorded } = runLines('site', { ...lanePrd(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }])), stories: [{ ...lanePrd(null).stories[0], codeline: 'site', overallPlan: plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }]) }] });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded).toEqual([]);
    expect(r.stdout, 'a release-line pass was started for a codeline that does not provide the package').not.toMatch(/release line/);
  });

  it('a line that fails fails the lane, and no later line runs after it', () => {
    const { r, recorded } = runLines('lib', lanePrd(plan('lib', [
      { line: '2.x', base: 'v2.4.0', version: '2.4.1', onCodelineBase: false },
      { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false },
    ])), 1);
    expect(r.status).not.toBe(0);
    expect(new Set(recorded.map((c) => c.base)).size, 'a later line ran after one failed').toBe(1);
  });
});

// A STEP NEVER RUNS TWICE. AMSD-2974, 2026-10-07: cx-shared's 7.x line completed; the line's PRD was rebuilt with the
// story pending on every launch, so a resume would have worked the 7.x line again from v7.14.0. A resume keeps a
// completed story completed (config/resume-preserves.json, completed-stories) — a line's stories too.
// A completed line is not passed over by rule, nor redone: on resume its reviewer judges it again, against the
// story's plan as it stands (operator, 2026-10-08 — the 7.x back-port carried a third of the 8.x fix and every check
// let it through). The line's PRD and branch are kept; the phase runs without --reset, so Step 1 passes it as
// completed and the review → rework loop decides.
describe('on resume a release line this run completed goes back to its reviewer — kept, not redone', () => {
  const two = () => lanePrd(plan('lib', [
    { line: '2.x', base: 'v2.4.0', version: '2.4.1', onCodelineBase: false },
    { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false },
  ]));
  const lineDone = { implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', phase: 'core', status: 'completed', completed: true }] };
  const lineFailed = { implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', phase: 'core', status: 'failed', completed: false }] };
  const repo = () => {
    const d = tmp('release-rejudge-');
    const git = (...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'master'); writeFileSync(join(d, 'a.txt'), 'a\n'); git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    git('branch', 'AI-S-1-2.x'); git('checkout', '-q', '-b', 'bugfix/AI-S-1');
    return d;
  };
  it('resume: the completed line runs without --reset, on its own branch, with its PRD as it was; and says so', () => {
    const d = repo();
    const { r, recorded } = runLines('lib', two(), 0, { env: { EPAM_RESUME_RUN: '20261001T181327Z' }, seed: { '2.x': lineDone }, wt: d });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const l2 = recorded.find((c) => c.line === '2.x');
    expect(l2, 'the completed line was passed over').toBeTruthy();
    expect(l2.args).not.toContain('--reset');
    expect(l2.branch).toBe('AI-S-1-2.x');
    expect(l2.stories).toEqual([{ id: 'S-1', status: 'completed', completed: true }]);
    expect(l2.plan, 'the kept line was judged against an older plan').toEqual(two().stories[0].overallPlan);
    expect(r.stdout).toMatch(/release line 2\.x completed in this run — its reviewer judges it again/);
    const l1 = recorded.find((c) => c.line === '1.x');
    expect(l1.args).toContain('--reset');
  });
  it('resume: a line whose story did not complete is worked again as before', () => {
    const { recorded } = runLines('lib', two(), 0, { env: { EPAM_RESUME_RUN: '20261001T181327Z' }, seed: { '2.x': lineFailed } });
    expect(recorded.map((c) => c.line)).toEqual(['2.x', '1.x']);
    expect(recorded.every((c) => c.args.includes('--reset'))).toBe(true);
  });
  it('a fresh run never trusts a line PRD left by another run', () => {
    const { recorded } = runLines('lib', two(), 0, { seed: { '2.x': lineDone } });
    expect(recorded.map((c) => c.line)).toEqual(['2.x', '1.x']);
    expect(recorded.every((c) => c.args.includes('--reset'))).toBe(true);
  });
});


// AMSD-2974, 2026-10-07: after the 7.x line pass cx-shared stayed checked out on bugfix/AI-AMSD-2974-7.x (7.14.0);
// the next launch's detective read that checkout and planned the codeline's own line as 7.x — and 8.x as a back-port.
describe('after its release lines the codeline is back on the branch it was on', () => {
  const repo = () => {
    const d = tmp('release-home-');
    const git = (...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'master'); writeFileSync(join(d, 'a.txt'), 'a\n'); git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'); git('checkout', '-q', '-b', 'bugfix/AI-S-1');
    return { d, branch: () => git('branch', '--show-current').stdout.trim() };
  };
  const lines = () => lanePrd(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }]));
  it('the lines pass: back on its own story branch, and says so', () => {
    const r = repo();
    const { r: run, recorded } = runLines('lib', lines(), 0, { wt: r.d });
    expect(recorded.length, 'no line ran — the test proves nothing').toBe(1);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(r.branch()).toBe('bugfix/AI-S-1');
    expect(run.stdout).toMatch(/back on bugfix\/AI-S-1/);
  });
  it('a line fails: back on its own story branch all the same, and the lane still fails', () => {
    const r = repo();
    const { r: run, recorded } = runLines('lib', lines(), 1, { wt: r.d });
    expect(recorded.length).toBe(1);
    expect(run.status).not.toBe(0);
    expect(r.branch()).toBe('bugfix/AI-S-1');
  });
});

// A run killed during a line pass (SIGKILL: no trap runs) leaves the codeline on the line's branch. The next launch
// returns every codeline of the PRD to the branch its release lines left, before the story is planned.
describe('a launch returns a codeline a killed line pass left on the line\'s branch', () => {
  function killedMidLine(record: boolean) {
    const d = tmp('release-killed-');
    const cl = join(d, 'lib'); mkdirSync(cl);
    const git = (...a: string[]) => spawnSync('git', ['-C', cl, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'master'); writeFileSync(join(cl, 'a.txt'), 'a\n'); git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'); git('checkout', '-q', '-b', 'bugfix/AI-S-1');
    const runner = join(d, 'killed.sh');
    // The line pass is killed outright: the codeline is on the line's branch and nothing after the pass runs.
    writeFileSync(runner, '#!/bin/bash\ngit -C "$PROJECT_ROOT" checkout -q -B "AI-S-1$EPAM_BRANCH_SUFFIX"\nkill -9 $PPID\n');
    chmodSync(runner, 0o755);
    const prdFile = join(d, 'lane-prd.json');
    writeFileSync(prdFile, JSON.stringify({ ...lanePrd(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }])), project: { outputDir: cl, outputDirs: [{ codeline: 'lib', path: cl }] } }));
    const laneLog = join(d, 'lanes', 'lib'); mkdirSync(laneLog, { recursive: true });
    const env = { ...process.env, LOG_DIR: d, EPAM_RESUME_RUN: '' };
    if (record) spawnSync('bash', ['-c', `${LOGS}\nSCRIPT_DIR=${JSON.stringify(SCRIPTS)}\nNODE_BIN=${JSON.stringify(process.execPath)}\n. ${JSON.stringify(LINES)}\n _run_release_lines lib ${JSON.stringify(prdFile)} ${JSON.stringify(cl)} ${JSON.stringify(laneLog)} /dev/null "" ${JSON.stringify(runner)}`], { encoding: 'utf8', env });
    else git('checkout', '-q', '-b', 'AI-S-1-1.x');
    const left = git('branch', '--show-current').stdout.trim();
    const next = spawnSync('bash', ['-c', `${LOGS}\nSCRIPT_DIR=${JSON.stringify(SCRIPTS)}\nNODE_BIN=${JSON.stringify(process.execPath)}\n. ${JSON.stringify(LINES)}\n _return_codelines_from_release_lines ${JSON.stringify(prdFile)}`], { encoding: 'utf8', env });
    return { left, next, now: git('branch', '--show-current').stdout.trim() };
  }
  it('killed mid-line: left on the line\'s branch; the next launch puts it back, and says so', () => {
    const { left, next, now } = killedMidLine(true);
    expect(left, 'the kill did not leave the codeline on the line branch — the test proves nothing').toBe('AI-S-1-1.x');
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(now).toBe('bugfix/AI-S-1');
    expect(next.stdout).toMatch(/back on bugfix\/AI-S-1/);
  });
  it('a codeline no line pass left: its branch is its own business — not moved', () => {
    const { left, now } = killedMidLine(false);
    expect(left).toBe('AI-S-1-1.x');
    expect(now).toBe('AI-S-1-1.x');
  });
});

describe('a story branch per release line, from a base that may be a tag', () => {
  const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const commit = (dir: string, msg: string) => { writeFileSync(join(dir, 'f.txt'), `${msg}\n`); git(dir, 'add', '-A'); git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg); return git(dir, 'rev-parse', 'HEAD').stdout.trim(); };
  function repoWithReleases() {
    const d = tmp('release-branches-');
    const origin = join(d, 'origin.git'); const work = join(d, 'work');
    mkdirSync(work); git(work, 'init', '-q', '-b', 'master');
    const v1 = commit(work, 'one'); git(work, 'tag', 'v1.0.0');
    const v2 = commit(work, 'two'); git(work, 'tag', 'v2.0.0');
    const head = commit(work, 'three');
    spawnSync('git', ['clone', '-q', '--bare', work, origin]);
    const repo = join(d, 'repo'); spawnSync('git', ['clone', '-q', origin, repo]);
    return { repo, v1, v2, head };
  }
  const sh = (script: string, env: Record<string, string> = {}) => spawnSync('bash', ['-c', `${LOGS}\n. "${PERIM}"\n. "${GITOPS}"\n${script}`], { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1', ...env } });

  it('the codeline\'s own line: AI-<story> from its branch, as today', () => {
    const { repo, head } = repoWithReleases();
    const r = sh(`ensure_story_branch "${repo}" S-1 master`);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(repo, 'rev-parse', 'AI-S-1').stdout.trim()).toBe(head);
  });

  it('another line: its own story branch from the line\'s tag — and the codeline\'s own story branch is untouched', () => {
    const { repo, head, v1 } = repoWithReleases();
    expect(sh(`ensure_story_branch "${repo}" S-1 master`).status).toBe(0);
    const r = sh(`ensure_story_branch "${repo}" S-1 v1.0.0`, { EPAM_BRANCH_SUFFIX: '-1.x' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(repo, 'rev-parse', 'AI-S-1-1.x').stdout.trim(), 'the line\'s branch is not on its tag').toBe(v1);
    expect(git(repo, 'rev-parse', 'AI-S-1').stdout.trim(), 'the codeline\'s own story branch moved').toBe(head);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()).toBe('AI-S-1-1.x');
  });

  // THE LANE'S HAND-OFF, as run-agent-orchestration.sh does it (live 2026-10-07): JIRA_BASELINE_BRANCH is set from
  // codeline_baseline_ref with only origin/ removed, then the story branch is made from it. It came out as
  // 'origin/refs/tags/v7.14.0' and the line's branch was never created.
  it('the lane\'s hand-off: the baseline the lane sets from a tag still makes the line\'s branch on that tag', () => {
    const { repo, v1 } = repoWithReleases();
    const r = sh(`_ref=$(codeline_baseline_ref "${repo}" v1.0.0); export JIRA_BASELINE_BRANCH="\${_ref#origin/}"; echo "BASE=$JIRA_BASELINE_BRANCH"; ensure_story_branch "${repo}" S-1 "$JIRA_BASELINE_BRANCH"`, { EPAM_BRANCH_SUFFIX: '-1.x' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/BASE=refs\//);
    expect(git(repo, 'rev-parse', 'AI-S-1-1.x').stdout.trim()).toBe(v1);
  });

  it('a story branch made from a base given as refs/tags/<tag> lands on that tag', () => {
    const { repo, v1 } = repoWithReleases();
    const r = sh(`ensure_story_branch "${repo}" S-1 refs/tags/v1.0.0`, { EPAM_BRANCH_SUFFIX: '-1.x' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(repo, 'rev-parse', 'AI-S-1-1.x').stdout.trim()).toBe(v1);
  });

  it('the baseline a line\'s gates diff against is its tag', () => {
    const { repo, v2 } = repoWithReleases();
    const r = sh(`codeline_baseline_ref "${repo}" v2.0.0`);
    expect(r.stdout.trim(), r.stderr).not.toBe('');
    expect(git(repo, 'rev-parse', `${r.stdout.trim()}^{commit}`).stdout.trim()).toBe(v2);
  });
});

describe('the plan says which line the codeline is already on, and the agents of a line pass are told their line', () => {
  process.env.SPEC_MODE_NO_MAIN = '1';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const runner = require(join(SCRIPTS, 'spec-mode-runner.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixPlan = require(join(SCRIPTS, 'lib/producers/fix-plan.js'));
  it('the plan template asks for onCodelineBase on each release line, and the parse keeps it', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/detective-overall-plan.json'), 'utf8')).body;
    expect(tpl).toContain('onCodelineBase');
    const p = runner.parseOverallPlan(`<OVERALL_PLAN>${JSON.stringify(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }]))}</OVERALL_PLAN>`);
    expect(p.packages[0].releaseLines[0].onCodelineBase).toBe(false);
  });
  it('a line pass is told which line is its own; the codeline\'s own pass is not told a line', () => {
    const p = plan('lib', [{ line: '2.x', base: 'v2.4.0', version: '2.5.0', onCodelineBase: true }, { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }]);
    const prev = process.env.EPAM_RELEASE_LINE;
    try {
      process.env.EPAM_RELEASE_LINE = '1.x';
      const t = fixPlan.overallPlanText(p, 'lib');
      expect(t).toMatch(/release line 1\.x[^\n]*THIS RELEASE LINE/);
      expect(t).not.toMatch(/release line 2\.x[^\n]*THIS RELEASE LINE/);
      delete process.env.EPAM_RELEASE_LINE;
      expect(fixPlan.overallPlanText(p, 'lib')).not.toContain('THIS RELEASE LINE');
    } finally { if (prev === undefined) delete process.env.EPAM_RELEASE_LINE; else process.env.EPAM_RELEASE_LINE = prev; }
  });

  // Live run 3, 2026-10-07: told the 8.x line "ships as 8.12.0", the writer set package.json to 8.12.0 and a later
  // attempt the lock file — the coupled-pair gate failed the story. cx-shared sets a version in its own release commit
  // (df9ec0c "7.14.0"); the 7.x writer left the version alone. The agents are told who sets the version: the
  // codeline's own release practice, which its history shows — not hardcoded either way.
  it('the agents are told the version a line ships as is set the way the codeline makes its releases', () => {
    const t = fixPlan.overallPlanText(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }]), 'lib');
    expect(t).toMatch(/release line 1\.x: cut from v1\.9\.0, ships as 1\.9\.1/);
    expect(t).toMatch(/version a release line ships as is set the way this codeline makes its releases — its history shows how/);
    expect(t).toMatch(/this story's change is the fix/);
    expect(t.match(/version a release line ships as/g)?.length).toBe(1);
  });
  // Operator, 2026-10-08: the 7.x back-port carried a third of the 8.x fix — its writer worked to a narrower
  // prescription, its reviewer judged against that. What a line carries is the planner's to say; every agent of the
  // line reads it in the plan.
  it('what each release line carries, as the planner wrote it, reaches the agents', () => {
    const t = fixPlan.overallPlanText(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false, carries: 'the change made on the codeline\'s own line, ported in full' } as Line]), 'lib');
    expect(t).toMatch(/release line 1\.x: cut from v1\.9\.0, ships as 1\.9\.1[^\n]*carries: the change made on the codeline's own line, ported in full/);
    expect(fixPlan.overallPlanText(plan('lib', [{ line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }]), 'lib')).not.toMatch(/carries:/);
  });
  it('a plan with no release lines says nothing about versions', () => {
    expect(fixPlan.overallPlanText(plan('lib', []), 'lib')).not.toMatch(/version a release line ships as/);
  });
});
