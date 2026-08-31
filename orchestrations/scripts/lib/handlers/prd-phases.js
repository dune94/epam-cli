#!/usr/bin/env node
/**
 * THE PHASES A PRD DECLARES, ONE PER LINE.
 *
 * The caller loops over these to run each phase of a codeline. An empty list means "this PRD
 * declares no phases", and the loop then does nothing — so this must never return empty for any
 * reason other than the PRD genuinely having none.
 *
 * IT DID. Extracted from an inline shell snippet, the body kept the shell's own placeholder:
 *
 *     require('./_read-input.js').readJsonOrRefuse('$1', 'the PRD', { expect: 'object' })
 *
 * `$1` was never substituted, so it tried to open a file literally named `$1`, threw, and the
 * caller's `2>/dev/null` swallowed it. Every parallel lane received an empty phase list, ran its
 * loop zero times, and reported `✓ completed` — in five seconds, having done nothing. Live
 * 2026-08-17, mock3: two lanes, two pending stories, no writer invoked, no commit, pipeline
 * reported success.
 *
 * The caller passed the path all along; the function it called dropped the argument.
 *
 *   argv[2]  the PRD to read; falls back to $PRD_FILE
 *   stdout   one phase id per line, in declared order
 *   exit 1   the PRD cannot be read or parsed — NOT an empty list, which reads as "no phases"
 */
'use strict';

const fs = require('fs');

const file = process.argv[2] || process.env.PRD_FILE || '';
if (!file) {
  process.stderr.write('[prd-phases] no PRD given: pass a path or set PRD_FILE\n');
  process.exit(1);
}

let prd;
try {
  prd = require('./_read-input.js').readJsonOrRefuse(file, 'the PRD', { expect: 'object' });
} catch (err) {
  // LOUD. A silent failure here is indistinguishable from a PRD with no phases, and the caller
  // treats that as "nothing to do" rather than "I could not tell".
  process.stderr.write(`[prd-phases] cannot read ${file}: ${err.message}\n`);
  process.exit(1);
}

const phases = Object.keys(prd.implementationOrder || {});
process.stdout.write(phases.length ? `${phases.join('\n')}\n` : '');
