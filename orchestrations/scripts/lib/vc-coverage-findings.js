'use strict';
/**
 * Render the criteria that shipped WITHOUT a test, for whichever agent is being prompted.
 *
 * vc-coverage-check.sh compares every verification criterion against the tests a story actually
 * produced and writes $LOG_DIR/vc-coverage-<story>.json. Nothing read that file. Live 2026-08-11
 * (AMSD-2041/gotransit) it recorded two findings that decided whether the feature worked, and
 * neither the writer nor the reviewer was ever told:
 *
 *   "No test asserts that draft content values are actually displayed when live preview
 *    parameters are present."  — the feature's entire purpose, unverified.
 *
 *   "The test re-implements shouldForwardLivePreview locally rather than importing the real
 *    production function, so its assertions would pass even if the actual implementation
 *    violated the requirement."  — a test that cannot fail for the right reason.
 *
 * A check whose output nothing consumes is not a check; it is a log line with extra steps.
 *
 * CONTRACT
 *   - Prints the block, or NOTHING when there is nothing to say.
 *   - Exit 0 always. A prompt builder must not fail because a coverage artifact is absent or
 *     malformed — the agent still has work to do.
 *   - ABSENT IS NOT CLEAN. No artifact renders nothing at all; it never emits an all-clear.
 *     "The check did not run" and "the check passed" are different states, and collapsing them
 *     is the fail-open this pipeline keeps rediscovering.
 *   - Covered criteria are omitted. Reporting satisfied ones buries the rest.
 *
 * The WORDING lives in the project catalog (agent-contract.json → uncoveredCriteria), so it can
 * be tuned or translated without touching code. This file contributes the data and no prose.
 *
 * Usage:  node vc-coverage-findings.js <logDir> <storyId> [contractPath]
 */

const fs = require('node:fs');
const path = require('node:path');

/** The uncovered entries, in artifact order. Anything unreadable yields none. */
function uncovered(logDir, storyId) {
  const file = path.join(String(logDir || ''), `vc-coverage-${String(storyId || '')}.json`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((f) => f && f.covered === false && typeof f.vc === 'string' && f.vc.trim());
}

/** One line per finding: the criterion, then why nothing covers it. */
function asList(items) {
  return items
    .map((f) => {
      const why = typeof f.why === 'string' && f.why.trim() ? `\n    ${f.why.trim()}` : '';
      return `  - ${f.vc.trim()}${why}`;
    })
    .join('\n');
}

function main() {
  const [, , logDir, storyId, contractPath] = process.argv;
  const items = uncovered(logDir, storyId);
  if (!items.length) process.exit(0);

  const list = asList(items);
  const contract = contractPath || path.join(__dirname, '..', '..', 'config', 'agent-contract.json');

  // The renderer already knows how to fill {placeholders} from a project-owned catalog, and is
  // the same one the constitution and surgeon rules go through.
  const render = path.join(__dirname, 'render-prompt-section.js');
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, [render, contract, 'uncoveredCriteria', `findings=${list}`], {
      encoding: 'utf8',
    });
    if (out && out.trim()) { process.stdout.write(out); process.exit(0); }
  } catch { /* fall through */ }

  // NO BUILT-IN SENTENCE. A project with no uncoveredCriteria section gets the bare data — which
  // is honest and visibly bare — rather than wording compiled into the engine. A fallback
  // sentence is the hardcoding with a branch in front of it.
  process.stdout.write(list);
  process.exit(0);
}

module.exports = { uncovered, asList };

if (require.main === module) main();
