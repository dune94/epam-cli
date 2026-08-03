/**
 * Root-cause analysis injection — carries the code-graph-detective's findings
 * (file + function + WHY it's wrong) into the implementation prompt, so the
 * coding agent starts WITH the answer instead of re-tracing the bug across
 * files. Found live 2026-07-23: a "bad" implementation attempt read 143k
 * tokens re-discovering the cross-file #return ID mismatch and wrote nothing,
 * while the detective had ALREADY traced it — that reason string was being
 * discarded after picking the file. Now it's persisted on story.fixSiteAnalysis
 * (spec-mode-runner) and injected as a "## Root Cause Analysis" section by
 * claude.sh's build_implementation_prompt.
 *
 * Tests the REAL jq extraction from claude.sh against fixture story JSON, plus
 * that the prompt template wires it in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

// Extract the exact jq program claude.sh uses for fix_site_analysis.
function extractJqProgram(): string {
  const marker = 'fix_site_analysis=$(echo "$story_json" | jq -r ';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('fix_site_analysis jq extraction not found');
  const open = src.indexOf("'", start);
  const close = src.indexOf("'", open + 1);
  return src.slice(open + 1, close);
}
const jqProgram = extractJqProgram();

function runJq(storyJson: object): string {
  return execFileSync('jq', ['-r', jqProgram], { input: JSON.stringify(storyJson), encoding: 'utf8' }).trim();
}

describe('fix-site-analysis injection (real jq from claude.sh)', () => {
  it('formats a detective finding into a markdown bullet with file, function, and reason', () => {
    const out = runJq({
      fixSiteAnalysis: [{
        file: 'src/services/submit-reservations/apply-report-discounts.service.ts',
        function: 'applyReportDiscountsService',
        reason: 'return-trip line item IDs carry a #return suffix that discount.lineItemId does not, so return discounts never match',
      }],
    });
    expect(out).toContain('**src/services/submit-reservations/apply-report-discounts.service.ts**');
    expect(out).toContain('`applyReportDiscountsService`');
    expect(out).toContain('#return suffix');
  });

  it('renders the prescribed minimal fix as a sub-bullet when the fix field is present', () => {
    const out = runJq({
      fixSiteAnalysis: [{
        file: 'src/a.ts',
        function: 'match',
        reason: 'the id comparison fails for return dispatches',
        fix: 'change `lineItem.id === discount.lineItemId` to reuse existing parseDispatchLineItemKey(lineItem.id).id from ~/services/helpers/order/dispatch-line-item-key',
      }],
    });
    expect(out).toContain('Minimal fix:');
    expect(out).toContain('parseDispatchLineItemKey');
    expect(out).toContain('~/services/helpers/order/dispatch-line-item-key');
  });

  it('omits the minimal-fix sub-bullet when fix is empty or absent', () => {
    expect(runJq({ fixSiteAnalysis: [{ file: 'src/a.ts', function: '', reason: 'cause', fix: '' }] }))
      .not.toContain('Minimal fix');
    expect(runJq({ fixSiteAnalysis: [{ file: 'src/a.ts', function: '', reason: 'cause' }] }))
      .not.toContain('Minimal fix');
  });

  it('omits the function parens when function is empty', () => {
    const out = runJq({ fixSiteAnalysis: [{ file: 'src/a.ts', function: '', reason: 'the cause' }] });
    expect(out).toBe('- **src/a.ts**: the cause');
    expect(out).not.toContain('()');
    expect(out).not.toContain('``');
  });

  it('produces empty output when there is no fixSiteAnalysis (greenfield / detective found nothing)', () => {
    expect(runJq({})).toBe('');
    expect(runJq({ fixSiteAnalysis: [] })).toBe('');
  });

  it('handles multiple findings, one bullet each', () => {
    const out = runJq({
      fixSiteAnalysis: [
        { file: 'src/a.ts', function: 'fnA', reason: 'cause A' },
        { file: 'src/b.ts', function: '', reason: 'cause B' },
      ],
    });
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
  });

  it('build_implementation_prompt injects the Root Cause Analysis section with the do-not-re-trace directive', () => {
    // The prompt template must reference fix_site_analysis and the header.
    expect(src).toMatch(/\$\(\[ -n "\$fix_site_analysis" \]/);
    expect(src).toContain('Root Cause Analysis & Prescribed Fix (AUTHORITATIVE — start here, do not re-trace)');
  });

  it('frames the injected fix as AUTHORITATIVE over the ACs (ACs = verification, not blueprint)', () => {
    // The live failure: the agent followed 8 splitting-flavored ACs instead of
    // the (vaguer) root cause and built the wrong fix. The section must now
    // explicitly demote the ACs to verification and forbid re-architecting.
    expect(src).toContain('NOT an implementation blueprint');
    expect(src).toMatch(/SMALLEST change/);
    expect(src).toMatch(/Fewer lines of code is always better/);
    expect(src).toMatch(/REUSE existing functions/);
  });

  it('offers the CodeGraph helpers tool to the brownfield implementation agent', () => {
    // The agent must be able to discover an existing helper (e.g. a key parser)
    // instead of hand-rolling new logic — the exact miss in the live failure.
    expect(src).toContain('codegraph_tool_block');
    expect(src).toContain('codegraph_query');
    expect(src).toMatch(/mode=\\"helpers\\"/);
  });
});
