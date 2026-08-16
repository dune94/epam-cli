#!/usr/bin/env node
/**
 * THE LADDER POSITION AN AGENT'S SEAM DECLARES.
 *
 * Resolves the agent to its seam through the registry, then reads that seam's `ladder` — base, mid
 * or top. The engine holds no tier vocabulary of its own; the position is resolved against the
 * project's declared tier order elsewhere.
 *
 *   argv[2]  lib/seam-invocation.js
 *   argv[3]  the invocation-profiles registry
 *   argv[4]  the agent name
 *   stdout   the declared position, or empty
 *
 * Empty on failure, deliberately: the caller treats "no declared position" and "could not resolve"
 * the same way — it applies no ladder — and seam-invocation already warns loudly at the invocation
 * itself when a declared position resolves to nothing.
 *
 * Lifted out of run-agent-orchestration.sh on 2026-08-16.
 */
'use strict';

try {
  const { resolveSeam } = require(process.argv[2]);
  const registry = process.argv[3];
  const seam = resolveSeam(process.argv[4], registry);
  const profile = JSON.parse(require('fs').readFileSync(registry, 'utf8')).profiles[seam] || {};
  process.stdout.write(String(profile.ladder || ''));
} catch {
  process.stdout.write('');
}
