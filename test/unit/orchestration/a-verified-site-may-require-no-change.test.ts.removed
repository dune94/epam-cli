/**
 * "THE SPEC CONFIRMED THIS SITE" AND "THIS FILE MUST BE MODIFIED" ARE DIFFERENT CLAIMS.
 *
 * The deliverable gate fails a story when any fixVerified site shows no diff:
 *
 *     [ERROR] 1 VERIFIED fix site(s) left unchanged — the spec confirmed each and named the
 *             helper that owns it, so the story is incomplete: src/hooks/useContent.ts
 *
 * That gate exists for a real incident: four sites verified, the writer changed ONE, and the
 * story was committed as complete. Requiring a diff was the fix.
 *
 * But the detective marks a site verified when it is IMPLICATED, which is not the same as needing
 * an edit. Live AMSD-2041, the prescription for that exact file reads:
 *
 *     "No code change required in useContent itself — it already reads from ContentstackContext.
 *      Verify that when ContentstackProvider updates its content state, getContentByKey returns
 *      updated values."
 *
 * So the spec says make no change, the gate demands a change, and the writer is failed for doing
 * the right thing. Measured across the PRD: this affects the SAME file on ALL THREE codelines, so
 * the story cannot complete anywhere. Three runs and roughly nine attempts died on it.
 *
 * The detective already knew. It had nowhere structural to say so — the fix-site schema carries
 * brokenLine, evidenceVerified, fileVerified, fixVerified, helper, prescriptionNote and
 * prescriptionUnderspecified, and NONE of them distinguishes "verify this" from "edit this".
 * Confirmed by inspection: every field is identical between the change and no-change sites.
 * The knowledge existed and was lost to prose — the same failure as the survey that investigated
 * well and answered in prose.
 *
 * THE FIX IS STRUCTURAL, NOT TEXTUAL. A gate that reads the prescription looking for phrases like
 * "no code change" would be hardcoding English into the engine, would break on any rewording, and
 * would be untestable in any other language. The detective emits a boolean; the gate reads it.
 *
 * ABSENT MEANS REQUIRED. A site with no flag keeps today's behaviour — the gate's protection is
 * not weakened by an older PRD, a detective that has not been updated, or a hand-written spec.
 * The permissive default would silently disable the very check this file is careful to preserve.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const SPEC_RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Site = { file: string; fixVerified?: boolean; changeRequired?: boolean };

/**
 * The gate's own selection of "verified sites that were left unchanged", lifted from claude.sh
 * and executed against a PRD fixture. Executing the real jq rather than matching source: a filter
 * that is present but not applied is the defect class this repo keeps producing.
 */
function unchangedVerified(sites: Site[]): string[] {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('# VERIFIED-SITE SELECTION');
  const end = src.indexOf('# END VERIFIED-SITE SELECTION', start);
  if (start === -1 || end === -1) throw new Error('verified-site selection anchors not found — extraction stale');
  const block = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'verified-')); dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', fixSiteAnalysis: sites }] }));

  // prd_target is the variable the block actually reads; setting the outer PRD vars instead
  // produced an empty result for every case and would have "passed" the permissive tests while
  // proving nothing.
  const script = `
set -uo pipefail
story_id=S-1
prd_target=${JSON.stringify(prd)}
_f() {
${block}
  printf '%s\\n' "\${_verified_sites[@]:-}"
}
_f
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('the extraction is live', () => {
  it('the selection block exists', () => {
    expect(() => unchangedVerified([{ file: 'a.x', fixVerified: true }])).not.toThrow();
  });
});

describe('THE DEFECT: a verified site that needs no edit must not fail the story', () => {
  it('a verified site with changeRequired false is NOT demanded', () => {
    const out = unchangedVerified([
      { file: 'edit-me.x', fixVerified: true, changeRequired: true },
      { file: 'verify-only.x', fixVerified: true, changeRequired: false },
    ]);
    expect(
      out,
      'the gate demanded a diff on a site whose prescription says no change is required — the ' +
      'story cannot complete on any codeline',
    ).toEqual(['edit-me.x']);
  });

  it('a site that DOES require a change is still demanded', () => {
    // The gate's original purpose must survive: one real change is not enough when the spec
    // verified several sites.
    const out = unchangedVerified([
      { file: 'a.x', fixVerified: true, changeRequired: true },
      { file: 'b.x', fixVerified: true, changeRequired: true },
    ]);
    expect(out.sort()).toEqual(['a.x', 'b.x']);
  });
});

describe('ABSENT MEANS REQUIRED — an older PRD is not silently un-gated', () => {
  it('a verified site with no flag is still demanded', () => {
    const out = unchangedVerified([{ file: 'legacy.x', fixVerified: true }]);
    expect(
      out,
      'a site with no changeRequired flag stopped being checked — every PRD written before this ' +
      'field existed would lose the gate',
    ).toEqual(['legacy.x']);
  });

  it('an explicit null is treated as absent, not as false', () => {
    const out = unchangedVerified([
      { file: 'n.x', fixVerified: true, changeRequired: null as unknown as boolean },
    ]);
    expect(out).toEqual(['n.x']);
  });

  it('a non-boolean value does not disable the check', () => {
    for (const v of ['false', 0, '']) {
      const out = unchangedVerified([
        { file: 'weird.x', fixVerified: true, changeRequired: v as unknown as boolean },
      ]);
      expect(out, `changeRequired=${JSON.stringify(v)} disabled the gate`).toEqual(['weird.x']);
    }
  });

  it('an unverified site is not demanded regardless of the flag', () => {
    expect(unchangedVerified([{ file: 'c.x', fixVerified: false, changeRequired: true }])).toEqual([]);
  });
});

describe('the detective is asked for the field', () => {
  const spec = readFileSync(SPEC_RUNNER, 'utf8');

  it('the fix-site output shape includes changeRequired', () => {
    expect(
      spec,
      'the gate reads a field the detective is never asked to produce, so every future spec pass ' +
      'reproduces the unwinnable story',
    ).toContain('changeRequired');
  });

  it('the prompt explains WHEN it is false, not just that it exists', () => {
    const i = spec.indexOf('changeRequired');
    const near = spec.slice(Math.max(0, i - 1500), i + 1500);
    expect(near).toMatch(/verif|no (code )?change|already/i);
  });
});

describe('no English is hardcoded into the engine', () => {
  it('the gate does not sniff the prescription text', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('# VERIFIED-SITE SELECTION');
    // Comments excluded: the block QUOTES the live prescription to explain why the field exists,
    // and a whole-text match flagged that explanation as the defect. A sweep that cannot tell a
    // filter from a description of one reports its own comment.
    const block = src.slice(start, src.indexOf('# END VERIFIED-SITE SELECTION', start))
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const phrase of ['no code change', 'No code change', 'no change required', 'already reads']) {
      expect(
        block,
        `'${phrase}' is matched as text — a reworded prescription would silently re-break the gate`,
      ).not.toContain(phrase);
    }
  });
});
