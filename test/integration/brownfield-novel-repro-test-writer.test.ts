/**
 * INTEGRATION: the restored test-writing pass, end to end, for a NOVEL brownfield story.
 *
 * The selector fix (lib/story-guards.sh, phase_stories_brownfield_scope) puts novel
 * stories back in front of the Step 3.54 test writer. This proves the writer actually
 * DOES something useful when it gets one — the drift restoration is only real if the
 * pass produces and commits a test.
 *
 * Runs the REAL brownfield-repro-test-writer.sh against a REAL temp git repo, with the
 * only external dependency — the write-capable agent — stubbed at its own documented
 * seam (AI_RUNNER_CMD). The stub captures the prompt it was handed, which is what lets
 * this assert the SECOND half of the fix: the prompt this script sends is written for a
 * bug ("write ONE bug-reproducing test… it must FAIL against the pre-fix code"). A novel
 * story has no pre-fix failing behaviour, so sending it that prompt asks for something
 * impossible — the same class of error as gating it on RED→GREEN, one step earlier.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../helpers/project-prompts';

const REPO_ROOT = join(__dirname, '../../');
const WRITER = join(REPO_ROOT, 'orchestrations/scripts/brownfield-repro-test-writer.sh');

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * A brownfield repo mid-story: a fix is committed on top of the `develop` baseline,
 * and no test accompanies it — exactly the state Step 3.54 exists to repair.
 */
function fixture(storyKind: string) {
  const root = mkdtempSync(join(tmpdir(), 'rtw-'));
  const repo = join(root, 'client');
  const logDir = join(root, 'logs');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(logDir, { recursive: true });

  git(root, 'init', '--quiet', '-b', 'develop', 'client');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');

  // Baseline: the source file, plus an existing spec so the writer can detect the
  // repo's convention (.spec.ts) and mirror its style.
  writeFileSync(join(repo, 'src/contentstack.ts'), 'export const options = { host: "cdn" };\n');
  writeFileSync(
    join(repo, 'src/existing.spec.ts'),
    "import { describe, it, expect } from 'vitest';\ndescribe('existing', () => { it('holds', () => { expect(true).toBe(true); }); });\n",
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'baseline');
  // A real run captures the pre-story SHA here; story_outputs_record falls back to
  // origin/<baseline>, which does not exist in a repo with no remote — without this
  // the manifest silently never gets written and the assertion below is vacuous.
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), `${git(repo, 'rev-parse', 'HEAD')}\n`);

  // The story's fix, committed, with NO test alongside it.
  git(repo, 'checkout', '--quiet', '-b', 'feature');
  writeFileSync(
    join(repo, 'src/contentstack.ts'),
    'export const options = { host: "cdn", live_preview: { enable: true, host: "" } };\n',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'AMSD-2041: enable live preview');

  const prd = join(root, 'prd.json');
  writeFileSync(
    prd,
    JSON.stringify(
      {
        implementationOrder: { core: ['AMSD-2041'] },
        stories: [
          {
            id: 'AMSD-2041',
            storyKind,
            status: 'pending',
            verificationCriteria: [
              'The Stack options include live_preview with enable true and a host',
              'Published content still renders when no preview parameters are present',
            ],
          },
        ],
      },
      null,
      2,
    ),
  );

  // The agent seam. Captures the prompt, then writes the file the prompt names.
  const promptCapture = join(root, 'prompt.txt');
  const stub = join(root, 'stub-runner.sh');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'cat > "$PROMPT_CAPTURE"',
      // Parse the path from the prompt's own hard requirement — this doubles as
      // proof that the contract line is present and unambiguous.
      `target=$(sed -n 's/^1\\. Write the test to EXACTLY this path[^:]*: //p' "$PROMPT_CAPTURE" | head -1)`,
      '[ -n "$target" ] || { echo "STUB: no target path in prompt" >&2; exit 1; }',
      'mkdir -p "$(dirname "$target")"',
      "cat > \"$target\" <<'EOF'",
      "import { describe, it, expect } from 'vitest';",
      "import { options } from './contentstack';",
      "describe('live preview', () => {",
      "  it('configures live_preview', () => {",
      '    expect(options.live_preview).toEqual({ enable: true, host: expect.any(String) });',
      '  });',
      '});',
      'EOF',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);

  return { root, repo, logDir, prd, promptCapture, stub };
}

