/**
 * EXPLORATION BELONGS TO THE INDEX, NOT THE SHELL.
 *
 * Measured live 2026-08-09 on AMSD-2041, with per-tool telemetry finally working. One story:
 *
 *     bash                    164 calls, 261,138 bytes   (56 grep, 45 cat, 21 ls, 16 sed, 10 find)
 *     read_file                60 calls, 344,288 bytes
 *     codegraph_query           1 call,      942 bytes
 *     search                    3 calls,       54 bytes
 *
 * 632 KB pulled into context by tools, for a change that ultimately touched one file. The
 * CodeGraph index was available the whole time — plugin provisioned, .codegraph/codegraph.db
 * present in the codeline, tool permitted, unlimited tool budget — and the writer used it once,
 * then went back to grepping. Its own description already says "instead of grepping", so asking
 * more politely is not a plan.
 *
 * This refuses exploration verbs in bash and names the tool to use instead. Enforcement, not
 * persuasion — the same reasoning the pipeline applies everywhere else: a deterministic check
 * beats an instruction the model may ignore.
 *
 * THREE THINGS IT MUST NOT DO, because over-blocking is worse than the cost it saves:
 *   - break the commands the writer legitimately needs (npm, node, git, tsc, tests)
 *   - block a pipeline whose FIRST command is legitimate — `npm test | grep -c fail` is a test
 *     run, not exploration
 *   - turn on by itself; a direct `epam run` is unaffected until the engine opts in
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BashTool } from '../../../src/tools/builtin/Bash';

const REDIRECT = JSON.stringify({
  grep: 'codegraph_query (mode "explore"/"query") or the search tool',
  find: 'codegraph_query (mode "explore") or list_files',
  cat: 'read_file',
  ls: 'list_files',
  head: 'read_file',
  tail: 'read_file',
  sed: 'read_file, then edit_file for changes',
});

let saved: string | undefined;
beforeEach(() => { saved = process.env.EPAM_BASH_EXPLORATION_REDIRECT; });
afterEach(() => {
  if (saved === undefined) delete process.env.EPAM_BASH_EXPLORATION_REDIRECT;
  else process.env.EPAM_BASH_EXPLORATION_REDIRECT = saved;
});

const run = async (command: string) => new BashTool().execute({ command });

/**
 * Blocked BY THE GUARD — not merely "the command failed".
 *
 * `expect(isError).toBe(true)` cannot tell the two apart: `grep -r foo src/` exits non-zero on
 * its own in a directory without matches, so that assertion passed even with the guard removed.
 * Verified by md5-checked mutation: the check was deleted, the file changed, and 16 tests stayed
 * green. Only the redirect message is unique to the guard.
 */
const BLOCKED = /is not available for exploring this codebase/;

describe('opt-in: nothing changes until the engine turns it on', () => {
  it('grep runs normally with the redirect unset', async () => {
    delete process.env.EPAM_BASH_EXPLORATION_REDIRECT;
    const r = await run('echo hello | grep hello');
    expect(r.isError ?? false).toBe(false);
  });

  it('a malformed redirect map does not block anything', async () => {
    // Fails OPEN, like the KB pre-exec guard beside it: a broken policy must never stop an
    // agent working, and it must never do so silently either.
    process.env.EPAM_BASH_EXPLORATION_REDIRECT = 'not json';
    const r = await run('echo hi');
    expect(r.isError ?? false).toBe(false);
  });
});

describe('THE DEFECT: exploration verbs are refused and redirected', () => {
  beforeEach(() => { process.env.EPAM_BASH_EXPLORATION_REDIRECT = REDIRECT; });

  it('grep is refused BY THE GUARD, not merely by failing', async () => {
    const r = await run('grep -r "livePreview" src/');
    expect(r.isError).toBe(true);
    expect(r.content, 'the command failed on its own; the guard never fired').toMatch(BLOCKED);
  });

  it('and the refusal names the tool to use instead', async () => {
    // A refusal that does not say what to do next just costs a turn.
    const r = await run('grep -r "livePreview" src/');
    expect(r.content).toMatch(/codegraph_query/);
  });

  it.each([
    ['cat src/services/contentstack.ts', /read_file/],
    ['ls src/components', /list_files/],
    ['find . -name "*.tsx"', /codegraph_query|list_files/],
    ['head -n 50 src/a.ts', /read_file/],
    ['sed -n "1,40p" src/a.ts', /read_file/],
  ])('%s is refused with a named alternative', async (cmd, expected) => {
    const r = await run(cmd);
    expect(r.isError).toBe(true);
    expect(r.content, 'not blocked by the guard').toMatch(BLOCKED);
    expect(r.content).toMatch(expected);
  });

  it('leading environment assignments do not smuggle it past the check', async () => {
    const r = await run('LC_ALL=C grep -r foo src/');
    expect(r.content, 'an env prefix bypassed the guard').toMatch(BLOCKED);
  });

  it('an absolute path to the binary is still the same verb', async () => {
    const r = await run('/usr/bin/grep -r foo src/');
    expect(r.content, 'a path prefix bypassed the guard').toMatch(BLOCKED);
  });
});

