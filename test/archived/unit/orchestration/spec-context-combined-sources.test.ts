/**
 * spec-mode-runner.js — fetchExistingCodeContext combines CodeGraph + Semble
 * for brownfield, instead of CodeGraph-with-Semble-as-fallback.
 *
 * Live bug (AMSD-1820, Metrolinx azure.commerce.cdts, 2026-07-22): the agent
 * never saw apply-report-discounts.service.ts — the actual file with the bug
 * (`lineItem.id === discount.lineItemId` failing for return dispatches due to
 * a `#return` suffix mismatch) — and instead wrote a brand-new, disconnected
 * module. Root-caused to two independent bugs, both fixed here:
 *
 *   1. resolveCodelinePath() only checked JIRA_WORKTREE_<CODELINE> env vars.
 *      Brownfield runs never set those — the codeline path is discovered
 *      dynamically and exported as PROJECT_ROOT instead. resolveCodelinePath
 *      always returned '', so BOTH fetchCodeGraphContext and
 *      fetchSembleContext silently found nothing, confirmed live by the spec
 *      pass's own note: "No existing code block was injected via CodeGraph
 *      or Semble, so locationHint is empty."
 *
 *   2. Even after fixing (1), CodeGraph's FTS5/BM25 keyword search matches on
 *      symbol names — a natural-language bug title doesn't share words with
 *      applyReportDiscountsService/getDiscountName, so CodeGraph surfaced
 *      generic mozio-adjacent files instead of the real fix site. But
 *      CodeGraph still returned SOME output, and the old fetchExistingCodeContext
 *      only tried Semble when CodeGraph returned NOTHING — so Semble (whose
 *      embedding search correctly ranked the real file 3rd) never got a
 *      chance to contribute. Fixed by running both and combining whatever
 *      each finds, rather than short-circuiting on CodeGraph's mere presence.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_SRC = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const CDTS_PATH = '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts';
const CDTS_PRESENT = existsSync(CDTS_PATH);

// Writes `code` to a temp .js file and runs it with execFileSync — avoids all
// shell-quoting hazards (the extracted source contains template literals with
// backticks, which break `node -e "..."` when passed through a shell).
function runNodeScript(code: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-context-test-'));
  try {
    const scriptPath = join(dir, 'run.js');
    writeFileSync(scriptPath, code);
    return execFileSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveCodelinePath — brownfield PROJECT_ROOT fallback', () => {
  const fnIdx = SPEC_SRC.indexOf('function resolveCodelinePath');
  const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 1800);

  it('falls back to process.env.PROJECT_ROOT when no JIRA_WORKTREE_* is set', () => {
    expect(fnBody).toMatch(/process\.env\.PROJECT_ROOT/);
  });

  it('the PROJECT_ROOT fallback is the LAST resort, after JIRA_WORKTREE_* checks', () => {
    const worktreeIdx = fnBody.indexOf('JIRA_WORKTREE_');
    const projectRootIdx = fnBody.lastIndexOf('process.env.PROJECT_ROOT');
    expect(worktreeIdx).toBeGreaterThan(-1);
    expect(projectRootIdx).toBeGreaterThan(worktreeIdx);
  });

  it('REAL execution: resolves to PROJECT_ROOT when no JIRA_WORKTREE_* env vars exist', () => {
    const fnCode = SPEC_SRC.slice(fnIdx, SPEC_SRC.indexOf('\n}', fnIdx) + 2);
    const script = `${fnCode}\nconsole.log(resolveCodelinePath({ codeline: 'cdts' }));\n`;
    // Strip any JIRA_WORKTREE_* from the child env, set PROJECT_ROOT explicitly
    const cleanEnv: Record<string, string> = { PROJECT_ROOT: '/tmp/fake-brownfield-repo' };
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('JIRA_WORKTREE_') && v !== undefined) cleanEnv[k] = v;
    }
    const dir = mkdtempSync(join(tmpdir(), 'resolve-codeline-test-'));
    try {
      const scriptPath = join(dir, 'run.js');
      writeFileSync(scriptPath, script);
      const out = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', env: cleanEnv }).trim();
      expect(out).toBe('/tmp/fake-brownfield-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL execution: JIRA_WORKTREE_<CODELINE> still takes precedence over PROJECT_ROOT when both are set', () => {
    const fnCode = SPEC_SRC.slice(fnIdx, SPEC_SRC.indexOf('\n}', fnIdx) + 2);
    const script = `${fnCode}\nconsole.log(resolveCodelinePath({ codeline: 'cdts' }));\n`;
    const out = runNodeScript(script, { PROJECT_ROOT: '/tmp/should-not-win', JIRA_WORKTREE_CDTS: '/tmp/worktree-wins' }).trim();
    expect(out).toBe('/tmp/worktree-wins');
  });
});

describe('fetchExistingCodeContext — combines CodeGraph + Semble for brownfield (not fallback-only)', () => {
  const fnIdx = SPEC_SRC.indexOf('function fetchExistingCodeContext');
  const fnBody = SPEC_SRC.slice(fnIdx, SPEC_SRC.indexOf('\n}', fnIdx) + 2);

  it('calls fetchCodeGraphContext unconditionally (not gated on a prior Semble check)', () => {
    expect(fnBody).toMatch(/const cgOutput = fetchCodeGraphContext\(story\)/);
  });

  it('calls fetchSembleContext unconditionally — NOT only when cgOutput is falsy', () => {
    // The old bug: `if (cgOutput) { return ...; } fetchSembleContext(...)` — Semble
    // only ran in the branch where cgOutput was falsy. The fix calls it
    // unconditionally, before any branching on cgOutput.
    const cgOutputIdx = fnBody.indexOf('cgOutput');
    const sembleCallIdx = fnBody.indexOf('const sembleOutput = fetchSembleContext(story)');
    expect(sembleCallIdx).toBeGreaterThan(-1);
    // sembleOutput must be computed, not nested inside an `if (!cgOutput)` block
    const betweenCgAndSemble = fnBody.slice(cgOutputIdx, sembleCallIdx);
    expect(betweenCgAndSemble).not.toMatch(/if\s*\(\s*!?\s*cgOutput/);
  });

  it('combines both outputs into the returned block when both are present', () => {
    expect(fnBody).toMatch(/blocks\.push/);
    expect(fnBody).toMatch(/blocks\.join/);
  });

  it('REAL execution: with mocked cg/semble modules both returning output, the combined result contains BOTH', () => {
    const mockDir = mkdtempSync(join(tmpdir(), 'spec-context-mock-'));
    try {
      const libDir = join(mockDir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, 'codegraph-context.js'), `
        module.exports = {
          isCodeGraphIndexed: () => true,
          exploreCodeGraph: () => 'CODEGRAPH_MARKER_OUTPUT',
        };
      `);
      writeFileSync(join(libDir, 'semble-context.js'), `
        module.exports = {
          resolveSembleBin: () => '/fake/semble',
          sembleSearch: () => ({ results: [{ file_path: 'x.ts', score: 0.5, content: 'SEMBLE_MARKER_CONTENT' }] }),
          formatAsText: () => 'SEMBLE_MARKER_OUTPUT',
        };
      `);
      // Extract resolveCodelinePath (defined separately, later in the file) plus
      // the two fetch functions + fetchExistingCodeContext, stub their deps.
      const resolveFnStart = SPEC_SRC.indexOf('function resolveCodelinePath');
      const resolveFnEnd = SPEC_SRC.indexOf('\n}', resolveFnStart) + 2;
      const resolveCode = SPEC_SRC.slice(resolveFnStart, resolveFnEnd);
      const fnStart = SPEC_SRC.indexOf('function fetchCodeGraphContext');
      const fnEnd = SPEC_SRC.indexOf('\n}', SPEC_SRC.indexOf('function fetchExistingCodeContext')) + 2;
      const combinedCode = resolveCode + '\n' + SPEC_SRC.slice(fnStart, fnEnd);
      const script = [
        `const fs = require('fs');`,
        `let _codegraph, _semble;`,
        combinedCode,
        `try {`,
        `  const result = fetchExistingCodeContext({ title: 'test', codeline: 'x' });`,
        `  console.log('RESULT_START' + result + 'RESULT_END');`,
        `} catch (e) {`,
        `  console.log('SCRIPT_ERROR: ' + e.stack);`,
        `}`,
      ].join('\n');
      const scriptPath = join(mockDir, 'run.js');
      writeFileSync(scriptPath, script);
      const env: Record<string, string> = {
        EPAM_BROWNFIELD: '1',
        CODEGRAPH_ENABLED: '1',
        SEMBLE_ENABLED: '1',
        PROJECT_ROOT: mockDir,
      };
      const out = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', cwd: mockDir, env: { ...process.env, ...env } });
      expect(out, `script output:\n${out}`).toMatch(/CODEGRAPH_MARKER_OUTPUT/);
      expect(out, `script output:\n${out}`).toMatch(/SEMBLE_MARKER_OUTPUT|SEMBLE_MARKER_CONTENT/);
    } finally {
      rmSync(mockDir, { recursive: true, force: true });
    }
  });
});

describe('SEMBLE_ENABLED — single source of truth (metrolinx.env no longer conflicts with config.env)', () => {
  const metrolinxEnv = readFileSync(join(REPO_ROOT, 'orchestrations/jira/metrolinx.env'), 'utf8');
  const configEnv = readFileSync(join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8');

  it('metrolinx.env does NOT set SEMBLE_ENABLED (avoids a second, conflicting source)', () => {
    expect(metrolinxEnv).not.toMatch(/^SEMBLE_ENABLED=/m);
  });

  it('config.env sets SEMBLE_ENABLED=1 — the single source of truth', () => {
    expect(configEnv).toMatch(/^SEMBLE_ENABLED=1$/m);
  });
});

// ── Live verification against the real azure.commerce.cdts repo ────────────
// Honest accounting, corrected after closer testing: an earlier version of
// this file claimed "Semble finds the real file" using a HAND-PARAPHRASED
// query ("promo code discount amount not displayed...") — not story.title
// verbatim. Testing the ACTUAL query fetchSembleContext constructs (the raw
// Jira title, "[Mozio] - The Promo code amount is NOT displayed as expected
// for Return trip tickets in the Mozio email confirmation") shows it does
// NOT reliably rank apply-report-discounts.service.ts in the top 8, even
// against a clean repo state with no poisoning from prior runs. The gap
// isn't noise (brackets, "NOT") — stripping those alone doesn't fix it
// either. It's vocabulary: the bug title never uses the word "discount",
// which is what the actual code (applyReportDiscountsService,
// getDiscountName) is named around. Bridging bug-report vocabulary to
// codebase vocabulary is a genuine, hard semantic-search problem — not
// something a generic regex/string transform can reliably solve without
// real risk of overfitting to this one example. This is recorded as a known,
// still-open limitation rather than papered over with an assertion that
// happens to pass on a hand-picked query.
describe('live verification against the real azure.commerce.cdts repo (skipped if not present)', () => {
  it('KNOWN LIMITATION: the real story.title query does not reliably rank the fix file in Semble\'s top 8, even in a clean (non-poisoned) repo state', () => {
    if (!CDTS_PRESENT) return;
    const semble = require(join(REPO_ROOT, 'orchestrations/scripts/lib/semble-context'));
    if (!semble.resolveSembleBin()) return;
    // Exact real title, verbatim — not a paraphrase.
    const realTitle = '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation';
    const result = semble.sembleSearch(realTitle, CDTS_PATH, 8, 10);
    const files = (result.results || []).map((r: any) => r.file_path);
    // Documents current reality (may include the file if repo state changes) —
    // this test exists to be revisited, not to assert false confidence either way.
    const found = files.includes('src/services/submit-reservations/apply-report-discounts.service.ts');
    expect(typeof found).toBe('boolean'); // always passes; the interesting output is the log below
    if (!found) {
      console.log('[known limitation] apply-report-discounts.service.ts NOT in top 8 for the raw title query. Top results:', files);
    }
  });

  // ── What IS proven: the mechanism runs and produces real output ─────────
  // Not "always finds the exact right file" (that's the known limitation
  // above) — but the pipeline BUG (context injection silently producing
  // nothing at all, confirmed live by the spec pass's own note "No existing
  // code block was injected via CodeGraph or Semble") is fixed: calling the
  // real, unmocked fetchExistingCodeContext with the real AMSD-1820 story and
  // the real pipeline env now reliably produces non-empty, real repo content
  // from both sources — a large, mechanical improvement over injecting
  // nothing, even though finding the exact fix site isn't guaranteed for
  // every story's wording.
  it('fetchExistingCodeContext(realAMSD1820Story), called exactly as the pipeline calls it, produces real non-empty output from both CodeGraph and Semble', () => {
    if (!CDTS_PRESENT) return;
    const semble = require(join(REPO_ROOT, 'orchestrations/scripts/lib/semble-context'));
    if (!semble.resolveSembleBin()) return;

    const prdPath = join(REPO_ROOT, 'orchestrations/travel-app-prd.json');
    if (!existsSync(prdPath)) return;
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const realStory = (prd.stories || []).find((s: any) => s.id === 'AMSD-1820');
    if (!realStory) return; // story not present in this environment's PRD snapshot — skip, don't fail

    const fnStart = SPEC_SRC.indexOf('function fetchCodeGraphContext');
    const fnEnd = SPEC_SRC.indexOf('\n}', SPEC_SRC.indexOf('function fetchExistingCodeContext')) + 2;
    const resolveFnStart = SPEC_SRC.indexOf('function resolveCodelinePath');
    const resolveFnEnd = SPEC_SRC.indexOf('\n}', resolveFnStart) + 2;
    const combinedCode = SPEC_SRC.slice(resolveFnStart, resolveFnEnd) + '\n' + SPEC_SRC.slice(fnStart, fnEnd);

    // Written into orchestrations/scripts/ itself (not /tmp): the extracted
    // code's require('./lib/codegraph-context') / require('./lib/semble-context')
    // are relative to the FILE's own location, and only resolve correctly
    // from here — the real location spec-mode-runner.js itself lives in.
    const scriptsDir = join(REPO_ROOT, 'orchestrations/scripts');
    const scriptPath = join(scriptsDir, `__e2e_context_test_${process.pid}.js`);
    try {
      const script = [
        `const fs = require('fs');`,
        `let _codegraph, _semble;`,
        combinedCode,
        `const story = ${JSON.stringify({ id: realStory.id, title: realStory.title, codeline: realStory.codeline, acceptanceCriteria: realStory.acceptanceCriteria || [] })};`,
        `try {`,
        `  const result = fetchExistingCodeContext(story);`,
        `  console.log('RESULT_START' + result + 'RESULT_END');`,
        `} catch (e) {`,
        `  console.log('SCRIPT_ERROR: ' + e.stack);`,
        `}`,
      ].join('\n');
      writeFileSync(scriptPath, script);

      // Real pipeline env, minus JIRA_WORKTREE_* — brownfield never sets those.
      const cleanEnv: Record<string, string> = {
        EPAM_BROWNFIELD: '1',
        CODEGRAPH_ENABLED: '1',
        SEMBLE_ENABLED: '1',
        PROJECT_ROOT: CDTS_PATH,
      };
      for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('JIRA_WORKTREE_') && v !== undefined) cleanEnv[k] = v;
      }
      const out = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', cwd: scriptsDir, env: cleanEnv, timeout: 30000 });
      expect(out, `script output:\n${out}`).not.toMatch(/SCRIPT_ERROR/);
      // Proves the mechanism: both sources produced real content, not empty
      // strings — this is what "No existing code block was injected via
      // CodeGraph or Semble" (the actual live failure) looked like before the fix.
      expect(out, `script output:\n${out}`).toMatch(/EXISTING CODE — CodeGraph static analysis/);
      expect(out, `script output:\n${out}`).toMatch(/EXISTING CODE \(brownfield fallback via Semble/);
      expect(out, `script output:\n${out}`).not.toBe('RESULT_STARTRESULT_END\n');
    } finally {
      rmSync(scriptPath, { force: true });
    }
  });
});
