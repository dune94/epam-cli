#!/usr/bin/env node
/**
 * A SEAM'S ENVIRONMENT, AS `env` ARGUMENTS.
 *
 * seamInvocationEnv returns an object. A shell call site needs KEY=VALUE words it can hand to
 * `env`, so a bash step can apply a seam without hand-copying the variable names — which is how a
 * call ends up applying three of five settings and looking wired.
 *
 *   argv[2]  the seam
 *   argv[3]  optional: the agents directory
 *   stdout   KEY=VALUE words, space-separated, safe to expand unquoted
 *
 * A seam that does not resolve prints NOTHING and says why on stderr, and exits non-zero. Silence
 * would leave the call running on ambient settings while appearing to have asked, which is the
 * failure this exists to end.
 *
 * A value containing whitespace is dropped rather than mangled: an env word cannot carry a space
 * unquoted, and half a value is worse than none.
 */
'use strict';

const path = require('path');

const seam = process.argv[2];
if (!seam) {
  process.stderr.write('[seam-env-args] usage: <seam> [agents-dir]\n');
  process.exit(1);
}

let env = {};
try {
  const { seamInvocationEnv } = require(path.join(__dirname, '..', 'seam-invocation.js'));
  env = seamInvocationEnv(seam, process.argv[3]) || {};
} catch (e) {
  process.stderr.write(`[seam-env-args] seam '${seam}' did not resolve: ${e.message}\n`);
  process.exit(1);
}

const words = [];
for (const [k, v] of Object.entries(env)) {
  const s = String(v);
  if (!s || /\s/.test(s)) continue;
  words.push(`${k}=${s}`);
}
process.stdout.write(words.join(' '));
