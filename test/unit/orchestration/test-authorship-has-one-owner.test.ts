/**
 * TESTS HAVE ONE OWNER, AND IT IS NOT A ROSTER ROLE.
 *
 * Test authorship is a SEAM: _PERIMETER_AUTHORING_SEAMS="writer,repro-test-writer,lint-fix".
 * brownfield-repro-test-writer.sh takes its own agent turn AFTER the fix commits and owns the
 * bug-reproducing test. Enforcement never moved — the repro-gate still blocks a fix that ships
 * without one. Only authorship did.
 *
 * On AMSD-2041 the roster contradicted that. The minted brief for the implementer said:
 *
 *     "You write Jest tests using ts-jest and jest-environment-jsdom. Test files are colocated
 *      alongside the modules you edit... Use @testing-library/react..."
 *
 * while the writer seam was telling that same agent "Do NOT write, edit, or create any test
 * file". One agent, two contradictory instructions. Two independent causes, both fixed here:
 *
 *   1. the proposal prompt never mentioned test ownership, so nothing stopped a brief from
 *      claiming it — and a brief is inherited whole;
 *   2. the writer's "tests are not your job" block only rendered when a fix site had been
 *      found. With no fix site the writer was never told, and the brief was the only
 *      instruction in play. DET-1 makes "investigated, found nothing" a legitimate state, so
 *      that gap widens rather than closes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the roster is told tests are not its job', () => {
  async function mintPrompt() {
    const dir = mkdtempSync(join(tmpdir(), 'test-owner-')); dirs.push(dir);
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANONICAL' }));
    const capture = join(dir, 'prompt.txt');
    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\n` +
      `cat <<'ANSWER'\n<PROJECT_AGENTS>{"proposedAgents":[]}</PROJECT_AGENTS>\nANSWER\n`);
    chmodSync(sh, 0o755);
    delete process.env.SPEC_MODE_PROVIDER;
    await spec.mintProjectAgents({
      promptExec: { cmd: sh, args: [] },
      tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [], codelines: [{ name: 'alpha', path: '/x/alpha' }],
      profilesPath, agentsDir: dir, logDir: dir, repoPath: dir,
    });
    return existsSync(capture) ? readFileSync(capture, 'utf8') : '';
  }

  it('the proposer is told a dedicated seam owns the tests', async () => {
    const prompt = await mintPrompt();
    expect(prompt.length, 'no prompt reached the proposer — this assertion would be vacuous')
      .toBeGreaterThan(200);
    expect(prompt).toMatch(/test/i);
    expect(
      prompt,
      'nothing tells the proposer who owns tests, so a brief can claim it — and did',
    ).toMatch(/dedicated .*writes the tests|owns the .*test|tests are not/i);
  }, 60_000);

  it('the proposer is told not to propose a test-writing role', async () => {
    const prompt = await mintPrompt();
    expect(prompt).toMatch(/do not propose[^.]*test/i);
  }, 60_000);

  it('the proposer is told a brief must not claim test authorship', async () => {
    // The role NAME is not the only route: a domain engineer whose brief says "you write Jest
    // tests" produces the same contradiction without ever being called a test role.
    const prompt = await mintPrompt();
    expect(prompt).toMatch(/must not (say|claim|state)[^.]*test|do not .* brief[^.]*test/i);
  }, 60_000);
});

describe('the writer is told tests are not its job — REAL execution', () => {
  /**
   * Runs the real block-building snippet out of claude.sh under the given conditions and
   * reports whether the instruction was produced.
   */
  function ownershipBlock(env: Record<string, string>): string {
    const marker = 'local test_ownership_block=""';
    const start = claudeSrc.indexOf(marker);
    expect(start, 'the test-ownership block is gone from claude.sh').toBeGreaterThan(-1);
    // The block now ends at the render-failure guard, not the brownfield `fi`.
    const end = claudeSrc.indexOf('\n    fi', claudeSrc.indexOf('refusing to build a writer prompt', start));
    const snippet = claudeSrc.slice(start, end + 7).replace(/\blocal /g, '');

    const dir = mkdtempSync(join(tmpdir(), 'ownership-')); dirs.push(dir);
    const sh = join(dir, 'run.sh');
    // UPDATED 2026-08-12. The policy is no longer a heredoc here: it is rendered from the
    // project-authority prompt (prompts/test-ownership.json), the same document the REVIEWER
    // renders its own half from. So the harness must supply what the real script has —
    // SCRIPT_DIR, NODE_BIN and the project config dir. Stubbing the render instead would test
    // the caller and not the receiver, which is how the analyst harness hid a dead feature.
    const repo = join(__dirname, '../../../');
    writeFileSync(sh,
      `#!/usr/bin/env bash\nset -u\n`
      + `SCRIPT_DIR=${JSON.stringify(join(repo, 'orchestrations/scripts'))}\n`
      + `NODE_BIN=${JSON.stringify(process.execPath)}\n`
      + `error() { echo "$*" >&2; }\n`
      + `test_ownership_block=""\n`
      + `${snippet}\nprintf '%s' "$test_ownership_block"\n`);
    return execFileSync('bash', [sh], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EPAM_PROJECT_CONFIG_DIR: join(repo, 'orchestrations/projects/metrolinx'),
        ...env,
      },
    });
  }

  it('the block IS produced in brownfield when a fix site was found', () => {
    const out = ownershipBlock({ EPAM_BROWNFIELD: '1', fix_site_analysis: 'a fix site' });
    expect(out, 'the fixture produced nothing — the assertions here would be vacuous').not.toBe('');
    expect(out).toMatch(/Tests are NOT your job/);
  });

  it('THE DEFECT: it is produced in brownfield even with NO fix site', () => {
    // "Investigated and found nothing" is a legitimate DET-1 state. With no fix site the
    // writer used to be told nothing, leaving the roster brief's claim unopposed.
    const out = ownershipBlock({ EPAM_BROWNFIELD: '1', fix_site_analysis: '' });
    expect(
      out,
      'with no fix site the writer is never told tests are not its job, and the brief wins',
    ).toMatch(/Tests are NOT your job/);
  });

  it('it names the file patterns, so "a test file" is not left to interpretation', () => {
    const out = ownershipBlock({ EPAM_BROWNFIELD: '1', fix_site_analysis: '' });
    expect(out).toMatch(/\*\.test\.\*/);
    expect(out).toMatch(/__tests__/);
  });

  it('greenfield is untouched — there is no repro-test-writer turn there', () => {
    expect(ownershipBlock({ EPAM_BROWNFIELD: '0', fix_site_analysis: 'a fix site' })).toBe('');
  });
});

