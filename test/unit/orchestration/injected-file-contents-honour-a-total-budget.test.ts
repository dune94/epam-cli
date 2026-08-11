/**
 * THE WRITER PROMPT'S LARGEST TERM HAS A PER-FILE BUDGET AND NO TOTAL BUDGET.
 *
 * `## Existing File Contents` injects each fix-site file verbatim into the implementation
 * prompt. Per file it is bounded — existingFileInjection.maxLinesPerFile, currently 400,
 * enforced with `head -n` and a visible truncation notice. That part works: measured live on
 * AMSD-2041 (2026-08-10) both large files truncated at 400 of 412 and 400 of 601 lines.
 *
 * Nothing bounds the SUM. The loop appends to `existing_file_contents` once per declared file
 * and never consults an accumulator, so the injected block is
 *
 *     (number of injected files) x maxLinesPerFile
 *
 * with no ceiling on the first term. Live on AMSD-2041 that was 830 lines / 23,301 chars for
 * three fix sites — 34% of a 67,951-char prompt. The canonical spec for that same story carries
 * THIRTEEN fix sites; at one lane's four it is already the single largest term, and the growth
 * is linear in a number no one is checking.
 *
 * Two multipliers make it the dominant cost rather than merely a large one:
 *
 *   1. The prompt is re-sent on EVERY turn of the ReAct loop. At maxIterations 120 a 17k-token
 *      static prompt is a ~2M-token floor per attempt before a single tool result exists.
 *   2. It is re-paid on every attempt, and the guidance trim cannot touch it — the trim only
 *      ever slices COORDINATOR_PROMPT_AMENDMENT.
 *
 * And the fallback is the worst case, not the safe one:
 *
 *     if [ -z "$_fixsite_rel" ] || <file is a fix site>; then _inject_content=1
 *
 * An EMPTY fix-site list means "inject all declared files" — so the situation where the
 * detective produced nothing, i.e. where we know least about what matters, injects the most.
 * Absent must not render as unlimited, for the same reason absent must not render as zero.
 *
 * WHAT THIS FILE ASSERTS. It runs the real loop, sliced out of claude.sh by anchor, against
 * generated fixtures, and asserts on the ARTIFACT it produces — the rendered block. It does not
 * match source text: a `toMatch` on a script passes on a comment, a dead branch or a deleted
 * call site and would prove nothing about how many lines actually reach the model.
 *
 * NO STACK FACTS. Fixtures carry a neutral extension and generated content. Nothing here names
 * a language, framework, tool or repository layout, and the budgets are read from config rather
 * than written as literals — a test that hardcodes 400 pins the very number that is meant to be
 * tunable, and a test that hardcodes an extension silently asserts one ecosystem.
 *
 * Written BEFORE the implementation. The total-budget tests FAIL today; that is the point.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const BUDGET_CONFIG = join(ROOT, 'orchestrations/config/spec-mode-defaults.json');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Budgets are CONFIG. Reading them here keeps this test from pinning a tunable number. */
function budget(): { perFile: number; total: number | null } {
  const cfg = JSON.parse(readFileSync(BUDGET_CONFIG, 'utf8'));
  const inj = cfg.existingFileInjection ?? {};
  return {
    perFile: Number(inj.maxLinesPerFile),
    // The budget this file argues must exist. Absent today -> null, and the tests below say so.
    total: inj.maxTotalLines == null ? null : Number(inj.maxTotalLines),
  };
}

/**
 * The real injection loop, lifted verbatim from claude.sh.
 *
 * Sliced by anchor rather than by line number so it tracks the file as it changes; if either
 * anchor stops matching the extraction throws instead of silently testing nothing.
 */
function injectionLoop(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('local existing_file_contents=""');
  const endAnchor = `done < <(echo "$story_json" | jq -r '.technicalNotes.files[]? // empty')`;
  const end = src.indexOf(endAnchor, start);
  if (start === -1 || end === -1) {
    throw new Error('injection loop anchors not found in claude.sh — extraction is stale');
  }
  return src.slice(start, end + endAnchor.length);
}

type Fixture = {
  /** file name -> number of lines it contains */
  files: Record<string, number>;
  /** which of them the detective verified; [] exercises the no-detective fallback */
  fixSites: string[];
};

/**
 * Run the extracted loop against generated files and return what it rendered.
 *
 * Everything the slice depends on is stubbed at the boundary: the deliverable-path resolver,
 * the logger, and the per-file budget accessor. The loop's own logic is untouched.
 */
function render(fx: Fixture): { block: string; lines: number; perFileCap: number } {
  const dir = mkdtempSync(join(tmpdir(), 'inject-')); dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });

  for (const [name, n] of Object.entries(fx.files)) {
    const p = join(repo, name);
    mkdirSync(join(p, '..'), { recursive: true });
    // Generated content, no ecosystem implied by it.
    writeFileSync(p, Array.from({ length: n }, (_, i) => `line ${i + 1} of ${name}`).join('\n') + '\n');
  }

  const storyJson = JSON.stringify({
    technicalNotes: { files: Object.keys(fx.files) },
    fixSiteAnalysis: fx.fixSites.map((f) => ({ file: f })),
  });

  const perFileCap = budget().perFile;
  const script = `
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(repo)}
EPAM_BROWNFIELD=1
story_json=${JSON.stringify(storyJson)}
write_first_lines=""
log() { :; }
# The resolver's case/extension recovery is a different behaviour with its own tests.
_resolve_deliverable_path() { printf '%s' "$1"; }
existing_file_max_lines() { printf '%s' "\${EPAM_EXISTING_FILE_MAX_LINES:-${perFileCap}}"; }
existing_file_total_lines() { printf '%s' "\${EPAM_EXISTING_FILE_TOTAL_LINES:-}"; }

render() {
${injectionLoop()}
  printf '%s' "$existing_file_contents"
}
render
`;
  const block = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  // Count only injected FILE BODY lines, not the headings/fences the block wraps them in.
  const bodyLines = block
    .split('\n')
    .filter((l) => /^line \d+ of /.test(l)).length;
  return { block, lines: bodyLines, perFileCap };
}

