/**
 * Live gap (2026-07-12, tier3-travel-app run): _skill_note_format_ok()
 * already correctly enforces the reviewer's own stated rule (skill notes
 * must open with an imperative: Do not/Never/Always/Avoid/Use/Prefer).
 * SKY-002-impl's FailureAnalyst produced a genuinely correct, specific note
 * -- "When converting an interface to Record<string, unknown>, ensure the
 * interface has an index signature or use 'unknown' first to avoid TS2352
 * error." -- but it opens with a subordinate "When X, ..." clause, not an
 * imperative, so it correctly failed the deterministic pre-check and went
 * through the full LLM reviewer 3 times, was rejected 3 times on this same
 * fixable wording issue, and was ultimately persisted UNREVIEWED
 * ("[unreviewed-fallback]") instead of ever passing review.
 *
 * The underlying lesson was fine; only the opening word was wrong. This is
 * a mechanically fixable defect, not a judgment call -- _ensure_imperative_
 * opener() deterministically normalizes the opener (prepending "Always: "
 * when needed) BEFORE the note is ever handed to run_change_with_reviewer_
 * retry, so a note like this passes the deterministic format check (and
 * therefore skips the LLM reviewer entirely) on the very first attempt,
 * instead of burning 3 gate round-trips and ending up unreviewed anyway.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

// Pulls the exact declaration line for a top-level global var out of
// claude.sh, rather than duplicating its default value in this test file --
// both functions under test read these as their single source of truth, so
// the harness must use the REAL declarations, not copies that could drift.
function extractGlobalVarLine(name: string): string {
  const re = new RegExp(`^${name}=.*$`, 'm');
  const match = re.exec(claudeSrc);
  if (!match) throw new Error(`Global var ${name} not found`);
  return match[0];
}

const GLOBAL_VARS = [
  extractGlobalVarLine('SKILL_NOTE_IMPERATIVE_OPENERS'),
  extractGlobalVarLine('SKILL_NOTE_NORMALIZATION_OPENER'),
].join('\n');

function normalize(note: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'imperative-norm-'));
  try {
    const fnBody = extractFunctionBody('_ensure_imperative_opener');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, `${GLOBAL_VARS}\n${fnBody}\n_ensure_imperative_opener "$1"\n`);
    // `cut` (used internally for truncation) appends its own trailing
    // newline where `printf` alone would not -- trim it so both code paths
    // are compared consistently regardless of which one fired.
    return execFileSync('bash', [scriptPath, note], { encoding: 'utf8' }).replace(/\n$/, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('_ensure_imperative_opener() — REAL execution', () => {
  it('REPRODUCES the live gap: normalizes the exact live SKY-002-impl note so it now starts with an approved imperative', () => {
    const original =
      "When converting an interface to Record<string, unknown>, ensure the interface has an index signature or use 'unknown' first to avoid TS2352 error.";
    const normalized = normalize(original);
    expect(normalized).toMatch(/^(do not|never|always|avoid|use|prefer)\b/i);
    // The original lesson content must still be present, just re-headed --
    // this is a format fix, not a content rewrite.
    expect(normalized).toContain('index signature');
    expect(normalized).toContain('TS2352');
  });

  it.each(['Do not', 'Never', 'Always', 'Avoid', 'Use', 'Prefer'])(
    'leaves a note that already starts with "%s" unchanged',
    (verb) => {
      const note = `${verb} do the thing that fixes the bug.`;
      expect(normalize(note)).toBe(note);
    },
  );

  it('NEVER truncates — prepending an opener must not cost the end of the instruction', () => {
    // INVERTED 2026-08-11. This test used to assert `normalized.length <= 200`, i.e. it
    // RATIFIED the defect: a function that PREPENDS text was expected to cut the tail to
    // compensate. Live AMSD-2041/gotransit, that cut delivered "...change the pattern to
    // '/node_modules/(?!swiper|@azure|uu" to the writer — told to change a regex, never
    // told to what. Eight attempts, three ladder rungs, the run lost.
    //
    // Length is a REJECTION criterion upstream (the note goes back for rewrite), never a
    // mutilation applied here. A test that goes red when the system is fixed is backwards.
    const longNote = 'When the buffer overflows, ' + 'x'.repeat(190);
    const normalized = normalize(longNote);
    expect(normalized, 'the note was truncated').toContain(longNote);
    expect(normalized.length, 'prepending must lengthen, never shorten').toBeGreaterThan(longNote.length);
  });

  it('is a no-op on an empty note', () => {
    expect(normalize('')).toBe('');
  });
});

describe('_ensure_imperative_opener() — closes the gap end-to-end with _skill_note_format_ok', () => {
  function passesFormatCheck(note: string, storyId = 'SKY-002-impl'): boolean {
    const dir = mkdtempSync(join(tmpdir(), 'imperative-e2e-'));
    try {
      const normFn = extractFunctionBody('_ensure_imperative_opener');
      const formatFn = extractFunctionBody('_skill_note_format_ok');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          GLOBAL_VARS,
          normFn,
          formatFn,
          `note=$(_ensure_imperative_opener "$1")`,
          `_skill_note_format_ok "$note" "$2" ""`,
          `echo "RC=$?"`,
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath, note, storyId], { encoding: 'utf8' });
      return output.includes('RC=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the exact live note now PASSES the deterministic format check after normalization (previously failed, causing 3 wasted reviewer round-trips)', () => {
    const original =
      "When converting an interface to Record<string, unknown>, ensure the interface has an index signature or use 'unknown' first to avoid TS2352 error.";
    expect(passesFormatCheck(original)).toBe(true);
  });
});

describe('single source of truth — no duplicated/hardcoded word list across the two functions', () => {
  it('_skill_note_format_ok and _ensure_imperative_opener both read SKILL_NOTE_IMPERATIVE_OPENERS, neither hardcodes its own copy of the word list', () => {
    const formatFnBody = (() => {
      const defRe = /^\s*_skill_note_format_ok\(\)\s*\{/m;
      const start = defRe.exec(claudeSrc)!.index;
      return claudeSrc.slice(start, claudeSrc.indexOf('\n}', start) + 2);
    })();
    const normFnBody = (() => {
      const defRe = /^\s*_ensure_imperative_opener\(\)\s*\{/m;
      const start = defRe.exec(claudeSrc)!.index;
      return claudeSrc.slice(start, claudeSrc.indexOf('\n}', start) + 2);
    })();
    expect(formatFnBody).toMatch(/\$\{SKILL_NOTE_IMPERATIVE_OPENERS\}/);
    expect(normFnBody).toMatch(/\$\{SKILL_NOTE_IMPERATIVE_OPENERS\}/);
    // Neither function body should contain a literal, independently-typed
    // word list (e.g. "do not|never|always|avoid|use|prefer") -- that
    // pattern must appear exactly once in the whole file, in the shared
    // global var declaration, not copy-pasted into either function.
    const literalListPattern = /do not\|never\|always\|avoid\|use\|prefer/g;
    const occurrences = [...claudeSrc.matchAll(literalListPattern)].length;
    expect(occurrences).toBe(1);
  });

  it('_ensure_imperative_opener reads SKILL_NOTE_NORMALIZATION_OPENER as a variable, not a hardcoded "Always" literal', () => {
    const defRe = /^\s*_ensure_imperative_opener\(\)\s*\{/m;
    const start = defRe.exec(claudeSrc)!.index;
    const fnBody = claudeSrc.slice(start, claudeSrc.indexOf('\n}', start) + 2);
    expect(fnBody).toMatch(/\$\{SKILL_NOTE_NORMALIZATION_OPENER\}/);
    expect(fnBody).not.toMatch(/["']Always: /);
  });

  it('an overridden SKILL_NOTE_IMPERATIVE_OPENERS is honored by BOTH functions consistently (proves they truly share one source, not two independently-synced copies)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imperative-shared-source-'));
    try {
      const formatFn = extractFunctionBody('_skill_note_format_ok');
      const normFn = extractFunctionBody('_ensure_imperative_opener');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          'SKILL_NOTE_IMPERATIVE_OPENERS="must|shall"',
          'SKILL_NOTE_NORMALIZATION_OPENER="Must"',
          normFn,
          formatFn,
          // A note starting with "Always" -- accepted under the REAL
          // default list -- should now be REJECTED under this override,
          // proving the check isn't hardcoded to the original word set.
          '_skill_note_format_ok "Always validate input." "SKY-001" ""',
          'echo "OLD_WORD_RC=$?"',
          'normalized=$(_ensure_imperative_opener "Validate every input field.")',
          'echo "NORMALIZED=$normalized"',
          '_skill_note_format_ok "$normalized" "SKY-001" ""',
          'echo "NORMALIZED_RC=$?"',
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(output).toMatch(/OLD_WORD_RC=1/);
      expect(output).toMatch(/NORMALIZED=Must: Validate every input field\./);
      expect(output).toMatch(/NORMALIZED_RC=0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run_failure_analyst — skill_note is normalized immediately after extraction, before any reviewer call (static)', () => {
  it('calls _ensure_imperative_opener right after skill_note is extracted from analyst_json', () => {
    const extractIdx = claudeSrc.indexOf(`skill_note=$(echo "$analyst_json" | jq -r '.skill_note // ""'`);
    expect(extractIdx).toBeGreaterThan(-1);
    const nearby = claudeSrc.slice(extractIdx, extractIdx + 300);
    expect(nearby).toMatch(/_ensure_imperative_opener/);
  });

  it('the normalization happens BEFORE run_change_with_reviewer_retry is ever called for skill_note', () => {
    const extractIdx = claudeSrc.indexOf(`skill_note=$(echo "$analyst_json" | jq -r '.skill_note // ""'`);
    const normIdx = claudeSrc.indexOf('_ensure_imperative_opener', extractIdx);
    const reviewerCallIdx = claudeSrc.indexOf('run_change_with_reviewer_retry "$story_id" "skill_note"', extractIdx);
    expect(normIdx).toBeGreaterThan(extractIdx);
    expect(normIdx).toBeLessThan(reviewerCallIdx);
  });
});
