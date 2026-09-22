/**
 * THE PROCESS THAT ENFORCES THE WALL KNOWS WHAT THE WALL IS.
 *
 * regintel 140717Z resume 6 (2026-09-22): the engine's declared walls were in place (4h per
 * attempt) and every story still logged
 *   "[orch] timeouts.secondsPerIteration is not configured — the story wall cannot be derived and
 *    stays at 600s"
 * because run-agent-orchestration.sh — the process that owns run_story_with_watchdog — never calls
 * load_llm_settings_json. claude.sh does, but that is the CHILD; the watchdog that kills the child
 * runs in the parent, where the declarations were never read. So the wall fell back to whatever the
 * environment happened to carry, and REGI-010-A was killed at 600s mid-fix.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

describe('the orchestrator loads the declarations the watchdog enforces', () => {
  it('calls load_llm_settings_json before any story runs', () => {
    // The MAIN file in runtime order (engineSource reassembles split modules in layout order,
    // which is not the order bash executes them): the settings must be loaded before the watchdog
    // that enforces them is even sourced.
    const src = readFileSync(ORCH, 'utf8');
    const at = src.indexOf('load_llm_settings_json');
    expect(at, 'the process that kills a story never read the walls it kills by').toBeGreaterThan(-1);
    const watchdog = src.indexOf('source "$SCRIPT_DIR/lib/story-watchdog.sh"');
    expect(watchdog).toBeGreaterThan(-1);
    expect(at, 'the settings are loaded after the watchdog is in place').toBeLessThan(watchdog);
  });

  it('with the settings loaded, the wall is derived — not the fallback', () => {
    // The real loader over the real engine defaults, in a project that declares no timeouts.
    const r = spawnSync('bash', ['-c', `
      set -uo pipefail
      AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"; PRD_FILE=/dev/null
      log(){ :; }; warning(){ :; }; error(){ :; }
      . "${join(ROOT, 'orchestrations/scripts/lib/model-ladder.sh')}"
      load_llm_settings_json
      echo "SPI=\${EPAM_SECONDS_PER_ITERATION:-unset}"
    `], { encoding: 'utf8', timeout: 60_000 });
    expect((r.stdout || '') + (r.stderr || '')).toMatch(/SPI=\d+/);
  });

  it('no project pins a story wall small enough to kill a story that reads before it writes', () => {
    // A project MAY override the engine's wall; it may not reinstate the 600s that killed
    // REGI-003b and REGI-010-A. The operator's instruction, 2026-09-22: the clock is not the
    // pipeline's governance.
    const { readdirSync, existsSync } = require('node:fs');
    const projects = join(ROOT, 'orchestrations/projects');
    const offenders: string[] = [];
    for (const p of readdirSync(projects)) {
      const f = join(projects, p, 'config.env');
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^EPAM_STORY_TIMEOUT_SECS=(\d+)/.exec(line.trim());
        if (m && Number(m[1]) < 3600) offenders.push(`${p}: ${m[1]}s`);
      }
    }
    expect(offenders, `these projects pin a wall below an hour: ${offenders.join(', ')}`).toEqual([]);
  });
});