describe('the work the writer actually has to do still runs', () => {
  beforeEach(() => { process.env.EPAM_BASH_EXPLORATION_REDIRECT = REDIRECT; });

  it.each([
    'echo hello',
    'node --version',
    'git status --porcelain',
  ])('%s is allowed', async (cmd) => {
    const r = await run(cmd);
    expect(r.isError ?? false, `${cmd} was blocked`).toBe(false);
  });

  it('a pipeline whose first command is legitimate is allowed', async () => {
    // `npm test | grep -c fail` is a test run. Blocking on any occurrence of grep would break
    // the writer's real work, which is a worse outcome than the tokens it saves.
    const r = await run('echo "a\nb" | grep -c b');
    expect(r.content ?? '', 'a legitimate pipeline was blocked for containing grep').not.toMatch(BLOCKED);
  });

  it('a verb that merely contains an exploration verb is not blocked', async () => {
    // `catalog`, `grepify`, `finder` — substring matching would refuse all of them.
    const r = await run('echo catalog-find-lsx');
    expect(r.isError ?? false).toBe(false);
  });
});

/**
 * A REDIRECT MUST POINT AT A TOOL THAT CAN ACTUALLY ANSWER.
 *
 * The first version of this guard would have made the measured run WORSE. Of the 330 bash calls,
 * the largest cluster was a dependency, not this repository:
 *
 *     41 cat  node_modules/@contentstack/live-preview-utils/...
 *     16 ls   node_modules/@contentstack/live-preview-utils/
 *     10 find node_modules/@contentstack/...
 *
 * The writer was reading a package's .d.ts files to work out an SDK's API. codegraph_query
 * indexes THIS repository's symbols and cannot answer that, so blocking `cat` and pointing there
 * would have walled the writer off from the only source of the answer it needed — with no
 * working alternative, which is the same shape as the search tool that silently returned nothing
 * and drove it to bash in the first place.
 *
 * resolve_package_symbol and dependency_contract exist for exactly this and were used 7 times
 * against roughly 67 manual pokes.
 *
 * So the redirect is path-aware: a command aimed at a dependency is sent to the dependency
 * tools, everything else to the codebase tools, and anything no tool can answer is ALLOWED. A
 * guard with no valid alternative is just a wall.
 */
describe('the redirect points at a tool that can answer THIS question', () => {
  const CONFIG = JSON.stringify({
    verbs: {
      grep: 'codegraph_query (mode "explore"/"query") or the search tool',
      cat: 'read_file',
      ls: 'list_files',
      find: 'codegraph_query (mode "explore")',
    },
    pathOverrides: [
      { match: 'node_modules', use: 'resolve_package_symbol or dependency_contract' },
    ],
  });
  beforeEach(() => { process.env.EPAM_BASH_EXPLORATION_REDIRECT = CONFIG; });

  it('a dependency path is sent to the dependency tools, NOT codegraph', async () => {
    const r = await run('cat node_modules/@contentstack/live-preview-utils/dist/index.d.ts');
    expect(r.content).toMatch(BLOCKED);
    expect(r.content, 'pointed at an index that does not cover dependencies').toMatch(/resolve_package_symbol/);
    expect(r.content).not.toMatch(/codegraph_query/);
  });

  it('find inside a dependency too', async () => {
    const r = await run('find node_modules/@contentstack -name "*.d.ts"');
    expect(r.content).toMatch(/resolve_package_symbol|dependency_contract/);
  });

  it('the same verb against the repo still goes to the codebase tools', async () => {
    const r = await run('grep -r "livePreview" src/');
    expect(r.content).toMatch(/codegraph_query/);
    expect(r.content).not.toMatch(/resolve_package_symbol/);
  });

  it('a verb no tool covers is ALLOWED, not blocked', async () => {
    // awk is not in the map. Blocking it would leave the agent with no route at all.
    const r = await run('echo x | awk "{print}"');
    expect(r.content ?? '', 'blocked with no alternative offered').not.toMatch(BLOCKED);
  });

  it('the older flat-map config still works', async () => {
    // The first shipped shape was {verb: tool}. A config format change must not silently stop
    // enforcing on a codeline still carrying the old one.
    process.env.EPAM_BASH_EXPLORATION_REDIRECT = JSON.stringify({ grep: 'the search tool' });
    const r = await run('grep -r foo src/');
    expect(r.content).toMatch(BLOCKED);
    expect(r.content).toMatch(/search tool/);
  });
});
