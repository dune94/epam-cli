/**
 * INTEGRATION — a client codeline cannot be written while it sits on its
 * baseline branch, by ANY means, including bash.
 *
 * THE INCIDENT THIS WOULD HAVE CAUGHT
 * -----------------------------------
 * Run 20260806T113101Z lost ~1050 lines across five files in a real client
 * repository. pageService.ts went 669 lines -> 13. contentCard.ts had its real
 * domain types replaced with an invented generic interface. It happened four
 * minutes into Step 1, the SPEC PASS — the writer had not run at all, and the
 * run was configured to pause before it.
 *
 * 6,860 unit tests passed that same afternoon. None of them asserted the one
 * property that mattered: run the pipeline's agents at a repository and the
 * repository must come back unchanged unless a writer deliberately changed it.
 * Every test asserted that functions were called and strings were present.
 *
 * WHY A TOOL ALLOWLIST CANNOT BE THE FIX
 * --------------------------------------
 * WriteFile.ts has a scope guard. Bash.ts has none — no cwd restriction, no
 * command filtering, no deny list; it takes an arbitrary cwd and runs anything.
 * Six agents hold `bash` against client repos (code-graph-detective,
 * team-lead-review, failure-analyst, prd-change-reviewer, plan-reviewer,
 * lint-fix), and AI_GATE_ALLOW_TOOLS=1 also sets EPAM_DANGEROUS_SKIP_APPROVAL=1
 * so nothing prompts. An allowlist naming which TOOLS an agent gets says nothing
 * about what `bash` then does. Enforcement has to sit below the tools.
 *
 * These tests use real git repositories and real chmod, and attempt real writes
 * through bash — the exact channel that caused the loss.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PERIMETER = join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-write-perimeter.sh');
const BASELINE = 'develop';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+w', d]);   // unlock so cleanup can remove it
    rmSync(d, { recursive: true, force: true });
  }
});

/** A real client-shaped repo on its baseline branch, with engine state present. */
function codeline(): string {
  const d = mkdtempSync(join(tmpdir(), 'perim-'));
  dirs.push(d);
  spawnSync('git', ['init', '-q', d]);
  spawnSync('git', ['-C', d, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', d, 'config', 'user.name', 't']);
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'service.ts'), 'export const REAL = "client code";\n'.repeat(40));
  writeFileSync(join(d, 'src', 'types.ts'), 'export interface Real { a: string }\n');
  spawnSync('git', ['-C', d, 'add', '-A']);
  spawnSync('git', ['-C', d, 'commit', '-qm', 'baseline']);
  spawnSync('git', ['-C', d, 'branch', '-m', BASELINE]);
  // Engine state lives inside the codeline and must stay writable.
  mkdirSync(join(d, '.epam'), { recursive: true });
  writeFileSync(join(d, '.epam', 'settings.json'), '{}');
  return d;
}

/** Run shell with the perimeter sourced, exactly as the pipeline does. */
function sh(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `. ${JSON.stringify(PERIMETER)}\n${script}`], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, JIRA_BASELINE_BRANCH: BASELINE, ...env },
  });
}

const bashWrite = (repo: string, rel: string) =>
  sh(`echo "AGENT OVERWROTE THIS" > ${JSON.stringify(join(repo, rel))}`);

describe('on the baseline branch, client source is unwritable', () => {
  it('THE INCIDENT: bash cannot overwrite a source file', () => {
    const repo = codeline();
    const before = readFileSync(join(repo, 'src/service.ts'), 'utf8');

    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    const w = bashWrite(repo, 'src/service.ts');

    expect(w.status, 'bash wrote to a locked client file').not.toBe(0);
    expect(
      readFileSync(join(repo, 'src/service.ts'), 'utf8'),
      'client source changed — this is the 669-line-to-13 failure',
    ).toBe(before);
  });

  it('bash cannot truncate a file either (the actual observed damage)', () => {
    const repo = codeline();
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    sh(`: > ${JSON.stringify(join(repo, 'src/service.ts'))}`);
    expect(readFileSync(join(repo, 'src/service.ts'), 'utf8').length).toBeGreaterThan(0);
  });

  it('the whole tracked tree is protected, not one sampled file', () => {
    const repo = codeline();
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    for (const f of ['src/service.ts', 'src/types.ts']) {
      expect(bashWrite(repo, f).status, `${f} was writable`).not.toBe(0);
    }
  });
});

