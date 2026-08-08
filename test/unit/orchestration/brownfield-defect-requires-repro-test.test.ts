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

// Extract the real test-ownership block computation from claude.sh and run it.
// Renamed from test_ownership_block on 2026-07-24 (B1): impl no longer AUTHORS the
// test, it is told the test is not its job and the repro-test-writer owns it.
function extractRequiredTestBlock(): string {
  const start = src.indexOf('    local test_ownership_block=""');
  const end = src.indexOf('    # Reviewer feedback');
  if (start === -1 || end === -1) throw new Error('test_ownership_block markers not found');
  return src.slice(start, end);
}
const rtBlock = extractRequiredTestBlock().replace(/test_ownership_block/g, 'test_ownership_block');

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
  printf '%s' "$test_ownership_block"
}
${opts.brownfield ? 'export EPAM_BROWNFIELD=1' : 'unset EPAM_BROWNFIELD'}
run_it
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('required bug-reproducing test — injected for brownfield defects', () => {
  // SUPERSEDED 2026-07-24 (B1): impl no longer authors the test — see
  // impl-does-not-own-the-test.test.ts. Measured: keeping the mandate cost 7 impl
  // attempts / $1.11 on a run killed while impl fought a test file it should never
  // have written. Enforcement did not move — the repro-gate still blocks.
  it('brownfield defect → tells impl the test is NOT its job (hand-off, not a mandate)', () => {
    const out = runRequiredTest({ brownfield: true, fixSite: true });
    // The hand-off must be explicit. Silence is not enough — an AC or plain habit
    // still pulls the agent into writing tests, which is what burned 7 attempts.
    expect(out).toMatch(/Tests are NOT your job/);
    expect(out).toMatch(/Do NOT write, edit, or create any test file/);
    expect(out).toMatch(/\*\.test\.\*|\*\.spec\.\*|__tests__/);
    // and the old mandate must be gone, not merely softened
    expect(out).not.toMatch(/REQUIRED: ship a bug-reproducing test/);
    expect(out).not.toMatch(/MANDATORY/);
  });

  it('names the dedicated test-writer as the owner, for ANY fix file extension', () => {
    // The block no longer derives a co-located path — impl is not writing the file.
    const out = runRequiredTest({ brownfield: true, fixSite: true, fixFile: 'src/mappers/line-item.mapper.ts' });
    expect(out).toMatch(/dedicated test-writer agent/);
  });

  // SUPERSEDED 2026-08-08. This asserted that a brownfield story with no fix site got no
  // ownership block. That was written when the block was understood as a DEFECT concern, but
  // it states who AUTHORS tests — and authorship is brownfield-wide, not fix-site-scoped:
  // brownfield-repro-test-writer.sh gates on brownfield + fix files present + no test already
  // in the diff (lines 45, 64, 65) and never consults fixSiteAnalysis, which it uses only as a
  // hint with two fallbacks. So the writer's turn happens either way.
  //
  // Leaving the block out meant that on a no-fix-site story the implementer was never told
  // tests were not its job, and its roster brief — which on AMSD-2041 said "You write Jest
  // tests... colocated alongside the modules you edit" — was the only instruction in play.
  // DET-1 makes "investigated, found nothing" a legitimate state, so that path gets more
  // traffic, not less. The repro-gate still blocks a fix that ships without a test, so a
  // missing test is caught rather than shipped.
  it('brownfield with NO fix site still states who owns the tests', () => {
    const out = runRequiredTest({ brownfield: true, fixSite: false });
    expect(out).toMatch(/Tests are NOT your job/);
  });

  it('greenfield → no required-test block', () => {
    const out = runRequiredTest({ brownfield: false, fixSite: true });
    expect(out.trim()).toBe('');
  });

  it('the impl prompt actually wires the block in (after Verification Criteria)', () => {
    expect(src).toMatch(/\$\(\[ -n "\$test_ownership_block" \] && printf '%s\\n' "\$test_ownership_block" \|\| true\)/);
  });
});
