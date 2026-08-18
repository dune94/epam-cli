/**
 * THE WRITER IS TOLD EVERY HELPER IT IS JUDGED ON.
 *
 * Two consumers read the same field, `fixSiteAnalysis[].helper`, by different rules:
 *
 *   PROMPT  (claude.sh ~2516)  [.fixSiteAnalysis[]?.helper] | map(select(non-empty)) | .[0]
 *   GUARD   (claude.sh ~9881)  map(select(.fixVerified == true and .helper != ""))
 *                              | map(.helper) | unique | join(":")
 *
 * The prompt names ONE helper. The ReuseGuard enforces ALL of them. So the writer is
 * instructed about one symbol and rejected for the others — and the instruction that
 * carries the single name also forbids it from looking for more:
 *
 *   "The Root Cause Analysis above names the exact existing helper to reuse (`Stack`).
 *    Do NOT run CodeGraph or explore the codebase to re-find it — that wastes your turn
 *    budget. Import it, apply the prescribed minimal fix, write your file(s), and stop."
 *
 * Live, run of 2026-08-15 13:24 (metrolinx, AMSD-2041), killed at attempt 5 of 12:
 *
 *   prompt: reuse `Stack`
 *   guard:  ReuseGuard: 'ContentstackContext:Stack:getContentByKey:useContent'
 *   result: [HealingBroken] CRITICAL: 'Agent added live-preview logic without importing
 *           or calling the prescribed getContentByKey helper from src/hooks/useContent.ts'
 *           has recurred 2+ times ... self-healing is NOT working.
 *
 * The loop cannot converge: the corrective symbol never enters the prompt, so every
 * retry repeats the same omission and the ladder escalates to no purpose. No model can
 * import a symbol it was never given and was told not to search for.
 *
 * THE REQUIREMENT: whatever set the guard enforces, the prompt states. One list, one
 * source. This test names no symbol of its own — the expected set is derived from the
 * same fixture both consumers read.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

/**
 * The live AMSD-2041 shape: several verified sites, each naming its own helper, plus a
 * site with no helper and one that is NOT fixVerified (which the guard excludes).
 */
const STORY = {
  id: 'AMSD-2041',
  fixSiteAnalysis: [
    { file: 'src/services/contentstack.ts', helper: 'Stack', fixVerified: true },
    { file: 'src/context/contentstackContext.tsx', helper: 'ContentstackContext', fixVerified: true },
    { file: 'src/hooks/useContent.ts', helper: 'getContentByKey', fixVerified: true },
    { file: 'src/pages/_app.tsx', helper: 'useContent', fixVerified: true },
    { file: '.env.local.sample', helper: '', fixVerified: true },
    { file: 'src/services/pageService.ts', helper: 'getEntry', fixVerified: false },
  ],
};

/** What the ReuseGuard enforces — the real query, run against the fixture. */
function guardSymbols(prdPath: string): string[] {
  const q = `.stories[] | select(.id == "AMSD-2041") | (.fixSiteAnalysis // [])
     | map(select((.fixVerified == true) and ((.helper // "") != "")))
     | map(.helper) | unique | join(":")`;
  const r = spawnSync('jq', ['-r', q, prdPath], { encoding: 'utf8' });
  return (r.stdout || '').trim().split(':').filter(Boolean);
}

/** What the PROMPT tells the writer — the real query, extracted from claude.sh. */
function promptQuery(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  // The assignment is multi-line: `_prescribed_helper_list=$(echo ... | jq -r '<program>'`.
  // Extract the jq program itself, so the test reads whatever the engine actually runs.
  const at = src.indexOf('_prescribed_helper_list=$(');
  expect(at, '_prescribed_helper_list assignment not found').toBeGreaterThan(-1);
  const open = src.indexOf("jq -r '", at);
  expect(open, 'jq program not found in the assignment').toBeGreaterThan(-1);
  const start = open + "jq -r '".length;
  const close = src.indexOf("'", start);
  return src.slice(start, close);
}

function promptHelpers(prdPath: string): string[] {
  const r = spawnSync('jq', ['-r', `.stories[] | select(.id=="AMSD-2041") | ${promptQuery()}`, prdPath], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim().split(/[\s,:]+/).filter(Boolean);
}

function withFixture<T>(fn: (prd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'helper-set-'));
  try {
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [STORY] }));
    return fn(prd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the prompt states every helper the guard enforces', () => {
  it('the guard enforces more than one helper — otherwise this proves nothing', () => {
    withFixture((prd) => {
      expect(guardSymbols(prd).length).toBeGreaterThan(1);
    });
  });

  it('excludes helpers from sites that are not fixVerified', () => {
    // The guard's own filter. getEntry belongs to a fixVerified:false site and must not
    // be demanded of the writer.
    withFixture((prd) => {
      expect(guardSymbols(prd)).not.toContain('getEntry');
    });
  });

  it('THE DEFECT: the prompt names every symbol the guard will reject the writer for', () => {
    withFixture((prd) => {
      const guard = guardSymbols(prd).sort();
      const prompt = promptHelpers(prd).sort();
      const missing = guard.filter((s) => !prompt.includes(s));
      expect(
        missing,
        `the guard enforces ${guard.join(', ')} but the prompt states only ` +
          `${prompt.join(', ') || '(none)'} — the writer is rejected for symbols it was ` +
          `never given, and the same prompt forbids it from searching for them`,
      ).toEqual([]);
    });
  });

  it('names no symbol of its own — the set comes from the prescription', () => {
    const q = promptQuery();
    for (const sym of ['Stack', 'getContentByKey', 'ContentstackContext', 'useContent']) {
      expect(q, `the prompt query hardcodes '${sym}'`).not.toContain(sym);
    }
  });
});
