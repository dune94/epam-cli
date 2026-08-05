/**
 * THE ENGINE'S OWN FILES MUST NEVER ENTER A CLIENT REPO. EVER.
 *
 * Live metrolinx 20260804T225443Z: `orchestrations/agents/KB.md` — the ENGINE's
 * knowledge base — appeared in the upexpress lane's writer-output manifest. It does not
 * exist in that client repo, because teardown deleted it; it was there during the run.
 *
 * How it got there: claude.sh and codemie-claude.sh both instruct the writer agent to
 * "append one entry to `orchestrations/agents/KB.md`". That is a RELATIVE path, and the
 * agent's cwd is the CLIENT codeline — so the agent creates
 * <client_repo>/orchestrations/agents/KB.md. From there `git add -A` stages it and it is
 * one commit away from landing in the customer's history.
 *
 * This is not new. lib/git-ops.sh carries the scar in its own comment:
 *
 *   "orchestrations/ added 2026-08-01 (Writer Retest dry run): the KB scratchpad writer
 *    dropped orchestrations/agents/KB.md into a client repo. Only orchestrations/logs/*
 *    had been excluded — the whole tree wasn't, so the same 'excluded one instance, not
 *    the class' gap reappeared under a new path."
 *
 * The fix was applied to ONE of three staging sites. As of this test being written:
 *
 *   lib/git-ops.sh              excludes orchestrations/*, .epam, .deepeval, .codegraph
 *   worktree-health-check.sh    excludes ONLY orchestrations/logs/* — KB.md passes through
 *   run-agent-orchestration.sh  Step 9: bare `git add -A` — excludes nothing
 *
 * ...and all three fall back to a bare `git add -A` when the pathspec form fails, which
 * discards every exclusion. Three copies of one rule is how they drift; the fallback is
 * how the rule gets discarded even where it was written down correctly.
 *
 * So this tests ONE shared helper, by EXECUTING it against a real repo containing real
 * engine artefacts. Not by grepping for pathspecs — a pathspec list that is present in
 * the source but bypassed by a fallback greps clean and stages the file anyway.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const GIT_OPS = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const WT_HEALTH = join(REPO_ROOT, 'orchestrations/scripts/worktree-health-check.sh');

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();

/** Everything the ENGINE writes into a client codeline. None of it is client content. */
const ENGINE_ARTEFACTS = [
  'orchestrations/agents/KB.md',
  'orchestrations/agents/profiles.json',
  'orchestrations/logs/agent-activity.jsonl',
  '.epam/settings.json',
  '.deepeval/.deepeval_telemetry.txt',
  '.codegraph/index.json',
  '.contracts/api.json',
];

/** Real client work. Must always be staged. */
const CLIENT_FILES = ['src/hooks/useContent.ts', 'src/hooks/useContent.spec.ts'];

function repoWithEngineJunk() {
  const repo = mkdtempSync(join(tmpdir(), 'stage-'));
  git(repo, 'init', '--quiet', '-b', 'develop');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# client\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'baseline');

  for (const f of [...ENGINE_ARTEFACTS, ...CLIENT_FILES, 'node_modules/pkg/index.js']) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), 'x\n');
  }
  return repo;
}

/** Execute the REAL shared staging helper and return what it actually staged. */
function stagedBy(repo: string) {
  const script = join(mkdtempSync(join(tmpdir(), 'run-')), 'run.sh');
  writeFileSync(
    script,
    [
      'set -uo pipefail',
      'log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }',
      `source ${JSON.stringify(GIT_OPS)}`,
      `git_add_client_outputs ${JSON.stringify(repo)}`,
      'echo "RC=$?"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  return {
    staged: git(repo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean),
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

describe('the shared staging helper never stages engine artefacts', () => {
  let staged: string[];
  let out: string;

  beforeAll(() => {
    const r = stagedBy(repoWithEngineJunk());
    staged = r.staged;
    out = r.out;
  });

  it('stages the client work — or the test proves nothing', () => {
    expect(staged, `helper did not run. Output:\n${out}`).toEqual(
      expect.arrayContaining(CLIENT_FILES),
    );
  });

  it.each(ENGINE_ARTEFACTS)('NEVER stages %s', (artefact) => {
    expect(
      staged,
      `${artefact} is an ENGINE file. Staging it puts the engine's own state into the ` +
        `customer's git history — one commit from being pushed to their remote.`,
    ).not.toContain(artefact);
  });

  it('never stages node_modules', () => {
    expect(staged.filter((f) => f.startsWith('node_modules/'))).toEqual([]);
  });

  it('stages ONLY client work — nothing unexpected slipped through', () => {
    expect(staged.sort()).toEqual([...CLIENT_FILES].sort());
  });
});

/**
 * The fallback is the hole. Every site had `... || git add -A` with no pathspec, so a
 * failure of the exclusion form staged everything the exclusions existed to stop.
 */
describe('no staging path discards the exclusions', () => {
  it('a repo where the pathspec form is unusable still excludes engine artefacts', () => {
    // An empty repo with no commits: `git add -A -- :!...` behaves differently than on a
    // repo with HEAD, which is exactly the condition that drove the original fallback.
    const repo = mkdtempSync(join(tmpdir(), 'stage-nohead-'));
    git(repo, 'init', '--quiet', '-b', 'develop');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    for (const f of ['orchestrations/agents/KB.md', ...CLIENT_FILES]) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), 'x\n');
    }
    const { staged, out } = stagedBy(repo);
    expect(staged, `helper did not run:\n${out}`).toEqual(
      expect.arrayContaining(['src/hooks/useContent.ts']),
    );
    expect(
      staged,
      'the no-HEAD path fell back to a bare `git add -A` and staged the engine KB',
    ).not.toContain('orchestrations/agents/KB.md');
  });
});

/**
 * Wiring: every client-repo staging site must go through the one helper, so the rule
 * cannot be re-implemented three ways again.
 */
describe('every client-repo staging site uses the shared helper', () => {
  const sources: Record<string, string> = {
    'run-agent-orchestration.sh (Step 9)': readFileSync(ORCH, 'utf8'),
    'worktree-health-check.sh': readFileSync(WT_HEALTH, 'utf8'),
  };

  for (const [name, src] of Object.entries(sources)) {
    it(`${name} does not hand-roll its own git add`, () => {
      // A bare `git add -A` against a client repo is the defect; the helper is the fix.
      // Only real invocations: a line that STARTS with the command (optionally via
      // `timeout N`). Comments recording the history, and warn/echo text telling a human
      // how to stage by hand, are not staging call sites.
      const bareAdds = src
        .split('\n')
        .filter((l) => /^\s*(timeout\s+\S+\s+)?git\s+(-C\s+\S+\s+)?add\s+-A/.test(l));
      expect(
        bareAdds,
        `${name} stages a client repo directly. It must call git_add_client_outputs so ` +
          `the engine-artefact exclusions cannot drift between call sites again:\n` +
          bareAdds.join('\n'),
      ).toEqual([]);
      expect(src).toMatch(/git_add_client_outputs/);
    });
  }
});
