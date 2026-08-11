/**
 * A FINDING NOTHING READS IS NOT A CHECK.
 *
 * Step 3.56 runs vc-coverage-check.sh, which compares each verification criterion against the
 * tests that shipped and writes $LOG_DIR/vc-coverage-<story>.json. Grep for readers of that file
 * and there are none. It is written and abandoned.
 *
 * Live 2026-08-11, AMSD-2041/gotransit — what it found, and what nobody saw:
 *
 *   "No test asserts that draft content values are actually displayed when live preview
 *    parameters are present."
 *        → the feature's entire purpose, unverified. The implementation re-renders with a
 *          shallow copy of unchanged content, so this is the finding that says the feature may
 *          not work at all.
 *
 *   "The test re-implements shouldForwardLivePreview locally rather than importing the real
 *    production function, so its assertions would pass even if the actual implementation
 *    violated the requirement."
 *        → a test that re-implements the code under test. It cannot fail for the right reason.
 *
 * Both are exactly what a reviewer exists to catch, and the reviewer was never told. Its only
 * mention of coverage is boilerplate prose in its own prompt ("Check: ... test coverage ...").
 *
 * ORDER MATTERS. The REVIEWER gets these first: it holds the diff and the criteria, and judging
 * whether a criterion is genuinely untestable here (this codeline cannot reach the CMS) is a
 * judgement, not an engine rule. The WRITER gets them second and advisory, inside its own loop,
 * where it can still act.
 *
 * Written BEFORE the wiring.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RENDERER = join(ROOT, 'orchestrations/scripts/lib/vc-coverage-findings.js');
const CONTRACT = join(ROOT, 'orchestrations/config/agent-contract.json');
const REVIEW_SH = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real artifact shape, taken from the live run. */
const FINDINGS = [
  {
    covered: false,
    case: '',
    vc: 'When the page request includes live preview parameters, the rendered page displays the draft content values.',
    why: 'No test asserts that draft content values are actually displayed when live preview parameters are present.',
  },
  {
    covered: false,
    case: '',
    vc: 'For a page that requires authentication, an unauthenticated visitor cannot view the page content.',
    why: 'The test re-implements the gating function locally instead of importing the real one.',
  },
  { covered: true, case: 'renders published content', vc: 'Published content still renders.', why: '' },
];

function logDir(findings: unknown = FINDINGS, story = 'S-1'): string {
  const d = mkdtempSync(join(tmpdir(), 'vccov-')); dirs.push(d);
  if (findings !== null) {
    writeFileSync(join(d, `vc-coverage-${story}.json`), JSON.stringify(findings));
  }
  return d;
}

function render(dir: string, story = 'S-1'): string {
  return execFileSync(process.execPath, [RENDERER, dir, story, CONTRACT], { encoding: 'utf8' });
}

describe('the renderer exists and is a real file, not inline node -e', () => {
  it('lib/vc-coverage-findings.js is present', () => {
    expect(
      existsSync(RENDERER),
      'inline `node -e` in claude.sh broke that script three times; the working pattern is a file',
    ).toBe(true);
  });
});

describe('ONLY UNCOVERED CRITERIA ARE SURFACED', () => {
  it('an uncovered criterion is rendered with the reason it is uncovered', () => {
    const out = render(logDir());
    expect(out).toContain('draft content values');
    expect(out, 'the WHY is the actionable half — a bare list of criteria is not a finding').toContain('No test asserts');
  });

  it('a covered criterion is not mentioned', () => {
    const out = render(logDir());
    expect(out, 'reporting satisfied criteria buries the ones that matter').not.toContain('Published content still renders');
  });

  it('every uncovered criterion appears, not just the first', () => {
    const out = render(logDir());
    expect(out).toContain('re-implements the gating function');
  });
});

describe('ABSENT IS NOT CLEAN', () => {
  it('no artifact renders NOTHING rather than a false all-clear', () => {
    // The caller appends nothing. It must never emit "all criteria covered" from an absent file:
    // "the check did not run" and "the check passed" are different states.
    expect(render(logDir(null)).trim()).toBe('');
  });

  it('an artifact with no uncovered criteria renders nothing', () => {
    const out = render(logDir([{ covered: true, vc: 'x', why: '', case: 'c' }]));
    expect(out.trim()).toBe('');
  });

  it('an unreadable artifact renders nothing rather than crashing the prompt build', () => {
    const d = mkdtempSync(join(tmpdir(), 'vccov-')); dirs.push(d);
    writeFileSync(join(d, 'vc-coverage-S-1.json'), '{ not json');
    expect(render(d).trim()).toBe('');
  });
});

describe('THE WORDING IS CATALOG-OWNED, NOT COMPOSED IN THE ENGINE', () => {
  it('the section is declared in agent-contract.json', () => {
    const c = JSON.parse(readFileSync(CONTRACT, 'utf8'));
    expect(c.uncoveredCriteria, 'the block must be project-editable like every other prompt section').toBeTruthy();
  });

  it('the renderer composes no sentence of its own', () => {
    const code = readFileSync(RENDERER, 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    // A bare list is data; a sentence explaining it is prose and belongs in the catalog.
    expect(code).not.toMatch(/'[A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+/);
  });
});

describe('BOTH CONSUMERS ARE WIRED — the reviewer first', () => {
  // COLLECTING IS NOT DELIVERING. Mutation-verified 2026-08-11: deleting the line that renders
  // the block into the reviewer's prompt left every assertion green, because the script was
  // still being CALLED. A finding computed and never shown is the exact defect being fixed, so
  // both halves are asserted: the call, and the variable reaching the prompt.
  it('the reviewer collects the findings', () => {
    const src = readFileSync(REVIEW_SH, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(
      src,
      'the reviewer holds the diff and the criteria — an uncovered criterion is precisely a ' +
      'review finding, and its only mention of coverage today is boilerplate prose',
    ).toContain('vc-coverage-findings.js');
  });

  it('and RENDERS them into its prompt', () => {
    const src = readFileSync(REVIEW_SH, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src, 'the variable is computed but never shown to the model').toMatch(
      /printf[^\n]*"\$STORY_UNCOVERED_VC"/);
  });

  it('the writer collects them too', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src, 'advisory, inside the loop, where the writer can still act').toContain('vc-coverage-findings.js');
  });

  it('and RENDERS them into the implementation prompt', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src).toMatch(/printf[^\n]*"\$_uncovered_vc_block"/);
  });
});
