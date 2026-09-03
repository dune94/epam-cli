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

// A CORRUPT ROSTER IS NOT AN EMPTY ONE. This caught everything and wrote '0' — so a file that
// could not be read, or was half-written by a step that died, answered exactly like a roster with
// no agents in it. This guard exists to stop the mint being skipped when no roster is on disk;
// answering 0 for an unreadable one waves through the case it was written to catch.
const { readJsonOrRefuse } = require('./_read-input.js');
const r = readJsonOrRefuse(process.argv[2], 'the minted roster');
process.stdout.write(String(Object.keys((r && r.profiles) || r || {}).length));
