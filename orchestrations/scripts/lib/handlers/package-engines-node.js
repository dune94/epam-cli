#!/usr/bin/env node
/**
 * THE NODE VERSION A package.json REQUIRES, IF IT SAYS.
 *
 * Read before choosing an interpreter: a project that declares an engines.node range gets that
 * version resolved through fnm rather than whatever `node` happens to be on PATH.
 *
 *   argv[2]  a package.json
 *   stdout   the engines.node value, or empty when there is none
 *
 * Empty is the honest answer for "no requirement declared", and the caller reads it that way —
 * it falls back to detection. An unreadable or absent file is the same answer for the same
 * reason: it declares no requirement. This is the one place where quiet is correct, because the
 * caller has a real fallback and the value is advisory.
 *
 * Lifted out of run-agent-orchestration.sh on 2026-08-16.
 */
'use strict';

try {
  const p = require(require('path').resolve(process.argv[2]));
  process.stdout.write((p.engines && p.engines.node) || '');
} catch {
  process.stdout.write('');
}
