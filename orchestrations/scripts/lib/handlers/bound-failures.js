#!/usr/bin/env node
/**
 * bound-failures.js — HOW MUCH FAILURE TEXT AN AGENT CAN ACTUALLY BE HANDED.
 *
 * The FailureAnalyst's prompt embeds VERIFICATION_FAILURE whole. For a suite failure that is the
 * new-failure delta, which is small when the baseline works — and the ENTIRE suite output when it
 * does not. Live 2026-09-02 (AMSD-1919) that reached
 *
 *     "Prompt is too long · the request is ~1092054 tokens (limit 1000000)"
 *
 * on every attempt, and the ladder escalated claude-sonnet-5 -> claude-opus-4-8 -> claude-opus-5
 * against an input no model could accept. Escalation cannot fix arithmetic.
 *
 * TWO RULES, BOTH FROM DECLARATIONS THAT ALREADY EXIST:
 *
 *   THE WINDOW IS DECLARED  config/evidence-windows.json : failureExcerptLines. A literal here
 *                           would be a number nobody chose, which is what that file exists to stop.
 *
 *   ENTRIES ARE WHOLE       The project declares how one failure is recognised
 *                           (.epam/verification.json <section>.failurePattern, read by
 *                           verification-plugin.js). Text is cut only ON those boundaries — a
 *                           failure sliced in half tells the analyst something is wrong without
 *                           telling it what, which is the defect this is meant to prevent.
 *
 * What was dropped is always NAMED, so nothing goes missing silently.
 *
 *   node bound-failures.js <projectRoot> [section]     # failure text on stdin
 *
 * stdout  the bounded text
 * exit 0  always when it can read a window; the text is passed through unchanged if it fits
 * exit 1  no window declared — the caller must fail rather than invent a size
 */
'use strict';
const fs = require('fs');
const path = require('path');

function declaredWindow() {
  const file = process.env.EPAM_EVIDENCE_WINDOWS_FILE
    || path.join(__dirname, '..', '..', '..', 'config', 'evidence-windows.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = j && j.windows && j.windows.failureExcerptLines && j.windows.failureExcerptLines.value;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The line indices that START a failure, per the project's own declaration. */
function entryStarts(projectRoot, lines, section) {
  let pattern = '';
  try {
    const plugin = require(path.join(__dirname, '..', '..', '..', 'plugins', 'verification-plugin.js'));
    const m = plugin.readManifest ? plugin.readManifest(projectRoot, section) : null;
    const sec = m && m.ok && m.manifest && m.manifest[section];
    if (sec && typeof sec.failurePattern === 'string') pattern = sec.failurePattern;
  } catch { /* fall through */ }
  if (!pattern) return null;                       // undeclared: say nothing, bound nothing
  let re;
  try { re = new RegExp(pattern); } catch { return null; }
  const starts = [];
  lines.forEach((l, i) => { if (re.test(l)) starts.push(i); });
  return starts.length ? starts : null;
}

function bound(projectRoot, text, section, limit) {
  const lines = String(text).split('\n');
  if (lines.length <= limit) return text;

  const starts = entryStarts(projectRoot, lines, section);
  if (!starts) {
    // NO DECLARATION, NO ENTRY BOUNDARIES. Returning the text whole is the honest answer: a blind
    // cut is exactly the half-failure this exists to avoid, and the caller can still refuse.
    return text;
  }

  // keep whole entries while they fit
  let keptUntil = 0;
  let kept = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const end = (i + 1 < starts.length) ? starts[i + 1] : lines.length;
    if (end > limit) break;
    keptUntil = end;
    kept = i + 1;
  }
  // A SINGLE ENTRY BIGGER THAN THE WINDOW IS THE NORMAL CASE, NOT THE EDGE.
  //
  // This branch used to set keptUntil = lines.length — the WHOLE file — so one failing suite in a
  // large run was passed through untouched. That is precisely what production produces: live
  // 2026-09-02 (AMSD-1919) the suite reported "1 failed, 3359 passed" and this handler returned
  // 2,607,030 characters, giving the analyst a ~1,141,382-token prompt against a 1,000,000 limit.
  // It was never caught because the test used forty entries and never reached this branch.
  //
  // Here the entry genuinely cannot be kept whole. Cutting it is the lesser harm: an oversized
  // prompt cannot be answered by ANY model, so "whole entries or nothing" would choose nothing.
  // The cut is stated, so the analyst is never left guessing what it was not shown.
  let truncatedEntry = false;
  if (kept === 0) {
    keptUntil = Math.min(starts[0] + limit, lines.length);
    kept = 1;
    truncatedEntry = true;
  }
  const dropped = starts.length - kept;
  // FROM THE FIRST FAILURE, NOT FROM THE TOP. Everything before it is the runner's preamble and
  // the passing suites — thousands of lines of noise that crowded out the failure itself.
  const head = lines.slice(starts[0], keptUntil).join('\n').replace(/\s+$/, '');
  if (truncatedEntry) {
    const note = `\n\n[... this failure exceeds the declared window (failureExcerptLines in `
      + `config/evidence-windows.json) and was cut after ${limit} lines`
      + (dropped > 0 ? `; ${dropped} further failing entr${dropped === 1 ? 'y' : 'ies'} not shown` : '')
      + ']';
    return head + note;
  }
  if (dropped <= 0) return head;
  return `${head}\n\n[... ${dropped} further failing entr${dropped === 1 ? 'y' : 'ies'} not shown — `
    + `the window is declared as failureExcerptLines in config/evidence-windows.json]`;
}

function main() {
  const [root, section] = process.argv.slice(2);
  if (!root) {
    process.stderr.write('[bound-failures] usage: <projectRoot> [section]\n');
    return 2;
  }
  const limit = declaredWindow();
  if (limit === null) {
    process.stderr.write('[bound-failures] failureExcerptLines is not declared in '
      + 'config/evidence-windows.json — refusing to invent a size\n');
    return 1;
  }
  const text = fs.readFileSync(0, 'utf8');
  process.stdout.write(bound(root, text, section || 'test', limit));
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { bound, declaredWindow };
