#!/usr/bin/env node
/**
 * tool-timeouts.js — HOW LONG A LOCAL TOOL MAY TAKE, FROM ONE DECLARATION.
 *
 * Thirteen subprocess timeouts lived as literals across seven libraries. Each was an
 * independent decision with no single home: a codeline big enough to need longer got a
 * truncated answer from whichever tool hit its cap first, the caller could not tell a timeout
 * from an empty result, and raising one meant finding all of them.
 *
 * These bound LOCAL tools only. A model call is bounded by its seam's declared timeoutSecs —
 * a different decision, made in a different place, on purpose.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function declarationPath() {
  return process.env.EPAM_TOOL_TIMEOUTS
    || path.join(__dirname, '..', '..', 'config', 'tool-timeouts.json');
}

/**
 * toolTimeoutMs(name) — the declared cap for a kind of work.
 *
 * REFUSES an undeclared name rather than returning a default. A fallback would put the decision
 * back in code, which is exactly where it came from: the caller would get a plausible number
 * that no one chose, and nothing would say so.
 */
function toolTimeoutMs(name) {
  let tools;
  try {
    tools = JSON.parse(fs.readFileSync(declarationPath(), 'utf8')).tools || {};
  } catch (e) {
    throw new Error(`[tool-timeouts] cannot read ${declarationPath()}: ${e && e.message}`);
  }
  const v = tools[name];
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(
      `[tool-timeouts] '${name}' is not declared in ${declarationPath()}. Declare it beside the `
      + 'others rather than passing a number here — a literal at a call site is a second home.');
  }
  return v;
}

module.exports = { toolTimeoutMs, declarationPath };
