/**
 * A RESET THAT COULD NOT CLEAN MUST STOP THE LAUNCH. IT MUST NOT BE AN INFO LINE.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Operator, 2026-08-12: "I need a 100% guarantee it will not break future pipeline runs."
 * The honest answer was NO, and this is why.
 *
 * pre-run-reset.sh detects contamination and calls fail(), which exits 1. Every one of the five
 * launchers then invokes it like this:
 *
 *     bash orchestrations/scripts/pre-run-reset.sh --prd "$PRD_FILE" || \
 *       info "  pre-run-reset.sh failed or Docker unavailable — dashboard may show stale data
 *             (non-fatal, continuing)"
 *
 * `|| info` SWALLOWS THE EXIT CODE AND THE RUN PROCEEDS. So the sweeps added for review
 * feedback, ladder state and agent KB can each detect a previous run's state, shout about it,
 * and be ignored — the run starts contaminated anyway, having printed a line saying the
 * dashboard might look stale.
 *
 * The `|| info` is not stupid: a Docker-down box genuinely should not block a run over a
 * dashboard mount. The defect is that ONE exit code carries two unrelated meanings —
 * "the dashboard is unavailable" and "this run would start on another run's state" — so the
 * launcher cannot distinguish a cosmetic failure from a fatal one, and treats both as cosmetic.
 *
 * THE RULE: contamination exits with its OWN code (9). No launcher may swallow it. Everything
 * else stays non-fatal exactly as before.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GATE = join(SCRIPTS, 'lib/pre-run-reset-gate.sh');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) { try { chmodSync(d, 0o755); } catch { /* best effort */ } rmSync(d, { recursive: true, force: true }); }
});

/** Run the launcher-side gate against a stub reset that exits with a chosen code. */
function gate(resetExit: number): { status: number | null; out: string } {
  const d = mkdtempSync(join(tmpdir(), 'resetgate-')); dirs.push(d);
  const stub = join(d, 'pre-run-reset.sh');
  // THE STUB MUST FINISH ITS STATE WORK, BECAUSE THAT IS WHAT IT IS SIMULATING.
  //
  // This wrote a reset that exited with a code and NOTHING else. That is not a reset with a
  // dead dashboard — it is a reset that did nothing at all, and the two were indistinguishable
  // to the gate. Live, 2026-08-14: the real reset died at line ~386 of 555 (a count of a
  // directory its own rm had removed, turned fatal by pipefail), the gate called it
  // "(dashboard/environment, not state) — non-fatal, continuing", and the next run inherited
  // 12/12 attempts and died in 18 seconds having called no model.
  //
  // The gate now requires the completion sentinel the reset emits after its LAST state step.
  // A dashboard failure happens with that work already done, so the sentinel is present and
  // the launch proceeds — which is exactly the rule this suite exists to protect. The
  // died-early case is covered in the-reset-must-finish-what-it-started.test.ts.
  writeFileSync(stub, `#!/usr/bin/env bash\necho PRE_RUN_RESET_STATE_CLEARED\nexit ${resetExit}\n`);
  chmodSync(stub, 0o755);

  const r = spawnSync('bash', ['-c', [
    "info() { echo \"INFO: $*\"; }", "warning() { echo \"WARN: $*\"; }", "error() { echo \"ERR: $*\"; }",
    `PRE_RUN_RESET_SCRIPT='${stub}'`,
    `. '${GATE}'`,
    "pre_run_reset_or_abort --prd /dev/null",
    'echo "REACHED_THE_RUN"',
  ].join('\n')], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('the gate exists at all', () => {
  it('there is a single shared gate, not five copies of the same || info', () => {
    // Operator's standing rule: single point of maintenance, never more than 1. Five launchers
    // each hand-rolling the check is how one of them ends up swallowing exit 9 next month.
    expect(() => readFileSync(GATE, 'utf8'), 'no shared pre-run-reset gate').not.toThrow();
  });
});

describe('CONTAMINATION STOPS THE LAUNCH', () => {
  it('exit 9 aborts — the run is never reached', () => {
    const r = gate(9);
    expect(r.out, 'THE RUN STARTED ON A PREVIOUS RUN\'S STATE').not.toContain('REACHED_THE_RUN');
    expect(r.status, 'a contaminated launch must exit non-zero').not.toBe(0);
  });

  it('and it says why, in words naming contamination', () => {
    expect(gate(9).out).toMatch(/contaminat|previous run/i);
  });
});

describe('EVERYTHING ELSE STAYS NON-FATAL, EXACTLY AS BEFORE', () => {
  it('a clean reset proceeds', () => {
    const r = gate(0);
    expect(r.out).toContain('REACHED_THE_RUN');
    expect(r.status).toBe(0);
  });

  it('a Docker/dashboard failure (exit 1) still proceeds — this is deliberate', () => {
    // Regression guard in the other direction: making ALL failures fatal would block runs on a
    // box with no Docker, which is why the || info was written in the first place.
    const r = gate(1);
    expect(r.out, 'a dashboard problem must not block a run').toContain('REACHED_THE_RUN');
  });
});

describe('THE RESET ACTUALLY EMITS 9 WHEN IT CANNOT CLEAN', () => {
  it('an undeletable run artifact produces exit 9, not exit 1', () => {
    const d = mkdtempSync(join(tmpdir(), 'undeletable-')); dirs.push(d);
    writeFileSync(join(d, 'review-feedback-AMSD-2041.json'), '{}');
    chmodSync(d, 0o555); // read+execute only: the file cannot be unlinked

    const src = readFileSync(join(SCRIPTS, 'pre-run-reset.sh'), 'utf8');
    const start = src.indexOf('_RUN_ARTIFACT_DIR=');
    const block = src.slice(start, src.indexOf('\nfi\n', start) + 4);
    const r = spawnSync('bash', ['-c', [
      "info() { :; }", "success() { :; }",
      `. '${join(SCRIPTS, 'lib/contamination-exit.sh')}'`,
      `LOG_DIR='${d}'`, block,
    ].join('\n')], { encoding: 'utf8' });

    expect(readdirSync(d), 'the harness is vacuous — the file was deletable after all')
      .toContain('review-feedback-AMSD-2041.json');
    expect(r.status, 'contamination exited with a code launchers are allowed to swallow').toBe(9);
  });
});

describe('NO LAUNCHER SWALLOWS IT', () => {
  const launchers = readdirSync(SCRIPTS)
    .filter((f) => /^(tier3-.*|orchestrate|mock1-paused-run)\.sh$/.test(f));

  it('every launcher that resets goes through the gate', () => {
    expect(launchers.length, 'no launchers found — the glob is stale').toBeGreaterThan(3);
    for (const f of launchers) {
      const s = readFileSync(join(SCRIPTS, f), 'utf8');
      const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      if (!/pre-run-reset\.sh/.test(code)) continue;
      expect(code, `${f} invokes the reset directly and swallows its exit code with || info`)
        .not.toMatch(/pre-run-reset\.sh[^\n]*\|\|\s*\\?\s*\n?\s*info/);
      expect(code, `${f} does not use the shared gate`).toMatch(/pre_run_reset_or_abort/);
    }
  });
});
