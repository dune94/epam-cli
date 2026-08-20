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

const ROOT = join(__dirname, '../../..');
const ORCH = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderEngineTemplate } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

/**
 * THE RENDERED PROMPT, not the script that renders it.
 *
 * This used to slice a heredoc out of run-agent-orchestration.sh between `_lint_finding_prompt=`
 * and `LINT_FIND_EOF`. The prompt has since moved into the template layer, where prompts belong —
 * so the slice returned one line of shell and both assertions went red while the requirement they
 * describe was being met. Rendering the real template with real values tests the artifact the
 * agent actually receives, and survives the prompt moving again.
 */
function lintAnalystPrompt(): string {
  return renderEngineTemplate('lint-finding-analyst', {
    __PHASE__: 'core',
    __LINT_LOG__: 'src/a.spec.ts:100:48  sonarjs/no-duplicate-string',
    __WRITER_OUTPUTS__: 'src/a.ts\nsrc/a.spec.ts',
    __TEST_FILE_CONVENTIONS__: '.spec.ts',
    __ACTIVE_STORIES__: 'AMSD-1820 — technicalNotes.files: src/a.ts',
    __PROFILE__: 'lint-analyst',
  });
}

describe('the prompt really rendered', () => {
  it('is not empty and did not fall through to a stub', () => {
    // Without this every not/toMatch below passes on an empty string.
    expect(lintAnalystPrompt().length).toBeGreaterThan(200);
  });
});

describe('the lint analyst can see the files the run actually wrote', () => {
  it('is given the writer-output manifest', () => {
    expect(lintAnalystPrompt(),
      'the analyst maps findings using declared files only, so a finding in a '
      + 'test file the repro-test-writer created is unmappable')
      .toMatch(/src\/a\.spec\.ts/);
  });

  it('still shows the stories, so a file can be attributed to one', () => {
    expect(lintAnalystPrompt()).toMatch(/AMSD-1820/);
  });

  it('does not rely on technicalNotes.files alone', () => {
    const prompt = lintAnalystPrompt();
    const usesDeclared = /technicalNotes/.test(prompt);
    const usesProduced = /src\/a\.spec\.ts/.test(prompt);
    expect(!usesDeclared || usesProduced,
      'declared files are still the only source of truth for the mapping').toBe(true);
  });

  it('tells the analyst a test file belongs to the story that produced it', () => {
    expect(lintAnalystPrompt(),
      'nothing explains that undeclared files produced by this run are still in scope')
      .toMatch(/produced by this run|written by this run|even if.*not declared/i);
  });

  it('and the caller actually supplies the manifest value', () => {
    // The template declaring __WRITER_OUTPUTS__ proves nothing if no producer fills it.
    const i = ORCH.indexOf('render_engine_prompt lint-finding-analyst');
    expect(i, 'the lint analyst prompt is no longer rendered here').toBeGreaterThan(-1);
    expect(ORCH.slice(Math.max(0, i - 2000), i)).toMatch(/__WRITER_OUTPUTS__/);
  });
});
