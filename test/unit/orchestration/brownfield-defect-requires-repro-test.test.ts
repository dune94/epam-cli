/**
 * Brownfield DEFECT must ship a bug-reproducing test — impl-prompt requirement
 * (found live 2026-07-24, AMSD-1820 run #2).
 *
 * The repro-gate (Step 3.55) HARD-BLOCKS any brownfield change that ships no test
 * reproducing the bug. But for a single-agent defect story NOTHING wrote that test:
 * the TC-writer only serves separate test-engineer stories, and the coverage policy
 * actively told the agent "the file ALREADY has covering tests — do NOT write any
 * new test file". So the agent shipped a garbage file literally named `test` (a copy
 * of the SOURCE) and no real test.
 *
 * Fix (claude.sh build_implementation_prompt):
 *  - A REQUIRED reproducing-test block (mandatory, concrete co-located *.test.* path
 *    the gate recognises) is injected for brownfield defects.
 *  - The contradicting coverage policy is skipped when a fix site is present.
 *
 * This drives the REAL bash logic extracted from claude.sh against fixture story JSON.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

// Extract the real required_test_block computation from claude.sh and run it.
function extractRequiredTestBlock(): string {
  const start = src.indexOf('    local required_test_block=""');
  const end = src.indexOf('    # Reviewer feedback (review→re-implement loop)');
  if (start === -1 || end === -1) throw new Error('required_test_block markers not found');
  return src.slice(start, end);
}
const rtBlock = extractRequiredTestBlock();

function runRequiredTest(opts: { brownfield: boolean; fixSite: boolean; fixFile?: string }): string {
  const fixSiteAnalysis = opts.fixSite ? 'present' : '';
  const storyJson = JSON.stringify({
    fixSiteAnalysis: opts.fixSite
      ? [{ file: opts.fixFile ?? 'src/services/submit-reservations/apply-report-discounts.service.ts', helper: 'parseDispatchLineItemKey' }]
      : [],
    verificationCriteria: ['The return-trip promo discount amount is displayed in the email.'],
  });
  const script = `
run_it() {
  local PROJECT_ROOT='/tmp/mockrepo'
  local story_json='${storyJson}'
  local fix_site_analysis='${fixSiteAnalysis}'
${rtBlock}
  printf '%s' "$required_test_block"
}
${opts.brownfield ? 'export EPAM_BROWNFIELD=1' : 'unset EPAM_BROWNFIELD'}
run_it
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('required bug-reproducing test — injected for brownfield defects', () => {
  it('brownfield defect → mandates a test at a concrete co-located *.test.* path', () => {
    const out = runRequiredTest({ brownfield: true, fixSite: true });
    expect(out).toMatch(/REQUIRED: ship a bug-reproducing test/);
    expect(out).toMatch(/MANDATORY/);
    // concrete path, co-located, recognised by the gate's *.test.* rule
    expect(out).toContain('/tmp/mockrepo/src/services/submit-reservations/apply-report-discounts.service.test.ts');
    // must reproduce: fail on baseline, pass with fix
    expect(out).toMatch(/FAILS against the old .*behavior and PASSES with your fix/);
    // guard against the exact live failure: no bare "test" filename, no newline in path
    expect(out).toMatch(/NEVER write a test to a bare name like "test"/);
    expect(out).toMatch(/Do NOT paste source code into the test file/);
  });

  it('derives the co-located path from ANY fix file extension', () => {
    const out = runRequiredTest({ brownfield: true, fixSite: true, fixFile: 'src/mappers/line-item.mapper.ts' });
    expect(out).toContain('/tmp/mockrepo/src/mappers/line-item.mapper.test.ts');
  });

  it('non-defect brownfield (no fix site) → no required-test block (VC guidance handles it)', () => {
    const out = runRequiredTest({ brownfield: true, fixSite: false });
    expect(out.trim()).toBe('');
  });

  it('greenfield → no required-test block', () => {
    const out = runRequiredTest({ brownfield: false, fixSite: true });
    expect(out.trim()).toBe('');
  });

  it('the impl prompt actually wires the block in (after Verification Criteria)', () => {
    expect(src).toMatch(/\$\(\[ -n "\$required_test_block" \] && printf '%s\\n' "\$required_test_block" \|\| true\)/);
  });
});
