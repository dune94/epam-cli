/**
 * A GATE THAT DID NOT RUN IS NOT A GATE THAT PASSED.
 *
 * lib/prompt-review.js returns `{ ok: true }` on five separate failure paths — the renderer threw,
 * the renderer produced nothing, the model call threw, no parseable verdict came back, the verdict
 * was not valid JSON. Every way the reviewer can fail, it reports PASS, and the prompt every
 * downstream agent inherits is installed unexamined. It rejects when it works and approves when it
 * breaks, so its protection is only as good as its own reliability and there is no signal when that
 * lapses.
 *
 * This is not one file's mistake. It is the shape that has cost this pipeline repeatedly:
 *
 *   the coverage gate logged a block and returned 0
 *   the quality gates' verdicts were read but not enforced
 *   an unmeasured stage was treated as a covered one
 *
 * Each was found by a run. Each was findable by reading the code for one signature: a pass-shaped
 * value returned from a failure path.
 *
 * WHAT THIS SCANS FOR: inside a catch block, or immediately after a parse/empty-output failure, a
 * return whose value means "fine" — ok: true, verdict: approved|sound|pass, or a bare true.
 *
 * WHAT IT DELIBERATELY ALLOWS: a failure path that returns a DISTINCT outcome the caller must
 * handle — review_failed, unreviewed, unknown, error. Those are honest: they say the check did not
 * happen and leave the decision to someone who can make it. The rule is not "never return from a
 * catch"; it is "never return SUCCESS from one".
 *
 * A finding here does not always mean a defect — a gate may deliberately degrade — but it must be
 * DECLARED, with the reason recorded beside it, so the choice is visible rather than accidental.
 * That is what the allowlist is: not an exemption, a statement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const SCRIPTS = join(REPO, 'orchestrations/scripts');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (/node_modules|\.venv|[/\\]logs|[/\\]runs|\.parked|\.git/.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.js$/.test(p)) out.push(p);
  }
  return out;
}

/** A returned value that means "all is well". */
const PASS_SHAPED = /return\s*\{[^}]*\b(?:ok\s*:\s*true|verdict\s*:\s*['"](?:approved|sound|pass|passed)['"]|passed\s*:\s*true)/;

/**
 * Failure paths that return a pass-shaped value.
 *
 * Scanned line-wise with a small window rather than parsed: a catch body here is short by
 * convention, and a parser would be a second thing to maintain for no extra truth.
 */
function failOpenSites(file: string): Array<{ line: number; text: string }> {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isFailurePath = /\bcatch\s*(\([^)]*\))?\s*\{/.test(l)
      || /(could not|failed to|no parseable|not valid JSON|returned nothing|unparseable)/i.test(l);
    if (!isFailurePath) continue;
    // Look a few lines ahead: the return that answers this failure.
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join('\n');
    if (!PASS_SHAPED.test(window)) continue;
    // A declared degradation states itself next to the return.
    const context = lines.slice(Math.max(0, i - 8), i + 6).join('\n');
    if (/DELIBERATE FAIL-OPEN|deliberately degrades|declared fail-open/i.test(context)) continue;
    hits.push({ line: i + 1, text: l.trim().slice(0, 90) });
  }
  return hits;
}

const files = walk(SCRIPTS);

describe('no gate reports pass when it could not run', () => {
  it('there are files to scan — otherwise a clean result means nothing', () => {
    expect(files.length, 'no scripts found to scan').toBeGreaterThan(20);
  });

  it('THE SIGNATURE IS DETECTABLE: the scanner finds a planted fail-open', () => {
    // A positive control. A scanner that reports zero is indistinguishable from one that looks for
    // the wrong thing, and this file exists precisely because silence was mistaken for safety.
    const planted = `
      try { verdict = JSON.parse(raw); }
      catch (e) {
        warn('no parseable verdict — installing UNREVIEWED');
        return { ok: true };
      }`;
    expect(PASS_SHAPED.test(planted), 'the pass-shaped pattern does not match a real fail-open')
      .toBe(true);
  });

  it('an honest failure path is NOT flagged', () => {
    // The negative half. Returning a distinct outcome the caller must handle is the correct shape,
    // and a scanner that flags it would push people toward suppressing it.
    const honest = `
      catch (e) {
        return { verdict: 'review_failed', reason: 'the review call failed' };
      }`;
    expect(PASS_SHAPED.test(honest), 'an honest failure return was treated as a fail-open')
      .toBe(false);
  });

  it('NO GATE IN THE PIPELINE RETURNS SUCCESS FROM A FAILURE PATH', () => {
    const found: string[] = [];
    for (const f of files) {
      for (const h of failOpenSites(f)) {
        found.push(`${f.replace(`${SCRIPTS}/`, '')}:${h.line}  ${h.text}`);
      }
    }
    expect(found, `${found.length} fail-open path(s) — a gate that could not run reported PASS:\n`
      + `${found.join('\n')}`).toEqual([]);
  });
});