function runWriter(f: ReturnType<typeof fixture>) {
  return spawnSync('bash', [WRITER, 'AMSD-2041'], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(),
      EPAM_BROWNFIELD: '1',
      PROJECT_ROOT: f.repo,
      PRD_FILE: f.prd,
      LOG_DIR: f.logDir,
      JIRA_BASELINE_BRANCH: 'develop',
      AI_RUNNER_CMD: f.stub,
      PROMPT_CAPTURE: f.promptCapture,
      REPRO_TEST_WRITER_MAX_ATTEMPTS: '1',
    },
  });
}

describe('a novel brownfield story gets a test written and committed', () => {
  const f = fixture('novel');
  let out = '';

  beforeAll(() => {
    const r = runWriter(f);
    out = `${r.stdout || ''}${r.stderr || ''}`;
  });

  it('the writer actually invoked the agent — the harness is not vacuous', () => {
    expect(
      existsSync(f.promptCapture),
      `the runner was never called, so every assertion below would pass without proving ` +
        `anything. Writer output:\n${out}`,
    ).toBe(true);
    expect(readFileSync(f.promptCapture, 'utf8').length).toBeGreaterThan(200);
  });

  it('the test file is written to the repo convention (.spec.ts, beside the fix)', () => {
    expect(existsSync(join(f.repo, 'src/contentstack.spec.ts'))).toBe(true);
  });

  it('the test is COMMITTED — an uncommitted test is invisible to every later gate', () => {
    const files = git(f.repo, 'log', '-1', '--name-only', '--pretty=format:');
    expect(files).toContain('src/contentstack.spec.ts');
    expect(
      git(f.repo, 'log', '-1', '--pretty=format:%s'),
      'commitlint on these codelines requires the ticket ID as the FIRST token',
    ).toMatch(/^AMSD-2041/);
  });

  it('the test is recorded in the writer output manifest', () => {
    // The manifest is what the phase gates judge. Live metrolinx 2026-07-26: the
    // mutant-hunter reads its tests from it, found none, every mutant survived, and
    // it scored 0 on a run whose test the repro gate had just proven good.
    const manifest = join(f.logDir, 'story-outputs-core.txt');
    expect(existsSync(manifest), `no manifest written. Writer output:\n${out}`).toBe(true);
    expect(readFileSync(manifest, 'utf8')).toContain('contentstack.spec.ts');
  });

  it('THE PROMPT FITS THE STORY: it asks for proof of the VCs, not for a bug repro', () => {
    const prompt = readFileSync(f.promptCapture, 'utf8');
    expect(
      prompt,
      'the story\'s verification criteria are the only definition of "done" a novel ' +
        'story has — the test must be aimed at them',
    ).toContain('The Stack options include live_preview');
    // Not a blanket ban on the word — telling the agent there is NO failure to
    // reproduce is exactly right. What must be absent is the INSTRUCTION to write a
    // reproduction, which a novel story cannot satisfy: the same impossible demand
    // fe5d6cb removed from the gate one step later.
    for (const demand of [/REPRODUCE the bug/, /FAIL against the pre-fix code/, /bug-reproducing test/]) {
      expect(prompt, `the defect-only instruction ${demand} reached a novel story`).not.toMatch(
        demand,
      );
    }
    expect(
      prompt,
      'and it must say so positively, or the agent falls back on its own assumption',
    ).toMatch(/no pre-fix failure to reproduce/);
  });
});

describe('a defect is unchanged — it still gets the bug-reproduction prompt', () => {
  const f = fixture('defect');
  let out = '';

  beforeAll(() => {
    const r = runWriter(f);
    out = `${r.stdout || ''}${r.stderr || ''}`;
  });

  it('the agent was invoked', () => {
    expect(existsSync(f.promptCapture), `writer output:\n${out}`).toBe(true);
  });

  it('the prompt still demands a test that reproduces the bug and fails pre-fix', () => {
    const prompt = readFileSync(f.promptCapture, 'utf8');
    expect(
      prompt,
      'RED→GREEN against a real fix diff is the stronger proof for a defect and must not ' +
        'be weakened by the novel branch',
    ).toMatch(/REPRODUCE the bug/);
    expect(prompt).toMatch(/FAIL against the pre-fix code/);
  });

  it('and it still writes and commits the test', () => {
    expect(existsSync(join(f.repo, 'src/contentstack.spec.ts'))).toBe(true);
    expect(git(f.repo, 'log', '-1', '--name-only', '--pretty=format:')).toContain(
      'src/contentstack.spec.ts',
    );
  });
});