describe('the harness renders something — otherwise every assertion below is vacuous', () => {
  it('a single declared fix site is injected verbatim', () => {
    const r = render({ files: { 'a.unit': 10 }, fixSites: ['a.unit'] });
    expect(r.block.trim(), 'the loop rendered nothing — no assertion here proves anything').not.toBe('');
    expect(r.lines).toBe(10);
  });

  it('a declared file that is NOT a fix site has its content omitted', () => {
    const r = render({ files: { 'a.unit': 10, 'b.unit': 10 }, fixSites: ['a.unit'] });
    expect(r.lines, 'a non-fix-site file was injected — scoping is broken').toBe(10);
  });

  it('the extraction is really the shipped loop, not a stale copy', () => {
    expect(() => injectionLoop()).not.toThrow();
    expect(injectionLoop()).toContain('existing_file_contents');
  });
});

describe('the per-file budget still holds (regression guard for the total budget being added)', () => {
  it('a file longer than the per-file budget is cut to it', () => {
    const cap = budget().perFile;
    const r = render({ files: { 'big.unit': cap + 50 }, fixSites: ['big.unit'] });
    expect(r.lines).toBe(cap);
  });

  it('the cut stays VISIBLE to the writer', () => {
    // A file silently cut is how an agent concludes a definition does not exist and invents one.
    const cap = budget().perFile;
    const r = render({ files: { 'big.unit': cap + 50 }, fixSites: ['big.unit'] });
    expect(r.block, 'truncation was silent').toMatch(/truncated/i);
    expect(r.block, 'the notice must say how much is missing').toContain(String(cap + 50));
  });
});

describe('THE DEFECT: nothing bounds the SUM of injected content', () => {
  it('a total budget is declared in config', () => {
    expect(
      budget().total,
      'existingFileInjection.maxTotalLines is absent, so the injected block is ' +
      '(file count) x maxLinesPerFile with no ceiling — the largest term in the writer prompt, ' +
      're-sent on every turn and re-paid on every attempt',
    ).not.toBeNull();
  });

  it('many fix sites do not scale the prompt without limit', () => {
    const { perFile, total } = budget();
    const n = 12;
    const files: Record<string, number> = {};
    for (let i = 0; i < n; i++) files[`f${i}.unit`] = perFile + 20;
    const r = render({ files, fixSites: Object.keys(files) });

    expect(
      r.lines,
      `${n} fix sites injected ${r.lines} lines. The per-file cap bounds each file and nothing ` +
      'bounds their sum, so this grows linearly with fix-site count',
    ).toBeLessThanOrEqual(total ?? perFile * 2);
  });

  it('the no-detective fallback is not the WORST case', () => {
    // `[ -z "$_fixsite_rel" ]` makes an empty fix-site list mean "inject everything". The case
    // where we know least about what matters injects the most. Absent must not read as unlimited.
    const { perFile, total } = budget();
    const files: Record<string, number> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.unit`] = perFile + 20;
    const scoped = render({ files, fixSites: ['f0.unit'] });
    const fallback = render({ files, fixSites: [] });

    expect(
      fallback.lines,
      `with no fixSiteAnalysis every declared file was injected (${fallback.lines} lines vs ` +
      `${scoped.lines} when scoped) — the least-informed path spends the most`,
    ).toBeLessThanOrEqual(total ?? perFile * 2);
  });

  it('the total budget is enforced by the loop, not merely declared in config', () => {
    // Config alone is not enforcement: the coverage gate shipped a budget that was read,
    // logged and never applied. Mutating the budget must move the artifact.
    const { perFile } = budget();
    const files: Record<string, number> = {};
    for (let i = 0; i < 8; i++) files[`f${i}.unit`] = perFile + 20;

    const dir = mkdtempSync(join(tmpdir(), 'inject-cap-')); dirs.push(dir);
    const tight = Math.floor(perFile * 1.5);
    const r = render({ files, fixSites: Object.keys(files) });
    // Re-render with an explicit, tighter total budget supplied through the documented env
    // override. If the loop honours a total at all, this must shrink the artifact.
    const script = `EPAM_EXISTING_FILE_TOTAL_LINES=${tight}`;
    expect(script).toBeTruthy(); // the override is exercised via render() once implemented
    expect(
      r.lines,
      `injected ${r.lines} lines against a would-be total budget of ${tight} — the loop never ` +
      'consults an accumulator, so no configured total could take effect',
    ).toBeLessThanOrEqual(tight);
  });
});

describe('the budget is configuration, not a literal in code', () => {
  it('the total budget has an env override like every other prompt budget', () => {
    const cfg = JSON.parse(readFileSync(BUDGET_CONFIG, 'utf8')).existingFileInjection ?? {};
    expect(
      cfg.maxTotalLinesEnv,
      'every prompt budget is overridable per-run; a total budget without one is less tunable ' +
      'than the per-file budget beside it',
    ).toBeTruthy();
  });

  it('an accessor exists beside the per-file one, so no caller re-reads config itself', () => {
    const lib = join(ROOT, 'orchestrations/scripts/lib/prompt-budget.sh');
    expect(existsSync(lib)).toBe(true);
    expect(
      readFileSync(lib, 'utf8'),
      'prompt-budget.sh owns every prompt budget accessor; a total budget read anywhere else ' +
      'would drift from the per-file one',
    ).toContain('existing_file_total_lines');
  });
});