describe('a brief may not assert a vendor API as its own knowledge', () => {
  // 2026-08-03: a brief stated which token key a vendor's API accepts, in the form "use X, NOT
  // Y". Invented, contradicted the installed package's own types, and made a reviewer reject
  // correct work across three codelines. 2026-08-08: a minted brief said "preview_token (not
  // management_token)" and named a concrete API host — same shape, different route, caught by
  // the shipped-config guard in project-facts-attributable.test.ts.
  //
  // A brief is inherited whole and re-checked by nothing, so an invented API detail becomes an
  // instruction. The rule names no vendor and no product: what a repo declares is verifiable,
  // what a remote API accepts is not.
  async function mintPrompt() {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-claim-')); dirs.push(dir);
    const profilesPath = join(dir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ 'canonical-agent': 'CANONICAL' }));
    const capture = join(dir, 'prompt.txt');
    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      `#!/usr/bin/env bash\ncat > ${JSON.stringify(capture)}\n` +
      `cat <<'ANSWER'\n<PROJECT_AGENTS>{"proposedAgents":[]}</PROJECT_AGENTS>\nANSWER\n`);
    chmodSync(sh, 0o755);
    delete process.env.SPEC_MODE_PROVIDER;
    await spec.mintProjectAgents({
      promptExec: { cmd: sh, args: [] },
      tickets: [{ id: 'T-1', title: 't', description: 'd' }],
      referencedDocs: [], codelines: [{ name: 'alpha', path: '/x/alpha' }],
      profilesPath, agentsDir: dir, logDir: dir, repoPath: dir,
    });
    return existsSync(capture) ? readFileSync(capture, 'utf8') : '';
  }

  it('the proposer is told repository facts are statable and API facts are not', async () => {
    const prompt = await mintPrompt();
    expect(prompt.length, 'no prompt reached the proposer').toBeGreaterThan(200);
    expect(prompt).toMatch(/repository (contains|declares)/i);
    expect(prompt).toMatch(/may NOT state as your own knowledge/i);
  }, 60_000);

  it('the "X is right, Y is wrong" shape is forbidden by name', async () => {
    const prompt = await mintPrompt();
    expect(
      prompt,
      'nothing forbids the exact shape that got correct work rejected across three codelines',
    ).toMatch(/one API key, field or option is correct and another is wrong/i);
  }, 60_000);

  it('a documented claim is allowed when attributed, not banned outright', async () => {
    // Banning vendor facts entirely would throw away the fetched documents, which are the
    // whole reason those documents are fetched.
    const prompt = await mintPrompt();
    expect(prompt).toMatch(/attribute it/i);
  }, 60_000);

  it('the rule names no vendor, product or package — it is a rule about evidence', async () => {
    const prompt = await mintPrompt();
    const start = prompt.indexOf('WHAT YOU MAY STATE AS FACT');
    const rule = prompt.slice(start, start + 1200);
    expect(start, 'the rule is missing entirely').toBeGreaterThan(-1);
    expect(rule).not.toMatch(/contentstack|next\.?js|jest|react/i);
  }, 60_000);
});

describe('the seam list is the authority on who may author', () => {
  it('repro-test-writer is an authoring seam, not a roster role', () => {
    const perimeter = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/lib/codeline-write-perimeter.sh'), 'utf8');
    expect(perimeter).toMatch(/_PERIMETER_AUTHORING_SEAMS="[^"]*repro-test-writer/);
  });
});
