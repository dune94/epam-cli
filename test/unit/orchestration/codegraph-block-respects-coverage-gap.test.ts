/**
 * The "don't explore, apply the prescribed fix" suppression in
 * build_implementation_prompt()'s codegraph_tool_block must NOT fire blind
 * to fixSiteAnalysisCoverage.
 *
 * Root cause chain (2026-08-01, following the AMSD-2041 investigation): this
 * block decides whether the implementer is told to explore the codebase or
 * told to skip straight to applying the prescribed fix. The ONLY signal it
 * reads is "does any fixSiteAnalysis entry name a helper" — completely blind
 * to checkFixSiteCoverage's verdict (spec-mode-runner.js). A story with a
 * helper-bearing site AND unaddressed verification criteria still gets told
 * "do NOT explore... apply the prescribed minimal fix... and stop", with
 * only a soft escape hatch ("only search if you hit something the prescribed
 * fix genuinely does not cover") that relies on the model correctly noticing
 * a gap on its own — the exact class of judgment failure the coverage check
 * exists to catch deterministically instead of hoping for.
 *
 * This closes the loop the other 3 fixes opened: it is not enough for
 * fixSiteAnalysisCoverage to raise the iteration BUDGET (claude.sh
 * resolve_effort_settings/resolve_brownfield_effort_floor) if the PROMPT the
 * implementer actually reads still tells it not to look beyond the
 * prescribed sites. Real execution of the actual, unmodified block extracted
 * from claude.sh — not a re-implementation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = CLAUDE_SH.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = CLAUDE_SH.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return CLAUDE_SH.slice(start, end);
}

const block = extractBlock(
  '    local codegraph_tool_block=""',
  '\n\n    # New-dependency directive.'
);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(storyJson: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-block-'));
  dirs.push(dir);
  // A fake `codegraph` on PATH — the real block only checks `command -v codegraph`.
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codegraph'), '#!/usr/bin/env bash\ntrue\n');
  chmodSync(join(bin, 'codegraph'), 0o755);

  const script = `
export EPAM_BROWNFIELD=1
run_extracted() {
  local PROJECT_ROOT=/tmp/x
  local SCRIPT_DIR=/tmp/scripts
  local story_json='${JSON.stringify(storyJson)}'
${block}
  echo "$codegraph_tool_block"
}
run_extracted
`;
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

describe('codegraph_tool_block respects fixSiteAnalysisCoverage, not just "any helper named"', () => {
  it('a genuinely minimal fix (single site, helper, complete coverage) still gets the fast "do not explore" path', () => {
    const out = run({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'existingHelper' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
    });
    expect(out).toMatch(/do NOT search/i);
  });

  it('incomplete coverage with a helper-bearing site must NOT tell the model to skip exploration', () => {
    const out = run({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'existingHelper' }],
      fixSiteAnalysisCoverage: {
        complete: false,
        uncoveredVerificationCriteria: ['The SDK dependency is installed.', 'A preview API route exists.'],
      },
    });
    expect(out, 'the block still suppressed exploration despite known-incomplete coverage')
      .not.toMatch(/do NOT search/i);
  });

  it('when coverage is incomplete, the block explicitly names the uncovered verification criteria — not just a generic escape hatch', () => {
    const out = run({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'existingHelper' }],
      fixSiteAnalysisCoverage: {
        complete: false,
        uncoveredVerificationCriteria: ['The SDK dependency is installed.', 'A preview API route exists.'],
      },
    });
    expect(out).toContain('The SDK dependency is installed.');
    expect(out).toContain('A preview API route exists.');
  });

  it('no fixSiteAnalysisCoverage field at all (older PRD / non-detective story) behaves exactly as before — no false alarm', () => {
    const out = run({ fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'existingHelper' }] });
    expect(out).toMatch(/do NOT search/i);
  });

  it('no helper named at all still gets the full exploration block, regardless of coverage', () => {
    const out = run({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: '' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
    });
    expect(out).toMatch(/CodeGraph Tool/);
  });
});
