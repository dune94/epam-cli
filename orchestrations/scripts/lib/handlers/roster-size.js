#!/usr/bin/env node
/**
 * HOW MANY AGENTS A MINTED ROSTER HOLDS.
 *
 * Guards the skip-the-mint path: skipping the mint with no roster on disk would hand every story
 * to an agent that was never defined.
 *
 *   argv[2]  a roster file — either {profiles:{…}} or a bare map of agents
 *   stdout   the count, or 0 when it cannot be read
 *
 * 0 on failure is what the caller wants: it treats <1 as "no roster" and refuses to continue,
 * naming both recovery routes. An unreadable roster and an empty one are the same problem here.
 *
 * Lifted out of run-agent-orchestration.sh on 2026-08-16.
 */
'use strict';

try {
  const r = require(require('path').resolve(process.argv[2]));
  process.stdout.write(String(Object.keys(r.profiles || r || {}).length));
} catch {
  process.stdout.write('0');
}
