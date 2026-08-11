/**
 * A SEVERED INSTRUCTION IS NOT SHORTER GUIDANCE — IT IS CONFIDENTLY WRONG GUIDANCE.
 *
 * Live, 2026-08-11, AMSD-2041/gotransit. The failure analyst diagnosed a Jest ESM failure
 * CORRECTLY (groundedness 0.76) and emitted the fix. What reached the writer was:
 *
 *   "Always: When integrating @contentstack/live-preview-utils, add it and lodash-es to
 *    jest.config.js transformIgnorePatterns exclusion regex, e.g. change the pattern to
 *    '/node_modules/(?!swiper|@azure|uu"
 *
 * It ends mid-regex. The writer was told to change a pattern and never told to what.
 * Eight attempts, three ladder rungs, the run lost — on a one-line config fix.
 *
 * CAUSE: _ensure_imperative_opener PREPENDED "Always: " and then piped through
 * `cut -c1-200`. Prepending makes the string LONGER; cutting the tail to compensate
 * destroys the END, which is where the fix lives. The "Always: " prefix on the delivered
 * text is the proof it was this function and not the downstream summarizer — the reviewer
 * was skipped entirely that attempt ("deterministic format check passed").
 *
 * These tests EXECUTE the real shell function against the real live input. They do not
 * assert that a `cut` is absent from the source: a source-text assertion passes on a
 * comment, a dead branch, or a deleted call site, and proves nothing about behaviour.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

/** Extract a function body from claude.sh and run it in isolation — the established pattern. */
function runNormalizer(note: string, opener = 'Always', openers = 'do not|never|always|avoid|use|prefer') {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('_ensure_imperative_opener() {');
  expect(start, '_ensure_imperative_opener not found — the test is stale, not the code').toBeGreaterThan(-1);
  // Balance braces from the opening line to capture the whole function.
  let depth = 0;
  let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fn = src.slice(start, end);

  const script = [
    `SKILL_NOTE_IMPERATIVE_OPENERS='${openers}'`,
    `SKILL_NOTE_NORMALIZATION_OPENER='${opener}'`,
    fn,
    '_ensure_imperative_opener "$1"',
  ].join('\n');

  const r = spawnSync('bash', ['-c', script, '_', note], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  expect(r.status, `bash failed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/** The exact fix the analyst produced on the live run, complete. 268 chars — over any 200 cap. */
const LIVE_FIX =
  'When integrating @contentstack/live-preview-utils, add it and lodash-es to jest.config.js ' +
  'transformIgnorePatterns exclusion regex, e.g. change the pattern to ' +
  "'/node_modules/(?!swiper|@azure|uuid|jose|@panva|@contentstack/live-preview-utils|lodash-es).+\\.js$'";

describe('the harness is real — otherwise every assertion below is vacuous', () => {
  it('the live fix is longer than the old 200-char cap, or this proves nothing', () => {
    expect(LIVE_FIX.length).toBeGreaterThan(200);
  });

  it('the normalizer runs and returns non-empty output', () => {
    expect(runNormalizer('Always do the thing.').length).toBeGreaterThan(0);
  });
});

describe('THE COMPLETE INSTRUCTION SURVIVES NORMALIZATION', () => {
  it('the live fix is returned WHOLE, regex intact', () => {
    const out = runNormalizer(LIVE_FIX);
    expect(out, 'the fix was truncated — the writer cannot act on a severed regex').toContain(LIVE_FIX);
  });

  it('the regex is not cut mid-token — the exact live failure', () => {
    const out = runNormalizer(LIVE_FIX);
    // The severed form ended at "@azure|uu". Its presence WITHOUT the closing paren is the bug.
    expect(out).toContain('lodash-es).+\\.js$');
    expect(out.endsWith('uu'), 'output ends mid-regex, exactly as it did live').toBe(false);
  });

  it('prepending an opener LENGTHENS the result — it never shortens it', () => {
    // The defect in one line: this function adds a prefix, so its output must be longer
    // than its input. Any implementation that truncates violates this for a long note.
    const out = runNormalizer(LIVE_FIX);
    expect(out.length).toBeGreaterThan(LIVE_FIX.length);
    expect(out.startsWith('Always: ')).toBe(true);
  });

  it('a note already opening with an imperative is returned unchanged', () => {
    const note = `Always ${LIVE_FIX}`;
    expect(runNormalizer(note)).toBe(note);
  });

  it('a misconfigured opener falls through without mangling the note', () => {
    // Pre-existing guard: if the configured opener is not itself an accepted word, return
    // the note untouched rather than prepend something that would fail the check anyway.
    expect(runNormalizer(LIVE_FIX, 'Frobnicate')).toBe(LIVE_FIX);
  });

  it('an empty note stays empty', () => {
    expect(runNormalizer('')).toBe('');
  });
});
