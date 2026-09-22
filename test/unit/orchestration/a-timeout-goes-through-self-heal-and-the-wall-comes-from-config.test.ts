/**
 * SELF-HEAL IS NOT OVERRIDDEN BY THE CLOCK, AND THE CLOCK IS NOT A LITERAL.
 *
 * regintel 140717Z resume 5 (2026-09-22): REGI-003b — the last incomplete story of a run whose
 * other fourteen were done — timed out at 600s, then at 900s, and the watchdog marked it
 * "watchdog_timeout: story exceeded timeout twice and was skipped", failing the phase. Three
 * architectural faults, none of them the model:
 *
 *   1. THE ANALYST NEVER RAN. A timeout ends at `return 1` — run_failure_analyst is reached only
 *      from story-attempt's own failure paths. Six attempts across two resumes produced no
 *      diagnosis, no guidance, no healing record: every attempt started as uninformed as the last.
 *      Self-heal is the pipeline's answer to a failing execution; a clock must not be able to
 *      cancel it.
 *   2. THE WALL WAS A LITERAL. The tiers fell back to `600/1200/2400/900` written in the script,
 *      because the loader read timeouts from the PROJECT's llm-settings.json only and regintel
 *      declares none — the run logged "timeouts.secondsPerIteration is not configured" on every
 *      story. An engine default that every project inherits is the contract everywhere else here.
 *   3. THE WALL WAS SMALL. 600s for a story that had to read an existing 369-line test file and
 *      reconcile it against 17 ground-truth facts, with plan mode inside the same budget.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const WATCHDOG = join(SCRIPTS, 'lib/story-watchdog.sh');
const DEFAULTS = join(ROOT, 'orchestrations/config/llm-defaults.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the story wall is declared, not written into the script', () => {
  const cfg = JSON.parse(readFileSync(DEFAULTS, 'utf8'));

  it('the engine declares the timeouts every project inherits', () => {
    expect(cfg.timeouts, 'no engine default: a project that declares no timeouts falls back to literals').toBeTruthy();
    for (const k of ['storyTimeoutSecs', 'storyTimeoutMaxSecs', 'secondsPerIteration', 'perAttemptOverheadSecs', 'storyWallMaxSecs', 'gateTimeoutSecs', 'testTimeoutSecs']) {
      expect(Number(cfg.timeouts[k]), `${k} is not declared`).toBeGreaterThan(0);
    }
    expect(cfg.timeouts.storyEffortTimeoutSecs, 'the per-effort tiers are not declared').toBeTruthy();
  });

  it('the declared walls are large enough for a story that must read before it writes', () => {
    // 003b died at 600s having read a 369-line file and planned. The engine's floor is now
    // measured against that story, not against the cheapest one.
    expect(Number(cfg.timeouts.storyTimeoutSecs)).toBeGreaterThanOrEqual(1800);
    expect(Number(cfg.timeouts.storyEffortTimeoutSecs.low)).toBeGreaterThanOrEqual(1200);
    expect(Number(cfg.timeouts.storyWallMaxSecs)).toBeGreaterThanOrEqual(10800);
  });

  it('the watchdog carries no timeout literal — every tier comes from the declaration', () => {
    const src = readFileSync(WATCHDOG, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const literals = [...src.matchAll(/EPAM_STORY_EFFORT_TIMEOUT_[A-Z]+_SECS:-(\d+)/g)].map((m) => m[1]);
    expect(literals, `the script still decides the wall: ${literals.join(', ')}`).toEqual([]);
  });

  it('a project with no timeouts block inherits the engine default (regintel\'s shape)', () => {
    const d = mkdtempSync(join(tmpdir(), 'wall-cfg-')); dirs.push(d);
    writeFileSync(join(d, 'llm-settings.json'), JSON.stringify({ ladders: {} }));
    const r = spawnSync('bash', ['-c', `
      set -uo pipefail
      AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"; EPAM_PROJECT_CONFIG_DIR="${d}"; PRD_FILE=/dev/null
      log(){ :; }; warning(){ :; }; error(){ :; }
      . "${join(SCRIPTS, 'lib/model-ladder.sh')}"
      load_llm_settings_json
      echo "SPI=\${EPAM_SECONDS_PER_ITERATION:-unset} STORY=\${EPAM_STORY_TIMEOUT_SECS:-unset} LOW=\${EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS:-unset} WALL=\${EPAM_STORY_WALL_MAX_SECS:-unset}"
    `], { encoding: 'utf8', timeout: 60_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out, out.slice(-500)).toMatch(/SPI=\d+ STORY=\d+ LOW=\d+ WALL=\d+/);
  });
});

describe('a timed-out story reaches the analyst before anything calls it failed', () => {
  function timeoutRun() {
    const d = mkdtempSync(join(tmpdir(), 'wd-heal-')); dirs.push(d);
    const logDir = join(d, 'logs'); mkdirSync(logDir);
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', effort: 'medium', model: 'MiniMax-M3', ladderTier: 'medium', status: 'in-progress' }] }));
    const stub = join(d, 'claude.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\nsleep 30\n'); chmodSync(stub, 0o755);
    const analystLog = join(d, 'analyst.log');
    const script = `
      set -uo pipefail
      SCRIPT_DIR="${SCRIPTS}"; LOG_DIR="${logDir}"; PRD_FILE="${prd}"; MAIN_PRD_FILE="${prd}"; CLAUDE_SH="${stub}"
      EPAM_STORY_TIMEOUT_SECS=1; EPAM_MAX_RETRIES=7; EPAM_MAX_LADDER_ATTEMPTS=2; PHASE=core
      log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; info(){ :; }; success(){ :; }
      update_monitor_status(){ :; }
      run_failure_analyst(){ printf 'ANALYST story=%s retry=%s\\n' "$1" "\${3:-}" >> "${analystLog}"; return 0; }
      . "$SCRIPT_DIR/lib/story-retry-state.sh"
      . "$SCRIPT_DIR/lib/story-watchdog.sh"
      write_story_retry_count "$LOG_DIR" S-1 0
      run_story_with_watchdog S-1 "${logDir}/main-S-1.log"; echo "RC=$?"
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 180_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const analyst = existsSync(analystLog) ? readFileSync(analystLog, 'utf8').trim() : '';
    const prdAfter = JSON.parse(readFileSync(prd, 'utf8'));
    return { out, analyst, status: prdAfter.stories[0].status };
  }
  const r = timeoutRun();

  it('the timeout actually happened — otherwise nothing below is tested', () => {
    expect(r.out, r.out.slice(-800)).toMatch(/timed out/);
  });

  it('the analyst diagnosed it — a clock does not cancel self-heal', () => {
    expect(r.analyst, `run_failure_analyst was never called for a timed-out story:\n${r.out.slice(-1200)}`).toMatch(/ANALYST story=S-1/);
  });

  it('the healing record says the timeout was diagnosed, not merely skipped', () => {
    expect(r.out).toMatch(/self-heal|analyst/i);
  });
});
