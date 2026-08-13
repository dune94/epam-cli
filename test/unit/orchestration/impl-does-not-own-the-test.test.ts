/**
 * B1 — the impl agent must NOT be told to write the bug-reproducing test.
 *
 * REPLACES the premise of brownfield-defect-requires-repro-test.test.ts, which
 * asserted the impl prompt MANDATES a co-located *.test.* file. That requirement
 * was a deliberate hedge, taken when the dedicated test-writer produced nothing at
 * all (it whiffed on max-iterations and shipped no test, so the repro-gate blocked).
 * The hedge is now net-negative and was measured as such:
 *
 *   Run 2026-07-24 15:36 — killed at 7 impl attempts / $1.11. Impl committed
 *   `apply-report-discounts.service.test.ts`, and the failure-analyst's own
 *   diagnosis was ABOUT that file: "Test file accesses possibly-undefined
 *   variables without null narrowing under strict mode." Six consecutive quality
 *   failures were spent fighting a test the impl should never have been writing.
 *
 * The clean division of labour (confirmed by the user, held pending proof):
 *   impl            -> writes ONLY the fix
 *   repro-test-writer -> owns the reproducing test, and since 2026-07-24 VALIDATES
 *                        it (parses + runs) before committing, with retry + ladder
 *                        + self-heal on failure
 *   repro-gate      -> independently judges whether the test reproduces the bug
 *
 * That validation is the proof the hedge was waiting on, so the hedge is removed.
 * The gate still blocks a fix that ships without a reproducing test — nothing about
 * enforcement changes here, only WHO is asked to author it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWriterPrompt, cleanupWriterPromptFixtures } from '../../helpers/writer-prompt';

const CLAUDE_SH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

afterAll(cleanupWriterPromptFixtures);

describe('B1 — impl writes only the fix; the test-writer owns the test', () => {
  it('the impl prompt does NOT mandate that impl ship a bug-reproducing test', () => {
    expect(CLAUDE_SH).not.toMatch(/REQUIRED: ship a bug-reproducing test/);
  });

  it('no required_test_block is built or injected any more', () => {
    expect(CLAUDE_SH).not.toMatch(/required_test_block=\$\(printf/);
    expect(CLAUDE_SH).not.toMatch(/\$\(\[ -n "\$required_test_block" \]/);
  });

  it('impl is told explicitly that the test is NOT its job (so it does not volunteer one)', () => {
    // Silence is not enough: an AC or habit can still pull the agent into writing
    // tests. Removing the mandate must be paired with an explicit hand-off.
    expect(CLAUDE_SH).toMatch(/do NOT write .*test|test.*is NOT your job|dedicated test-writer/i);
  });

  it('the DEFECT coverage-policy carve-out survives the removal', () => {
    // The coverage policy ("this file already has covering tests, do not write new ones") must
    // still be SKIPPED when there IS a prescribed fix: it directly contradicted the repro-gate and
    // caused the original missing-test failure.
    //
    // RE-POINTED 2026-08-13: this matched a shell condition by regex, so it broke when the
    // carve-out started asking the published store whether a plan exists instead of reading the
    // detective's field. The carve-out is a BEHAVIOUR — assert the behaviour. A source match would
    // also have passed on a commented-out condition.
    const story = (id: string, extra: Record<string, unknown>) => ({
      id, title: 't', description: 'd', acceptanceCriteria: ['ac'],
      technicalNotes: { files: ['src/a.ts'] }, ...extra,
    });
    const opts = {
      env: { EPAM_BROWNFIELD: '1' },
      projectFiles: { 'src/a.ts': 'export const a = 1;\n' },
    };

    const withPlan = renderWriterPrompt({
      story: story('CARVE-1', {
        fixSiteAnalysis: [{ file: 'src/a.ts', function: 'f', reason: 'because', fix: 'do it' }],
      }),
      ...opts,
    });
    const withoutPlan = renderWriterPrompt({ story: story('CARVE-2', {}), ...opts });

    expect(withPlan.rc, withPlan.stderr).toBe(0);
    expect(withoutPlan.rc, withoutPlan.stderr).toBe(0);

    expect(withoutPlan.text,
      'a story with no prescribed fix lost the brownfield coverage policy')
      .toMatch(/Brownfield Testing Policy/i);
    expect(withPlan.text,
      'the coverage policy reached a defect story, contradicting the repro-gate exactly as it did live')
      .not.toMatch(/Brownfield Testing Policy/i);
  });

  it('the repro-gate still enforces that a reproducing test ships', () => {
    // Removing the impl mandate must NOT weaken enforcement — only move authorship.
    const GATE = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-gate.sh'), 'utf8');
    expect(GATE).toMatch(/block\b/i);
  });

  it('the test-writer is still invoked before the gate (authorship has an owner)', () => {
    const ORCH = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    const writerIdx = ORCH.indexOf('brownfield-repro-test-writer.sh');
    const gateIdx = ORCH.indexOf('brownfield-repro-test-gate.sh');
    expect(writerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(writerIdx).toBeLessThan(gateIdx);
  });
});
