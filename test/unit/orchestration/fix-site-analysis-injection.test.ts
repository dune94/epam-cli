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
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { renderWriterPrompt, cleanupWriterPromptFixtures } from '../../helpers/writer-prompt';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

/*
 * RE-POINTED 2026-08-13. This file used to lift the jq program out of claude.sh and run it. The
 * rendering has since moved to its PRODUCER — lib/producers/fix-plan.js — because two consumers
 * were each rendering the detective's answer their own way and had drifted apart. The assertions
 * below are unchanged: they are about what the writer is told, which is the thing that matters,
 * and they now run against the renderer that actually produces it.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderFixPlan } = require(join(__dirname, '../../../orchestrations/scripts/lib/producers/fix-plan.js'));

function runJq(storyJson: any): string {
  return renderFixPlan(storyJson && storyJson.fixSiteAnalysis).trim();
}

afterAll(cleanupWriterPromptFixtures);

describe('fix-site-analysis injection (the producer own renderer)', () => {
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

  // RE-POINTED 2026-08-13. These asserted that strings appeared in claude.sh, which passes on a
  // comment and proves nothing about what an agent is told. The framing moved into the writer's
  // prompt document when inputs became declared; the assertions now run against the RENDERED
  // prompt — the artifact the writer actually receives.
  const rendered = (id: string) => renderWriterPrompt({
    story: {
      id, title: 't', description: 'd', acceptanceCriteria: ['ac'],
      technicalNotes: { files: ['src/a.ts'] },
      fixSiteAnalysis: [{ file: 'src/a.ts', function: 'f', reason: 'because', fix: 'do it' }],
    },
    env: { EPAM_BROWNFIELD: '1' },
    projectFiles: { 'src/a.ts': 'export const a = 1;\n' },
  });

  it('the writer prompt carries the Root Cause section and the do-not-re-trace directive', () => {
    const r = rendered('RC-1');
    expect(r.rc, r.stderr).toBe(0);
    expect(r.text).toContain('Root Cause Analysis & Prescribed Fix (AUTHORITATIVE — start here, do not re-trace)');
    expect(r.text).toContain('do NOT re-read the whole codebase to re-derive it');
    expect(r.text, 'the plan itself never arrived, so the framing frames nothing').toContain('because');
  });

  it('frames the injected fix as AUTHORITATIVE over the ACs (ACs = verification, not blueprint)', () => {
    // The live failure: the agent followed eight splitting-flavoured ACs instead of the vaguer
    // root cause and built the wrong fix.
    const r = rendered('RC-2');
    expect(r.rc, r.stderr).toBe(0);
    expect(r.text).toContain('NOT an implementation blueprint');
    expect(r.text).toMatch(/SMALLEST change/);
    expect(r.text).toMatch(/Fewer lines of code is always better/);
    expect(r.text).toMatch(/REUSE existing functions/);
  });

  it('offers the CodeGraph helpers tool to the brownfield implementation agent', () => {
    // The agent must be able to discover an existing helper (e.g. a key parser)
    // instead of hand-rolling new logic — the exact miss in the live failure.
    expect(src).toContain('codegraph_tool_block');
    expect(src).toContain('codegraph_query');
    expect(src).toMatch(/mode=\\"helpers\\"/);
  });
});
