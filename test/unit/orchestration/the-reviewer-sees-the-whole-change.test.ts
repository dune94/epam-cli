/**
 * A REVIEWER THAT CANNOT SEE HALF THE CHANGE IS NOT REVIEWING IT.
 *
 * team-lead-review.sh scoped the diff it feeds the reviewer by PATHSPEC, to the story's declared
 * files:
 *
 *     _diff_full=$(git diff "$_rev_base" HEAD -- $(echo "$STORY_FILES $_test_files"))
 *
 * STORY_FILES is technicalNotes.files. Anything the writer touches that nobody predicted is
 * therefore absent from the reviewer's input, and the reviewer returns a verdict on a partial
 * change without any indication it saw a partial change.
 *
 * This has already happened once in this exact function. Its own comment records it:
 *
 *     "Also review the story's TEST files ... They live at co-located paths NOT in
 *      technicalNotes.files, so scoping to STORY_FILES alone never showed them to the reviewer —
 *      the test got only the repro-gate's reproduction check, never the reviewer's QUALITY
 *      judgment."
 *
 * That was patched by bolting test files onto the pathspec — which fixes one category and leaves
 * the rule intact. A third category now exists: the scope guard permits a write to a file no
 * other story owns, because the declared manifest is produced by a model, propagates
 * non-deterministically (claude.sh records this), and has no per-codeline data to be correct
 * against three repositories. Live 2026-08-10 the feature needed a type added to a file the
 * ticket never declared. Under the pathspec rule, that file would be committed, recorded in the
 * story-output manifest, linted — and invisible to the reviewer.
 *
 * THE PATHSPEC IS REDUNDANT, NOT MERELY INCOMPLETE. It exists to keep unrelated upstream commits
 * out of the diff, from when the base was HEAD~5. The base is now phase-baseline-sha.txt — the
 * story branch's own base — and the function's own comment states the consequence: "So the diff
 * contains ONLY the story's changes." Once that is true, filtering by filename can only ever
 * remove the story's own work. Extending the list again would fix this category and wait for the
 * fourth.
 *
 * NO STACK FACTS. Nothing here or in the fix names a file, extension, directory or language.
 * Engine-owned paths are excluded through the single existing definition rather than a new list.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const REVIEW_SH = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (repo: string, args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

/**
 * A repo with a baseline commit and a story commit that touches three kinds of file:
 * one declared, one test, and one the manifest never mentioned.
 */
function repoWithStoryChange() {
  const dir = mkdtempSync(join(tmpdir(), 'review-')); dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.epam'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);

  for (const f of ['src/declared.x', 'src/undeclared.x', 'src/thing.test.x']) {
    writeFileSync(join(dir, f), 'baseline\n');
  }
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'baseline']);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();

  writeFileSync(join(dir, 'src/declared.x'), 'baseline\nDECLARED_EDIT\n');
  writeFileSync(join(dir, 'src/undeclared.x'), 'baseline\nUNDECLARED_EDIT\n');
  writeFileSync(join(dir, 'src/thing.test.x'), 'baseline\nTEST_EDIT\n');
  writeFileSync(join(dir, '.epam/settings.json'), '{"engine":"owned"}\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'story']);

  return { dir, base };
}

/** Run the reviewer's real diff-construction block against the fixture. */
function reviewerDiff(): string {
  const { dir, base } = repoWithStoryChange();
  const src = readFileSync(REVIEW_SH, 'utf8');
  const start = src.indexOf('    STORY_DIFF=""');
  const end = src.indexOf('if [ -n "$_diff_full" ]', start);
  if (start === -1 || end === -1) throw new Error('reviewer diff anchors not found — extraction stale');
  const block = src.slice(start, end);

  const logDir = join(dir, 'logs'); mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), base);

  const script = `
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(dir)}
LOG_DIR=${JSON.stringify(logDir)}
JIRA_BASELINE_BRANCH=main
STORY_FILES="src/declared.x"
engine_paths_filter() { grep -v -E '^(\\.codegraph/|\\.epam/)' || true; }
warning() { :; }
log() { :; }
${block}
fi
printf '%s' "\${_diff_full:-}"
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('the extraction is live', () => {
  it('the diff block can be lifted and produces something', () => {
    expect(reviewerDiff().length, 'the reviewer received an empty diff — every assertion below ' +
      'would pass vacuously').toBeGreaterThan(0);
  });
});

describe('the reviewer receives the whole change', () => {
  // Lazily, so a harness failure surfaces as a failing test rather than an uncollectable suite.
  let _diff: string | null = null;
  const diff = () => (_diff ??= reviewerDiff());

  it('the declared file is included, as before', () => {
    expect(diff()).toContain('DECLARED_EDIT');
  });

  it('the TEST file is included — the category patched in last time', () => {
    expect(diff()).toContain('TEST_EDIT');
  });

  it('a file the manifest never declared is INCLUDED', () => {
    expect(
      diff(),
      'the reviewer judged a change while blind to part of it — a file the writer was permitted ' +
      'to add, committed and linted, never reached the reviewer',
    ).toContain('UNDECLARED_EDIT');
  });

  it('engine-owned paths are still excluded', () => {
    // The reviewer must not spend its budget on the pipeline's own state files.
    expect(diff(), 'engine state leaked into the review diff').not.toContain('"engine":"owned"');
  });
});

describe('the rule is scope-by-baseline, not scope-by-list', () => {
  it('the diff is no longer filtered by the declared file list', () => {
    const src = readFileSync(REVIEW_SH, 'utf8');
    const start = src.indexOf('    STORY_DIFF=""');
    const block = src.slice(start, src.indexOf('if [ -n "$_diff_full" ]', start))
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(
      block,
      'the pathspec is still present — extending it covers today\'s category and waits for the next',
    ).not.toMatch(/diff\s+"\$_rev_base"\s+HEAD\s+--\s+\$\(echo/);
  });
});
