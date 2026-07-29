/**
 * A caller that sets LOG_DIR must get the LOG_DIR it set.
 *
 * Parallel lanes give each codeline its own LOG_DIR so that files read back as
 * STATE — phase-baseline-sha.txt above all — cannot leak between lanes. Live
 * metrolinx 2026-07-29 proved the wiring alone is not enough:
 *
 *   env of each running lane:  LOG_DIR=.../logs/lanes/nextgotransitcom
 *   contents of that directory: 0 files
 *   everything written instead: .../orchestrations/logs   (shared, as before)
 *
 * The loop passed the right value and the script threw it away, because line
 * ~151 assigned unconditionally:
 *
 *   LOG_DIR="$AUTOMATION_DIR/logs"
 *
 * WHY THIS FILE EXISTS AT ALL. There was already a test for lane isolation, and
 * it passed while the isolation did not work. It asserted the value the loop
 * HANDS to a stub — the stub echoed $LOG_DIR back — so it verified what the
 * caller passes and never what the real script does with it. Passing a variable
 * to a program that ignores it is indistinguishable, from the caller's side,
 * from passing it to one that honours it. The only way to tell is to execute the
 * receiving code, which is what the tests below do: they run the ACTUAL
 * assignment lifted from the script, not a description of it.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

/**
 * Top-level LOG_DIR ASSIGNMENTS only.
 *
 * Column 0 and no trailing backslash: an indented `LOG_DIR="$x" \` is an
 * environment prefix on a command — it scopes one invocation and does not
 * rebind the script's own variable. Counting those as assignments made the
 * first draft of this file report four violations, three of which were the
 * parallel lane loop correctly passing LOG_DIR to its children.
 */
function logDirAssignments(): string[] {
  return SRC.split('\n').filter((l) => /^LOG_DIR=/.test(l) && !/\\\s*$/.test(l));
}

/**
 * Execute the REAL assignment with a given inherited environment and report what
 * LOG_DIR ends up as. This is the whole point: the statement runs, rather than
 * being matched against a pattern.
 */
function resolveLogDir(inherited?: string): string {
  const assignments = logDirAssignments();
  expect(assignments.length, 'no top-level LOG_DIR assignment found').toBeGreaterThan(0);
  const script = [
    '#!/usr/bin/env bash',
    'AUTOMATION_DIR=/fake/automation',
    ...assignments,
    'echo "RESOLVED=$LOG_DIR"',
  ].join('\n');
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (inherited === undefined) delete env.LOG_DIR;
  else env.LOG_DIR = inherited;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 30000 });
  const m = `${r.stdout || ''}`.match(/RESOLVED=(.*)/);
  return m ? m[1].trim() : '';
}

describe('LOG_DIR is inherited when the caller sets it', () => {
  it('honours an inherited LOG_DIR — the parallel-lane requirement', () => {
    const lane = '/tmp/epam-test-lane/nextgotransitcom';
    expect(resolveLogDir(lane),
      'the script overwrites the caller\'s LOG_DIR, so every lane writes to the ' +
      'shared directory and phase-baseline-sha.txt collides across codelines — ' +
      'gates then diff against a SHA absent from their own repository')
      .toBe(lane);
  });

  it('still defaults to the automation logs directory when unset', () => {
    // The default must not regress: the nginx-served dashboard reads this path,
    // and every non-lane invocation relies on it.
    expect(resolveLogDir(undefined)).toBe('/fake/automation/logs');
  });

  it('treats an empty LOG_DIR as unset rather than writing to the filesystem root', () => {
    expect(resolveLogDir('')).toBe('/fake/automation/logs');
  });
});

describe('nothing later re-clobbers it', () => {
  it('has no unconditional top-level LOG_DIR assignment', () => {
    // A second `LOG_DIR="$AUTOMATION_DIR/logs"` anywhere below would silently
    // restore the bug while the test above still passed, because that test only
    // executes the assignments it can see at top level.
    const unconditional = logDirAssignments()
      .filter((l) => !/LOG_DIR="?\$\{LOG_DIR:-/.test(l));
    expect(unconditional,
      `these overwrite an inherited LOG_DIR: ${unconditional.join(' | ')}`)
      .toEqual([]);
  });
});
