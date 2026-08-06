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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

  it('the writer may', () => {
    expect(may('writer')).toBe(true);
    expect(may('typescript-engineer')).toBe(true);
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
    expect(src).toMatch(/perimeter_apply/);
  });

  it('ensure_story_branch reopens the repo once it is on the story branch', () => {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh'), 'utf8');
    expect(src).toMatch(/codeline-write-perimeter\.sh/);
    expect(src).toMatch(/perimeter_apply "\$codeline_root"/);
  });

  it('the lock is applied AFTER the baseline reset, never before', () => {
    const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
    expect(
      src.indexOf('perimeter_apply'),
      'locking before the reset would leave a dirty tree frozen in place',
    ).toBeGreaterThan(src.indexOf('brownfield-preflight-reset.sh'));
  });
});
