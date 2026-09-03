/**
 * A PAUSE THAT PRINTS AND CONTINUES IS NOT A PAUSE.
 *
 * pause 1 ended in `return 0` under a comment reading "END the run". `return` leaves the FUNCTION;
 * the caller carries on. On the ingesting path the call was the last thing before an exit, so it
 * halted by accident and looked correct for as long as nobody called it from anywhere else — and on
 * 2026-08-28 something did.
 *
 * Live, on a PAID run: the banner printed with its resume instructions, the operator was told the
 * run had stopped, and it went straight into the spec pass and was making model calls when it was
 * killed by hand. Every earlier test asserted the banner and the checkpoint — the two things that
 * DID work — and none asserted that anything stopped. A gate must have its verdict READ.
 *
 * Both pauses are checked here, together, because the fault was that they differed and nothing said
 * so: pause 2 has always used exit.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
const AFTER = 'REACHED-THE-WORK-THE-PAUSE-WAS-MEANT-TO-PRECEDE';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real pause-1 function, lifted from the script. */
function pauseOneFn(): string {
  const at = ORCH.indexOf('_pause_after_agent_mint() {');
  expect(at, 'the pause-1 function is gone').toBeGreaterThan(-1);
  return ORCH.slice(at, ORCH.indexOf('\n}\n', at) + 3);
}

function runPause(env: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'pause-halt-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir, { recursive: true });
  const sh = join(d, 'run.sh');
  const stubs = [
    '#!/usr/bin/env bash',
    'info(){ echo "[info] $*"; }', 'warning(){ echo "[warn] $*"; }',
    'save_run_checkpoint(){ echo "ckpt"; }',
    'is_truthy(){ case "$(printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]")" in 1|true|yes|on) return 0;; *) return 1;; esac; }',
    'should_pause_after_agent_mint(){ is_truthy "${EPAM_PAUSE_AFTER_AGENT_MINT:-}"; }',
    `GREEN=""; RED=""; NC=""; LOG_DIR=${JSON.stringify(logDir)}; EPAM_AGENTS_DIR=${JSON.stringify(d)};`,
    'ORCH_RUN_ID="TEST-RUN"; PHASE="core";',
    pauseOneFn(),
    '_pause_after_agent_mint',
    `echo "${AFTER}"`,
  ].join('\n');
  writeFileSync(sh, `${stubs}\n`);
  const r = spawnSync('bash', [sh], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  return (r.stdout || '') + (r.stderr || '');
}

describe('PAUSE 1 STOPS THE RUN, NOT JUST THE FUNCTION', () => {
  it('announces the pause', () => {
    expect(runPause({ EPAM_PAUSE_AFTER_AGENT_MINT: '1' })).toMatch(/spec NOT started/);
  });

  it('and nothing after it runs', () => {
    expect(runPause({ EPAM_PAUSE_AFTER_AGENT_MINT: '1' }),
      'the run continued past the pause it had just announced — the operator is told it stopped '
      + 'while it goes on spending')
      .not.toContain(AFTER);
  });

  it('while an unpaused run carries on exactly as before', () => {
    expect(runPause({ EPAM_PAUSE_AFTER_AGENT_MINT: '' })).toContain(AFTER);
  });
});

describe('BOTH PAUSES HALT THE SAME WAY', () => {
  // The fault was that they DIFFERED and nothing said so. Read from the script rather than
  // asserted about one of them, so a third pause added later is held to the same rule.
  it('the first thing a pause does after announcing itself is exit', () => {
    // Sliced on `fi` this misreads: the two blocks nest at different depths. The rule that actually
    // holds is about ORDER — once a pause has told the operator the run stopped, the next statement
    // that ends control flow must end the RUN. `return` there is the 2026-08-28 defect exactly.
    const offenders: string[] = [];
    for (const marker of ['spec NOT started', 'writer NOT started']) {
      const at = ORCH.indexOf(marker);
      expect(at, `the pause announcing "${marker}" is gone`).toBeGreaterThan(-1);
      const rest = ORCH.slice(at).split('\n');
      const first = rest.find((l) => /^\s*(exit|return)\b/.test(l.replace(/#.*/, '')));
      if (!first || !/^\s*exit\b/.test(first)) offenders.push(`${marker} -> ${first?.trim() ?? 'nothing'}`);
    }
    expect(offenders, 'a pause that returns instead of exiting halts only its own function')
      .toEqual([]);
  });
});

describe('A PAUSE GUARDS EVERY WAY INTO THE WORK IT PRECEDES', () => {
  // Pause 1 did not fail because its own code was wrong — the banner, the checkpoint and the resume
  // instructions were all correct. It failed because the mint had TWO call sites and the pause was
  // wired into one. This asserts the shape that made that possible, so the next second call site is
  // caught here rather than on a paid run.

  it('the writer starts in one place, and the pause guard comes before it', () => {
    const lines = ORCH.split('\n');
    const guard = lines.findIndex((l) => /should_pause_before_writer/.test(l) && !/^\s*#/.test(l)
      && !/\(\)\s*\{/.test(l));
    expect(guard, 'the pause-2 guard is gone').toBeGreaterThan(-1);

    // Recovery re-runs a story that already started, so it is downstream of the pause by
    // construction; it is the FRESH launches that must sit behind the guard.
    const recovery = lines.findIndex((l) => /^run_story_recovery_analyst\(\)/.test(l));
    const recoveryEnd = lines.findIndex((l, i) => i > recovery && /^\}/.test(l));

    const unguarded = lines
      .map((l, i) => ({ l, i }))
      // `\b` alone also matches `run_story_with_watchdog() {` — the DEFINITION, which is not a
      // launch. Require an argument after the name.
      .filter(({ l }) => /^\s*(if\s+!?\s*)?run_story_with_watchdog\s+\S/.test(l))
      .filter(({ i }) => !(i > recovery && i < recoveryEnd))
      .filter(({ i }) => i < guard)
      .map(({ l, i }) => `line ${i + 1}: ${l.trim()}`);

    expect(unguarded, 'a writer launch that the pause-before-writer check cannot reach — this is '
      + 'exactly how pause 1 came to print "paused" while the run carried on').toEqual([]);
  });

  it('and pause 2 writes its checkpoint BEFORE it exits', () => {
    // An exit that leaves nothing to resume from is a crash with better manners.
    const guard = ORCH.indexOf('should_pause_before_writer;');
    const before = ORCH.slice(0, guard);
    expect(before.lastIndexOf('save_run_checkpoint "$PHASE" pre-writer'),
      'pause 2 exits without having saved the checkpoint its own banner points the operator at')
      .toBeGreaterThan(guard - 1200);
  });
});