describe('the engine can still do its job while locked', () => {
  it('.epam/ stays writable — the engine writes its own state there mid-run', () => {
    const repo = codeline();
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    const w = sh(`echo '{"x":1}' > ${JSON.stringify(join(repo, '.epam/settings.json'))}`);
    expect(w.status, 'locking engine state would break the run, not protect it').toBe(0);
  });

  it('git reset --hard / clean / checkout still work — teardown must not break', () => {
    const repo = codeline();
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    expect(spawnSync('git', ['-C', repo, 'checkout', '-qB', 'bugfix/AI-1', BASELINE]).status).toBe(0);
    expect(spawnSync('git', ['-C', repo, 'reset', '--hard', BASELINE, '--quiet']).status).toBe(0);
    expect(spawnSync('git', ['-C', repo, 'clean', '-fd', '--quiet']).status).toBe(0);
    expect(readFileSync(join(repo, 'src/service.ts'), 'utf8')).toContain('client code');
  });
});

describe('a story branch is where edits are allowed to land', () => {
  it('once on a story branch, writes succeed', () => {
    const repo = codeline();
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    spawnSync('git', ['-C', repo, 'checkout', '-qb', 'bugfix/AI-2']);
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    expect(bashWrite(repo, 'src/service.ts').status, 'the writer cannot do its job').toBe(0);
  });

  it('a linked worktree is always writable', () => {
    const repo = codeline();
    const wt = `${repo}-wt`;
    dirs.push(wt);
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-1', wt]);
    sh(`perimeter_apply ${JSON.stringify(wt)}`);
    expect(bashWrite(wt, 'src/service.ts').status).toBe(0);
  });

  it('detached HEAD stays locked — nothing should be authored there', () => {
    const repo = codeline();
    spawnSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
    sh(`perimeter_apply ${JSON.stringify(repo)}`);
    expect(bashWrite(repo, 'src/service.ts').status).not.toBe(0);
  });
});

describe('only agents that author code may write', () => {
  const may = (role: string) => sh(`perimeter_role_may_write ${JSON.stringify(role)}`).status === 0;

  it('the writer may, and so does an implementer the project declares', () => {
    // AUTHORSHIP IS A PROPERTY OF THE AGENT, READ FROM THE PROJECT ROSTER.
    //
    // This asserted `typescript-engineer` may write, unconditionally. That was true when
    // canonical engineering roles were implicitly authors; the perimeter now reads each agent's
    // `kind` from <project>/roster.json, and NO project declares typescript-engineer — so the
    // refusal was correct and the assertion was pinning the retired design. Naming a canonical
    // role here also hardcodes one project's vocabulary into the engine's own suite.
    expect(may('writer'), 'an authoring seam was refused').toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'perim-roster-')); dirs.push(dir);
    writeFileSync(join(dir, 'roster.json'), JSON.stringify({
      agents: {
        'a-declared-implementer': {
          kind: 'implementer', persona: 'authors code for this project',
          ancestor: 'canonical', derivedFromSha256: '0'.repeat(64),
        },
      },
    }, null, 2));
    const withProject = (role: string) =>
      sh(`perimeter_role_may_write ${JSON.stringify(role)}`, { EPAM_PROJECT_CONFIG_DIR: dir }).status === 0;
    expect(withProject('a-declared-implementer'),
      'an agent the project declares an implementer cannot write').toBe(true);
  });

  it('agents that only form judgements may NOT — all six bash holders', () => {
    for (const r of ['team-lead-review', 'code-graph-detective', 'failure-analyst',
                     'prd-change-reviewer', 'plan-reviewer', 'spec-agent']) {
      expect(may(r), `${r} is permitted to write code`).toBe(false);
    }
  });

  it('an unnamed caller may not — unknown provenance is not permission', () => {
    expect(may('')).toBe(false);
  });

  it('a :plan suffix does not smuggle in a role', () => {
    expect(may('writer:plan')).toBe(true);        // same role, still the writer
    expect(may('code-graph-detective:plan')).toBe(false);
  });

  it('is configurable per project, not hardcoded to one pipeline\'s role names', () => {
    const r = sh('perimeter_role_may_write custom-authoring-agent',
                 { EPAM_PERIMETER_WRITE_ROLES: 'custom-authoring-agent' });
    expect(r.status).toBe(0);
  });
});

describe('wired into the pipeline, not merely available', () => {
  it('the launcher locks every codeline before any agent runs', () => {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
    expect(src).toMatch(/codeline-write-perimeter\.sh/);
    // 2026-08-09: the run-start loop calls perimeter_SEAL, not perimeter_apply. apply answers
    // "is this repo in its write window?" and unlocks on any non-baseline branch — at run
    // start that reads a LEFTOVER branch as authorisation, which left a client repo writable
    // for a whole run and a source file was rewritten during the spec pass.
    expect(src).toMatch(/perimeter_seal/);
  });

  it('ensure_story_branch reopens the repo once it is on the story branch', () => {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh'), 'utf8');
    expect(src).toMatch(/codeline-write-perimeter\.sh/);
    expect(src).toMatch(/perimeter_apply "\$codeline_root"/);
  });

  it('the lock is applied AFTER the baseline reset, never before', () => {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
    expect(
      src.indexOf('perimeter_seal'),
      'locking before the reset would leave a dirty tree frozen in place',
    ).toBeGreaterThan(src.indexOf('brownfield-preflight-reset.sh'));
  });
});

