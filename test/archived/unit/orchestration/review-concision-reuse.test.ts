/**
 * team-lead-review.sh — root-cause-aware, concision/reuse-enforcing review.
 *
 * Live failure it addresses (2026-07-23, AMSD-1820): the reviewer approved an
 * over-engineered wrong fix because it only checked "does the diff satisfy the
 * AC wording." The AC wording itself misdirected (it described per-segment
 * splitting). The reviewer now receives the SAME root-cause analysis + prescribed
 * minimal fix the implementer got, and is instructed to reject (blocker) when the
 * change misses the root cause, when a more concise change would do, or when it
 * hand-rolls logic an existing helper already provides. It is also given the
 * read-only CodeGraph tool to verify helper existence.
 *
 * Real jq extraction against fixture PRD + source-contract assertions on the
 * prompt and the tool-enabling env.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REVIEW_SH = join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh');
const src = readFileSync(REVIEW_SH, 'utf8');
// PROMPT TEXT moved to a document (2026-08-13); SCRIPT BEHAVIOUR (variable names, tool
// enablement, block construction) stayed. Each assertion below now reads whichever artefact
// actually carries the thing it is about.
const PROMPT: string = JSON.parse(
  readFileSync(join(__dirname, '../../../orchestrations/prompts/templates/team-lead-review.json'), 'utf8'),
).body;

// Pull out the exact jq program used for STORY_FIX_ANALYSIS and run it for real.
function extractFixAnalysisJq(): string {
  const marker = 'STORY_FIX_ANALYSIS=$(jq -r --arg id "$story_id" ';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('STORY_FIX_ANALYSIS jq not found');
  const open = src.indexOf("'", start);
  const close = src.indexOf("'", open + 1);
  return src.slice(open + 1, close);
}
const fixJq = extractFixAnalysisJq();

function runFixJq(prd: object, id: string): string {
  return execFileSync('jq', ['-r', '--arg', 'id', id, fixJq], {
    input: JSON.stringify(prd),
    encoding: 'utf8',
  }).trim();
}

describe('team-lead-review — fix-analysis injection (real jq)', () => {
  it('extracts the story fixSiteAnalysis with reason and prescribed minimal fix', () => {
    const out = runFixJq({
      stories: [{
        id: 'AMSD-1820',
        fixSiteAnalysis: [{
          file: 'src/apply-report-discounts.service.ts',
          function: 'applyReportDiscountsService',
          reason: 'return dispatch id has a #return suffix so the discount match fails',
          fix: 'reuse existing parseDispatchLineItemKey to strip the suffix before comparing',
        }],
      }],
    }, 'AMSD-1820');
    expect(out).toContain('src/apply-report-discounts.service.ts');
    expect(out).toContain('#return suffix');
    expect(out).toContain('Prescribed minimal fix:');
    expect(out).toContain('parseDispatchLineItemKey');
  });

  it('yields empty output for a story with no fixSiteAnalysis (greenfield)', () => {
    expect(runFixJq({ stories: [{ id: 'X' }] }, 'X')).toBe('');
  });
});

describe('team-lead-review — concision/reuse rejection directives', () => {
  it('injects the root-cause analysis and demotes ACs to verification', () => {
    expect(src).toContain('STORY_FIX_ANALYSIS');
    expect(src).toContain('ROOT CAUSE ANALYSIS & PRESCRIBED MINIMAL FIX');
    // This phrase is inside the caller-computed __FIX_ANALYSIS_BLOCK__, which the script still
    // builds — so it is asserted against the script, alongside the two lines above it.
    expect(src).toMatch(/NOT a blueprint/);
  });

  it('instructs the reviewer to reject a fix that misses the root cause', () => {
    expect(PROMPT).toMatch(/NOT the prescribed root cause.*blocker/is);
  });

  it('instructs the reviewer to reject when a more concise change would do', () => {
    expect(PROMPT).toMatch(/MORE CONCISE change \(fewer lines\)/);
    expect(PROMPT).toMatch(/Fewer lines of code is always better/);
  });

  it('instructs the reviewer to reject hand-rolled logic an existing helper provides', () => {
    expect(PROMPT).toMatch(/hand-rolls logic that an EXISTING function\/helper already provides/);
    expect(PROMPT).toMatch(/name the helper to reuse/);
  });

  it('does not let AC-satisfaction alone justify approval of an over-engineered fix', () => {
    expect(PROMPT).toMatch(/Do NOT approve an over-engineered fix/);
  });
});

describe('team-lead-review — CodeGraph tool access', () => {
  it('advertises the helpers/query tool only when the binary exists', () => {
    expect(src).toContain('_review_codegraph_tool');
    expect(src).toContain('command -v codegraph');
    expect(src).toContain('codegraph-agent-query.sh');
  });

  it('enables the Bash tool for the reviewer so it can actually run the query', () => {
    expect(src).toContain('AI_GATE_ALLOW_TOOLS=1');
    // PROJECT_ROOT must be forwarded so the tool targets the repo under review.
    expect(src).toMatch(/PROJECT_ROOT="\$PROJECT_ROOT"/);
  });
});
