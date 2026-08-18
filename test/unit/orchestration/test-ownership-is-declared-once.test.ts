/**
 * ONE POLICY. ONE DEFINITION. BOTH AGENTS READ IT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * "Tests are NOT your job this turn" lived as a heredoc in claude.sh:2123 — the writer's
 * prompt builder — and NOWHERE ELSE. team-lead-review.sh had never heard of it, and was told:
 *
 *     Check: TypeScript strict compliance, test coverage, error handling, security (OWASP).
 *
 * So the reviewer saw no tests and raised a blocker for missing coverage. Commit 33ee47b then
 * hardened the writer's side of the same contradiction —
 *
 *     "A BLOCKER is a required deliverable, not advice. If a blocker says something is
 *      MISSING — a test, a file, a case — the only way to resolve it is to CREATE it"
 *
 * — so the writer is ORDERED TO CREATE WHAT IT IS FORBIDDEN TO CREATE. Live in the
 * 2026-08-12 prompt, 20 lines apart:
 *
 *     ## Tests are NOT your job this turn ... Do NOT write, edit, or create any test file
 *     [blocker] No unit tests exist for any of the live preview changes ... Add vitest tests
 *
 * An unwinnable gate, and the reason the writer has "over-reached" on every run I have
 * watched: it was obeying instructions.
 *
 * ONE POLICY DECLARED IN ONE AGENT'S PROMPT IS NOT A POLICY. It is a private belief. This
 * moves it into the contract catalog both prompts already render from — the writer to obey
 * it, the reviewer to know the writer is bound by it and not raise a blocker it cannot
 * satisfy. Single point of maintenance: change the rule once, both agents change together.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/test-ownership.json');
const PROJECT = join(ROOT, 'orchestrations/projects/metrolinx/prompts/test-ownership.json');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const REVIEW_SH = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');

const tpl = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const proj = () => JSON.parse(readFileSync(PROJECT, 'utf8'));
const claude = () => readFileSync(CLAUDE_SH, 'utf8');
const review = () => readFileSync(REVIEW_SH, 'utf8');

describe('THE POLICY IS DECLARED ONCE, IN THE PROMPT TEMPLATE LAYER', () => {
  it('the prompt TEMPLATE holds the policy', () => {
    expect(tpl().bodies,
      'the policy still lives only in the writer prompt, where the reviewer cannot see it')
      .toBeTruthy();
  });

  it('it says who owns the test and forbids the writer writing one', () => {
    const s = JSON.stringify(tpl().bodies);
    expect(s).toMatch(/test-writer/i);
    expect(s).toMatch(/do not (write|create)/i);
  });

  it('it tells the REVIEWER not to raise a blocker the writer cannot satisfy', () => {
    // The half that was missing entirely. Without it the reviewer keeps demanding tests.
    const s = JSON.stringify(tpl().bodies);
    expect(s, 'the reviewer half of the policy is not declared')
      .toMatch(/blocker/i);
  });
});

describe('BOTH AGENTS RENDER IT FROM THAT ONE PLACE', () => {
  it('the writer renders it from the prompt layer, not from a heredoc', () => {
    const s = claude();
    expect(s, 'the writer still carries its own copy')
      .not.toMatch(/## Tests are NOT your job this turn\\nA dedicated test-writer/);
    expect(s).toMatch(/test-ownership/);
  });

  it('THE DEFECT: the reviewer renders it too', () => {
    expect(review(), 'the reviewer still has no idea the writer is forbidden to write tests')
      .toMatch(/test-ownership/);
  });

  it('the policy text exists in NO script — one definition, not three', () => {
    // The assertion that makes this single-point-of-maintenance rather than three copies
    // that happen to agree today.
    for (const [name, s] of [['claude.sh', claude()], ['team-lead-review.sh', review()]]) {
      expect(s, `${name} carries a literal copy of the policy text`)
        .not.toMatch(/A dedicated test-writer agent runs immediately after your fix commits/);
    }
  });
});

describe('THE REVIEWER IS NO LONGER TOLD TO CHECK WHAT THE WRITER CANNOT PROVIDE', () => {
  it('its checklist does not demand test coverage unconditionally', () => {
    // "Check: TypeScript strict compliance, test coverage, error handling, security" is what
    // produced the blocker. Coverage is checked by vc-coverage-check.sh and by the dedicated
    // test-writer's own gate — not by rejecting the writer for a file it may not create.
    const s = review();
    expect(s, 'the reviewer is still told to check test coverage of the writer\'s change')
      .not.toMatch(/Check: TypeScript strict compliance, test coverage/);
  });
});

describe('IT IS A PROJECT-AUTHORITY PROMPT LIKE EVERY OTHER', () => {
  it('the generic template exists and is never executed directly', () => {
    expect(tpl().bodies.writer, 'no writer half declared').toBeTruthy();
    expect(tpl().bodies.reviewer, 'no reviewer half declared').toBeTruthy();
  });

  it('THIS PROJECT HAS ITS OWN VERSION — the only thing that runs', () => {
    // "the self-heal mechanism is the only process permitted to mutate project level
    // prompts ... WE WILL NEVER EVER run the template version".
    expect(proj().authority).toBe('project');
    expect(proj().derivedFrom).toMatch(/templates\/test-ownership\.json/);
  });

  it('the project copy records the template it was minted from, so drift is detectable', () => {
    const { createHash } = require('node:crypto');
    expect(proj().derivedFromSha256)
      .toBe(createHash('sha256').update(JSON.stringify(tpl().bodies)).digest('hex'));
  });

  it('the template carries no project or stack fact', () => {
    const s = JSON.stringify(tpl().bodies).toLowerCase();
    for (const leak of ['metrolinx', 'gotransit', 'contentstack', 'vitest', 'jest']) {
      expect(s, `'${leak}' is a project fact in a generic template`).not.toContain(leak);
    }
  });
});