/**
 * EVERY EXIT RELEASES THE PERIMETER — including the successful one.
 *
 * perimeter_apply() chmods a codeline's tracked files read-only at run start.
 * ensure_story_branch() reopens a repo once it reaches a story branch. Nothing reopened them
 * when the RUN ended, and run-agent-orchestration.sh does not even source this library, so no
 * exit path could.
 *
 * Observed twice on 2026-08-06: after a run PAUSED before the writer — the normal successful
 * ending under EPAM_PAUSE_BEFORE_WRITER — 23 of the operator's repositories were still
 * read-only, with nothing said about it. The kill path has the same gap (backlogged). Pause is
 * not an error case; it is how these runs are meant to finish, so this is the common path.
 *
 * A release is idempotent and safe: it restores write permission, it does not touch content.
 */
describe('the perimeter is released when the run ends', () => {
  function lockedRepos(count: number): string {
    const root = mkdtempSync(join(tmpdir(), 'perim-root-'));
    dirs.push(root);
    for (let i = 0; i < count; i += 1) {
      const d = join(root, `repo-${i}`);
      mkdirSync(join(d, 'src'), { recursive: true });
      writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
      spawnSync('git', ['init', '-q', d]);
      spawnSync('git', ['-C', d, 'config', 'user.email', 't@t']);
      spawnSync('git', ['-C', d, 'config', 'user.name', 't']);
      spawnSync('git', ['-C', d, 'add', '-A']);
      spawnSync('git', ['-C', d, 'commit', '-qm', 'base']);
      spawnSync('git', ['-C', d, 'branch', '-m', 'develop']);
      spawnSync('bash', ['-c',
        `. ${JSON.stringify(PERIMETER)}; JIRA_BASELINE_BRANCH=develop perimeter_apply ${JSON.stringify(d)}`]);
    }
    return root;
  }
  /**
   * Writable? — and it must never answer "no" because the CHECK broke.
   *
   * The first version swallowed every error, and `constants` was not imported: `constants.W_OK`
   * threw on every call, so this returned false unconditionally. The "the fixture is really
   * locked" assertion passed for the wrong reason, and the release assertion could not pass at
   * all — a perfectly good fix looked broken for twenty minutes. Only ENOENT/EACCES mean
   * not-writable; anything else is the instrument failing and must be raised.
   */
  const writable = (p: string) => {
    try { accessSync(p, constants.W_OK); return true; } catch (e: any) {
      if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOENT')) return false;
      throw e;
    }
  };

  it('the fixture is really locked — otherwise this proves nothing', () => {
    const root = lockedRepos(2);
    expect(writable(join(root, 'repo-0/src/a.ts'))).toBe(false);
  });

  it('THE GAP: one call releases every codeline under the root', () => {
    const root = lockedRepos(3);
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(PERIMETER)}; perimeter_release_all ${JSON.stringify(root)}`], { encoding: 'utf8' });
    expect(r.status, `release failed: ${r.stderr}`).toBe(0);
    for (const i of [0, 1, 2]) {
      expect(
        writable(join(root, `repo-${i}/src/a.ts`)),
        `repo-${i} is still read-only — the operator cannot edit their own repository`,
      ).toBe(true);
    }
  });

  it('it is safe on a root with nothing locked, and on a missing root', () => {
    const clean = mkdtempSync(join(tmpdir(), 'perim-clean-')); dirs.push(clean);
    for (const arg of [clean, '/does/not/exist', '']) {
      const r = spawnSync('bash', ['-c',
        `. ${JSON.stringify(PERIMETER)}; perimeter_release_all ${JSON.stringify(arg)}`], { encoding: 'utf8' });
      expect(r.status, `release threw on ${arg || '<empty>'}: ${r.stderr}`).toBe(0);
    }
  });

  it('the orchestrator releases on exit, so a PAUSE does not leave repos locked', () => {
    const orch = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(
      orch,
      'run-agent-orchestration.sh does not even source the perimeter library, so no exit path can release it',
    ).toMatch(/codeline-write-perimeter/);
    expect(orch, 'nothing releases the perimeter when the run ends').toMatch(/perimeter_release_all/);
    expect(orch, 'the release must fire on EVERY exit, not just the happy path')
      .toMatch(/trap\s+'[^']*_release_write_perimeter[^']*'\s+EXIT|trap[^\n]*perimeter_release_all/);
  });
});
