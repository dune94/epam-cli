/**
 * THE READINESS AUDIT BLOCKED A HEALTHY RUN BECAUSE IT ASKED THE ENVIRONMENT, NOT THE RUN.
 *
 * agent-readiness resolves the project's skills once and flags every agent when none resolve —
 * "no project skills resolve — neither a codeline stack nor any KB, so every agent works with no
 * knowledge of this project". It resolved them like this:
 *
 *     process.env.EPAM_CODELINE_PATHS || process.env.PROJECT_ROOT || ''
 *
 * mint-agents-step sets NEITHER. It has the codelines in hand — it prints them at the top of the
 * stage, "codeline mocka: /…/mock-a (2 declared deps)" — and the audit ignored that and asked the
 * environment, which was empty.
 *
 * Live 2026-08-17, run 20260817T195746Z: discovery correct, survey correct for both codelines,
 * mint 3/3 on the first attempt, assignment correct, 36 of 51 prompts generated and verified
 * accurate against the repositories — and then my own guard failed the run with 60 identical gaps,
 * every one of them false. The audit was right that a roster with no skills is broken; it was
 * wrong that this roster had none.
 *
 * SAME CLASS AS THE DEFECT IT WAS WRITTEN TO CATCH. The first version of this audit read
 * profiles.json rather than the roster the run was using, and passed while the minted agents sat
 * outside the set. That was fixed by having the caller name the roster. This is the same mistake
 * one field over: the caller must name the codelines too, because only the caller knows them.
 *
 * A GUARD THAT FAILS A HEALTHY RUN IS WORSE THAN NO GUARD. It costs a whole run and it teaches
 * the operator to distrust the gate, which is how a real gap gets waved through later.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/agent-readiness.js');
const REAL_AGENTS = join(ROOT, 'orchestrations/agents');
const NODE = process.execPath;

let work: string;
let agentsDir: string;
let projectDir: string;
let repo: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'readiness-skills-'));
  agentsDir = join(work, 'agents');
  projectDir = join(work, 'project');
  repo = join(work, 'repo-a');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  cpSync(join(REAL_AGENTS, 'invocation-profiles.json'), join(agentsDir, 'invocation-profiles.json'));
  // A real codeline: a manifest the ecosystem registry can recognise.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'repo-a', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2', typescript: '^5' },
  }));
  writeFileSync(join(agentsDir, 'profiles.json'), JSON.stringify({ 'team-lead-review': 'brief' }));
});
afterEach(() => {
  delete process.env.EPAM_CODELINE_PATHS;
  rmSync(work, { recursive: true, force: true });
});

function audit(codelinePaths?: string) {
  const argv = [HANDLER, projectDir, agentsDir, join(agentsDir, 'profiles.json')];
  if (codelinePaths !== undefined) argv.push(codelinePaths);
  const r = spawnSync(NODE, argv, {
    encoding: 'utf8',
    timeout: 60000,
    // Deliberately EMPTY, exactly as the mint process is.
    env: { ...process.env, EPAM_CODELINE_PATHS: '', PROJECT_ROOT: '', EPAM_PROJECT_CONFIG_DIR: projectDir },
  });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* exit 2 writes no report */ }
  return { rc: r.status, err: r.stderr, json };
}

const skillGaps = (j: any) => (j?.gaps || []).filter((g: any) => g.requirement === 'skills');

describe('the readiness audit asked the environment, not the run', () => {
  it('THE CALLER CAN NAME THE CODELINES — the run knows them, the environment does not', () => {
    const { json } = audit(repo);
    expect(json, 'the audit produced no report').toBeTruthy();
    expect(skillGaps(json),
      'the audit still cannot see a codeline the caller handed it, so every agent reads as skill-less')
      .toEqual([]);
  });

  it('SEVERAL codelines are accepted, as a multi-codeline run has', () => {
    const second = join(work, 'repo-b');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'package.json'), JSON.stringify({ name: 'repo-b', scripts: { test: 'vitest run' } }));
    const { json } = audit(`${repo},${second}`);
    expect(skillGaps(json)).toEqual([]);
  });

  it('a genuinely skill-less project is STILL a gap — the guard is not disabled', () => {
    // The audit exists because an agent with no knowledge of the project works blind. Passing a
    // path with no recognisable stack must still report that.
    const bare = join(work, 'not-a-codeline');
    mkdirSync(bare, { recursive: true });
    const { json } = audit(bare);
    expect(skillGaps(json).length,
      'a project with no stack and no KB now passes, which defeats the check').toBeGreaterThan(0);
  });

  it('falls back to the environment when the caller names nothing', () => {
    // Callers that already export EPAM_CODELINE_PATHS must keep working unchanged.
    process.env.EPAM_CODELINE_PATHS = repo;
    const r = spawnSync(NODE, [HANDLER, projectDir, agentsDir, join(agentsDir, 'profiles.json')], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, EPAM_CODELINE_PATHS: repo, EPAM_PROJECT_CONFIG_DIR: projectDir },
    });
    const json = JSON.parse(r.stdout);
    expect(skillGaps(json)).toEqual([]);
  });

  it('THE MINT PASSES THEM — a handler nothing feeds is fed by the environment again', () => {
    const mint = readFileSync(join(ROOT, 'orchestrations/scripts/mint-agents-step.js'), 'utf8');
    const i = mint.indexOf('agent-readiness.js');
    expect(i, 'the mint no longer runs the readiness audit').toBeGreaterThan(-1);
    const call = mint.slice(i, i + 900);
    expect(call, 'the mint runs the audit without telling it which codelines are in scope')
      .toMatch(/codelines?/i);
  });
});
