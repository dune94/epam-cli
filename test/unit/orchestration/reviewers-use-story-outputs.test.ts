/**
 * The reviewers read the writers' output from one place.
 *
 * Step 20's lint gate was fixed by handing it what this run produced instead of
 * letting it rediscover scope. The three reviewers each inferred it separately:
 *
 *   team-lead-review.sh   git diff --name-only $BASELINE_SHA HEAD
 *   review-ranger         git diff --name-only <baseline>..HEAD
 *   mutant-hunter         git diff --name-only <baseline>..HEAD -- '*.ts'
 *
 * Three copies of one idea drift, and had. lib/story-outputs.sh is now the
 * single reader; the per-caller diffs survive only as fallbacks. The behaviour
 * itself is pinned in story-outputs-lib.test.ts — what is pinned HERE is that
 * each caller is actually wired to it, because a shared library nobody calls
 * fixes nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const orchSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
const teamLeadSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh'), 'utf8');
const claudeSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');

/** The review-ranger / mutant-hunter regions of the orchestration script. */
function block(marker: string, endMarker: string): string {
  const start = orchSrc.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = orchSrc.indexOf(endMarker, start);
  return orchSrc.slice(start, end > start ? end : start + 6000);
}

describe('every reviewer reads the shared writer-output source', () => {
  it('team-lead-review resolves scope through the library', () => {
    expect(teamLeadSrc, 'team-lead-review.sh does not source lib/story-outputs.sh')
      .toContain('lib/story-outputs.sh');
    expect(teamLeadSrc, 'the per-story scope is still computed only from a commit-to-commit diff')
      .toMatch(/_story_changed=\$\(story_outputs_files/);
  });

  it('review-ranger resolves scope through the library', () => {
    const ranger = block('You are acting as the review-ranger agent', 'mutant-hunter');
    const pre = orchSrc.slice(orchSrc.indexOf('_diff_files='), orchSrc.indexOf('You are acting as the review-ranger agent'));
    expect(pre + ranger, 'review-ranger still infers its own scope').toContain('story_outputs_files');
  });

  it('mutant-hunter judges THIS RUN\'S tests, not arbitrary ones from the tree', () => {
    const mutant = block('# Use the same pre-story baseline SHA as review-ranger', 'You are acting as the mutant-hunter agent');
    expect(mutant, 'mutant-hunter still derives changed sources on its own').toContain('story_outputs_sources');
    expect(mutant, 'mutant-hunter still picks test files off the whole tree').toContain('story_outputs_tests');
  });

  it('mutant-hunter can see a .spec.ts test at all', () => {
    // It looked only for `*.test.ts`. The live metrolinx codeline names every
    // test `.spec.ts`, so the oracle reported "(no test files found)" on a run
    // that had just produced a reproducing spec — it judged the change against
    // no tests whatsoever.
    const mutant = block('# Use the same pre-story baseline SHA as review-ranger', 'You are acting as the mutant-hunter agent');
    const findFallback = mutant.match(/find "\$PROJECT_ROOT"[^\n]*\n?[^\n]*/);
    expect(findFallback, 'no test-file discovery found at all').not.toBeNull();
    expect(findFallback![0], 'the fallback still matches only *.test.ts').toContain('spec.ts');
  });

  it('the producers and the readers agree on the manifest path', () => {
    // A producer writing story-outputs-<phase>.txt and a reader looking
    // elsewhere would degrade to the fallback forever, silently.
    //
    // Both producers now delegate to lib/story-outputs.sh rather than carrying
    // their own copy of the path: the story loop records at deliverable
    // verification, and the repro-test-writer records after committing its test
    // — a second copy is exactly how the test file came to be missing from the
    // manifest, which scored mutant-hunter 0 on a good run.
    const lib = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/story-outputs.sh'), 'utf8');
    expect(lib).toContain('story-outputs-${PHASE:-core}.txt');
    const gate = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/eslint-baseline-gate.sh'), 'utf8');
    expect(gate).toContain('story-outputs-${PHASE:-core}.txt');

    for (const producer of ['orchestrations/scripts/claude.sh',
                            'orchestrations/scripts/brownfield-repro-test-writer.sh']) {
      const src = readFileSync(join(REPO_ROOT, producer), 'utf8');
      expect(src, `${producer} neither delegates to the lib nor names the manifest`)
        .toMatch(/story_outputs_record|story-outputs-\$\{PHASE:-core\}\.txt/);
    }
  });
});
