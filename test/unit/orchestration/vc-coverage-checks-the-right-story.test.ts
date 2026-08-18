/**
 * STEP 3.56 REPORTS WHETHER A STORY'S TEST COVERS THE CRITERIA IT WAS ACCEPTED AGAINST.
 * IT WAS REPORTING THAT AGAINST SOMEBODY ELSE'S TEST.
 *
 * `story_outputs_tests` reads the PHASE manifest — a flat file list with no story attribution at
 * all. The step looped over stories and took `| head -1`, so every story in the phase was checked
 * against the FIRST test file anybody wrote. Story B's verification criteria were measured against
 * story A's test.
 *
 * That is the worst shape a check can have: it runs, it costs, it produces a plausible artefact
 * with the right story id on it, and the artefact is wrong. The repro gate cannot catch it either
 * — it only asks whether a test fails before the fix and passes after, never which criteria the
 * test actually covers.
 *
 * The attribution that does exist is the story's own commit: commit_completed_story writes
 * "<story_id>: story complete (N file(s))" and keeps that marker stable so it can be grepped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/story-outputs.sh');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');

const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'vc-cov-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});

/** Two stories, each committing its own spec, in the real commit shape. */
function repoWithTwoStories(): string {
  const dir = join(work, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
  writeFileSync(join(dir, 'src', 'alpha.spec.ts'), 'alpha\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'STORY-1: story complete (1 file(s))');
  writeFileSync(join(dir, 'src', 'beta.spec.ts'), 'beta\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'STORY-2: story complete (1 file(s))');
  return dir;
}

/** Ask the resolver, exactly as the step does. */
function testsFor(repo: string, story: string): string[] {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; story_outputs_tests_for ${JSON.stringify(repo)} "" ${JSON.stringify(story)}`,
  ], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean);
}

describe('vc coverage checks the right story', () => {
  it('each story resolves to its OWN test file', () => {
    const dir = repoWithTwoStories();
    expect(testsFor(dir, 'STORY-1'), 'story 1 did not resolve its own test').toEqual(['src/alpha.spec.ts']);
    expect(testsFor(dir, 'STORY-2'), 'story 2 was given story 1’s test').toEqual(['src/beta.spec.ts']);
  });

  it('a story that committed nothing resolves nothing, rather than borrowing another story’s test', () => {
    // "No test" must stay distinguishable from "covered". Inheriting the first file in the phase
    // is what made those two look identical.
    expect(testsFor(repoWithTwoStories(), 'STORY-99')).toEqual([]);
  });

  it('recognises test conventions other than one', () => {
    // The phase manifest's regex is deliberately broad because metrolinx's tests are .spec.ts;
    // the per-story resolver has to share it, not re-derive a narrower one.
    const dir = join(work, 'conv');
    mkdirSync(join(dir, 'tests'), { recursive: true });
    mkdirSync(join(dir, 'src', '__tests__'), { recursive: true });
    spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
    writeFileSync(join(dir, 'tests', 'test_fare.py'), 'x\n');
    writeFileSync(join(dir, 'src', '__tests__', 'fare.js'), 'x\n');
    writeFileSync(join(dir, 'src', 'impl.ts'), 'x\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'S-1: story complete (3 file(s))');

    const found = testsFor(dir, 'S-1');
    expect(found, 'a test_*.py file was not recognised').toContain('tests/test_fare.py');
    expect(found, 'a __tests__/ file was not recognised').toContain('src/__tests__/fare.js');
    expect(found, 'an implementation file was counted as a test').not.toContain('src/impl.ts');
  });

  it('the step asks per story, not for the phase’s first file', () => {
    const body = code(ORCH);
    const i = body.indexOf('_vc_test_file=');
    expect(i, 'the vc-coverage step is gone').toBeGreaterThan(-1);
    const line = body.slice(i, body.indexOf('\n', i));
    expect(line, 'the step still takes the phase manifest’s first test file')
      .toMatch(/story_outputs_tests_for/);
    expect(line, 'the story is not passed to the resolver').toMatch(/\$_vc_story/);
  });

  it('the not_checked artefact is written loudly, because absence must never be interpreted', () => {
    // The step's own comment says silence is not a state — and then wrote the artefact under
    // `2>/dev/null || true`, so it could vanish silently and restore the ambiguity.
    const body = code(ORCH);
    const i = body.indexOf('not_checked');
    expect(i, 'the not_checked record is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 300, i + 600);
    expect(block, 'the artefact write is still silenced').not.toMatch(/vc-coverage-\$\{_vc_story\}\.json" 2>\/dev\/null \|\| true/);
    expect(block, 'a failed write produces no message').toMatch(/warning/);
  });
});
