/**
 * EVERY CLOCK IN THE PIPELINE IS DECLARED, AND NONE OF THEM GOVERNS THE WORK.
 *
 * The story wall was raised to four hours and two stories were still killed at 600s, because the
 * wall is not the only clock. A deep sweep on 2026-09-22 found fourteen, of which three were
 * declared. The rest were literals at the point of use, several of them tiny and directly on the
 * story path:
 *
 *   EPAM_STORY_TIMEOUT_SECS also wraps EVERY writer attempt inside claude.sh (story-attempt.sh),
 *     so a project pin killed each attempt a second time — the "raw=0 bytes, exit 1" the
 *     coordinator then called an environment failure.
 *   EPAM_TIMEOUT_SECS:-240      one LLM call
 *   EPAM_PLAN_TIMEOUT_SECS:-90  plan mode, which runs INSIDE the attempt's budget
 *   MINIMAX_TOOL_TIMEOUT_MS:-15000   one tool call — a pytest run through a tool exceeds it
 *   EPAM_COMMIT_TIMEOUT_SECS:-60, install/dep/codegraph/assessment/coverage: 60–300s
 *
 * The operator's rule (2026-09-22): the clock is not the pipeline's governance. Every clock is
 * declared in config, every one is generous, and the script carries no number.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const DEFAULTS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.json'), 'utf8'));
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

/** Every clock the engine applies, with the config key that must declare it. */
const CLOCKS: Array<[string, string, number]> = [
  ['EPAM_STORY_TIMEOUT_SECS', 'storyTimeoutSecs', 3600],
  ['EPAM_GATE_TIMEOUT_SECS', 'gateTimeoutSecs', 1800],
  ['EPAM_TEST_TIMEOUT_SECS', 'testTimeoutSecs', 1800],
  ['EPAM_TIMEOUT_SECS', 'callTimeoutSecs', 1800],
  ['EPAM_PLAN_TIMEOUT_SECS', 'planTimeoutSecs', 900],
  ['PHASE_ASSESSMENT_TIMEOUT_SECS', 'phaseAssessmentTimeoutSecs', 1200],
  ['VC_COVERAGE_TIMEOUT_SECS', 'coverageTimeoutSecs', 1200],
  ['EPAM_DEP_HOOK_TIMEOUT_SECS', 'depHookTimeoutSecs', 1200],
  ['EPAM_INSTALL_TIMEOUT_SECS', 'installTimeoutSecs', 1200],
  ['EPAM_DEPENDENCY_INSTALL_TIMEOUT_SECS', 'dependencyInstallTimeoutSecs', 1200],
  ['EPAM_CODEGRAPH_REINDEX_TIMEOUT_SECS', 'codegraphReindexTimeoutSecs', 900],
  ['EPAM_COMMIT_TIMEOUT_SECS', 'commitTimeoutSecs', 300],
  ['MINIMAX_TOOL_TIMEOUT_MS', 'toolCallTimeoutMs', 600000],
];

describe('every clock is declared', () => {
  for (const [envVar, key, floor] of CLOCKS) {
    it(`${key} is declared and at least ${floor} (${envVar})`, () => {
      const v = Number(DEFAULTS.timeouts?.[key]);
      expect(v, `timeouts.${key} is not declared in llm-defaults.json`).toBeGreaterThan(0);
      expect(v, `timeouts.${key} is below the floor this pipeline needs`).toBeGreaterThanOrEqual(floor);
    });
  }
});

describe('no script decides a clock for itself', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh')).map((f) => join(SCRIPTS, f))
    .concat(readdirSync(join(SCRIPTS, 'lib')).filter((f) => f.endsWith('.sh')).map((f) => join(SCRIPTS, 'lib', f)));

  it('every timeout env var falls back to nothing, not to a number', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
      for (const m of src.matchAll(/([A-Z_]*TIMEOUT[A-Z_]*(?:_SECS|_MS)?):-(\d+)/g)) {
        // A literal is allowed only where it is the DECLARED value's own default in the loader.
        if (f.endsWith('model-ladder.sh')) continue;
        offenders.push(`${f.replace(ROOT + '/', '')}: ${m[1]}:-${m[2]}`);
      }
    }
    expect(offenders, `these scripts decide a clock instead of reading one:\n${offenders.join('\n')}`).toEqual([]);
  });
});
