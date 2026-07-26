/**
 * The lint analyst must map a finding using what the run PRODUCED, not what it
 * DECLARED.
 *
 * Live metrolinx 2026-07-26, run 7. Everything upstream worked — grounded
 * diagnosis, correct fix using the prescribed helper, a test proven RED→GREEN,
 * review approved — and the lint gate then did its job properly for the first
 * time, finding one real issue in a file this run had written:
 *
 *   apply-report-discounts.service.spec.ts:100:48
 *     sonarjs/no-duplicate-string — Define a constant instead of duplicating…
 *
 * And the remediation could not act on it:
 *
 *   [lint-gate:analyst] Could not map lint failure to a story — skipping AC remediation
 *   [ERROR] Step 20: Lint gate FAILED — fix errors before review proceeds
 *
 * The analyst is given each story's `technicalNotes.files`. For AMSD-1820 that
 * listed five SOURCE candidates and not the .spec.ts, because the reproducing
 * test is written later by a different agent and never declared. So the file
 * that actually contains the finding was invisible to the mapping.
 *
 * This is the same lesson as the lint gate itself, one layer up, and the third
 * time today that "declared files" has proved weaker than "what the run
 * produced": the manifest already contained this exact file — the gate had just
 * logged `scope: 2 file(s) from writer output manifest` moments earlier.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

/** The gate-finding-analyst prompt for the LINT gate. */
function lintAnalystPrompt(): string {
  const start = ORCH.indexOf('_lint_finding_prompt=');
  expect(start, 'lint analyst prompt not found').toBeGreaterThan(-1);
  // The FIRST 'LINT_FIND_EOF' is the heredoc opener on the anchor line itself;
  // the prompt body ends at the CLOSING delimiter.
  const opener = ORCH.indexOf('LINT_FIND_EOF', start);
  const end = ORCH.indexOf('LINT_FIND_EOF', opener + 1);
  return ORCH.slice(start, end > start ? end : start + 4000);
}

describe('the lint analyst can see the files the run actually wrote', () => {
  it('is given the writer-output manifest', () => {
    expect(lintAnalystPrompt(),
      'the analyst maps findings using declared files only, so a finding in a ' +
      'test file the repro-test-writer created is unmappable')
      .toMatch(/story_outputs_files|writer output|story-outputs/);
  });

  it('still shows the stories, so a file can be attributed to one', () => {
    // The manifest says WHICH files; the stories say WHOSE they are. Both needed.
    expect(lintAnalystPrompt()).toMatch(/PRD Stories|stories/i);
  });

  it('does not rely on technicalNotes.files alone', () => {
    const prompt = lintAnalystPrompt();
    const usesDeclared = /technicalNotes/.test(prompt);
    const usesProduced = /story_outputs_files|story-outputs/.test(prompt);
    expect(!usesDeclared || usesProduced,
      'declared files are still the only source of truth for the mapping')
      .toBe(true);
  });

  it('tells the analyst a test file belongs to the story that produced it', () => {
    // Otherwise it sees an undeclared .spec.ts and reasonably concludes "not mine".
    expect(lintAnalystPrompt(),
      'nothing explains that undeclared files produced by this run are still in scope')
      .toMatch(/produced by this run|written by this run|even if.*not declared/i);
  });
});
