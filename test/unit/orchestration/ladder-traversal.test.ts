/**
 * The configured ladder must be traversable. Today it is not.
 *
 * `run_story_with_watchdog` grants a story TWO attempts: the first, then one
 * retry after a hot-swap. A hot-swap only happens ON a timeout, so at most ONE
 * escalation can ever occur.
 *
 * The HIGH ladder is four rungs:
 *     MiniMax-M2.5 -> MiniMax-M3 -> z-ai/glm-5.1 -> moonshotai/kimi-k3
 *
 * so anything above the second rung is unreachable BY CONSTRUCTION, and
 * EPAM_FINAL_FALLBACK_MODEL=moonshotai/kimi-k3 can never be used from this path.
 * The code even names a case it cannot reach — hot_swap logs "top-of-ladder
 * fallback" when it lands on the final model.
 *
 * Live AMSD-2041 2026-07-29: three lanes, every one stopped after a single
 * hot-swap (2x MiniMax-M3 -> glm-5.1, 1x -> glm-5.2), and kimi-k3 appears zero
 * times in the run log or any lane log.
 *
 * THE RULE: an escalation is not a replacement. Climbing to a new rung must not
 * consume the story's last attempt — otherwise "escalate" means "swap the model
 * and give up". Attempts therefore continue while the ladder still has a NEW
 * rung to offer, bounded by EPAM_MAX_LADDER_ATTEMPTS so a mis-configured ladder
 * cannot loop forever.
 *
 * Retrying the SAME model is explicitly not covered by this: when the swap
 * yields no new model the ladder is exhausted and stopping is correct — the
 * codebase already calls that "the same gamble".
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/**
 * Run the real watchdog with a story runner that always times out (124) and a
 * hot-swap that walks a finite ladder. Returns how many attempts were made and
 * which models were used.
 */
function traverse(rungs: string[], env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ladder-'));
  dirs.push(d);
  const attempts = join(d, 'attempts.txt');
  const rungFile = join(d, 'rung.txt');
  writeFileSync(rungFile, '0');

  // The story runner: records the attempt and always times out.
  const runner = join(d, 'claude-stub.sh');
  writeFileSync(runner, `#!/usr/bin/env bash
echo "$(cat ${JSON.stringify(rungFile)})" >> ${JSON.stringify(attempts)}
exit 124
`);
  spawnSync('chmod', ['+x', runner]);

  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
CLAUDE_SH=${JSON.stringify(runner)}
LOG_DIR=${JSON.stringify(d)}
PHASE=core
log(){ :; }; info(){ :; }; success(){ :; }
warning(){ echo "WARN: $*"; }
error(){ echo "ERROR: $*"; }
resolve_role_timeout_multiplier(){ echo 1; }
record_story_failure(){ :; }
wait_if_paused(){ :; }
update_monitor(){ :; }
# Walks a finite ladder; leaves the rung unchanged once exhausted, exactly as
# hot_swap does when the ladder offers no next model.
hot_swap_story_model_if_unstable(){
  local _n; _n=$(cat ${JSON.stringify(rungFile)})
  if [ "$_n" -lt $(( ${rungs.length} - 1 )) ]; then
    echo $(( _n + 1 )) > ${JSON.stringify(rungFile)}
    return 0
  fi
  return 1   # ladder exhausted — same contract as the real hot_swap
}
${fnText('run_story_with_watchdog')}
run_story_with_watchdog S-1 1 ${JSON.stringify(join(d, 'story.log'))}
echo "DONE"
`);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, EPAM_PAUSE_ON_TIMEOUT: 'false', ...env },
  });
  const used = existsSync(attempts)
    ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean).map((n) => rungs[Number(n)])
    : [];
  return { used, out: (r.stdout || '') + (r.stderr || '') };
}

const HIGH = ['MiniMax-M2.5', 'MiniMax-M3', 'z-ai/glm-5.1', 'moonshotai/kimi-k3'];

describe('the ladder is climbed to its end', () => {
  it('reaches the final rung — kimi-k3 was unreachable by construction', () => {
    const { used } = traverse(HIGH);
    expect(used, `only reached: ${used.join(' -> ')}`).toContain('moonshotai/kimi-k3');
  });

  it('makes one attempt per rung, not two attempts total', () => {
    const { used } = traverse(HIGH);
    expect(used.length,
      `four configured rungs but only ${used.length} attempt(s) — the top of the ` +
      'ladder cannot be reached')
      .toBe(HIGH.length);
  });

  it('uses each rung once, in order', () => {
    expect(traverse(HIGH).used).toEqual(HIGH);
  });
});

describe('it still terminates', () => {
  it('still gives one extended-budget retry when the ladder cannot advance', () => {
    // Pre-existing behaviour that must survive: a project with no ladder still
    // gets its single retry on a longer clock. What it does NOT get is repeated
    // re-runs of a model that already failed twice.
    const { used } = traverse(['only-model']);
    expect(used.length, 'a story with no ladder lost its retry entirely').toBe(2);
  });

  it('respects an explicit attempt cap below the rung count', () => {
    const { used } = traverse(HIGH, { EPAM_MAX_LADDER_ATTEMPTS: '2' });
    expect(used.length, 'the configured cap was ignored').toBe(2);
  });

  it('reports the failure after exhausting the ladder', () => {
    const { out } = traverse(HIGH);
    expect(out).toMatch(/timed out|skipping story/i);
  });
});

describe('the real hot_swap reports whether it advanced', () => {
  // The climb loop treats a 0 return as "moved to a new rung". Every path in
  // hot_swap that does NOT swap must therefore report non-zero, or the loop
  // re-runs the same model until the cap. The first version of this change
  // missed that: three early returns still said 0.
  function realSwap(env: Record<string, string>): number {
    const d = mkdtempSync(join(tmpdir(), 'swap-'));
    dirs.push(d);
    const prd = join(d, 'prd.json');
    // ladderTier is read from the STORY (defaults to "medium"), which selects
    // which EPAM_MODEL_LADDER_* is consulted. Without it the HIGH ladder set
    // below is never read and every case looks exhausted.
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', model: 'm-a', ladderTier: 'high' }] }));
    const script = join(d, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PRD_FILE=${JSON.stringify(prd)}
MAIN_PRD_FILE=${JSON.stringify(prd)}
LOG_DIR=${JSON.stringify(d)}
warning(){ :; }; log(){ :; }; error(){ :; }
${fnText('_story_archetype_ladder')}
${fnText('_resolve_ladder_tier')}
${fnText('hot_swap_story_model_if_unstable')}
hot_swap_story_model_if_unstable S-1
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
    const out = (r.stdout || '') + (r.stderr || '');
    return Number((out.match(/RC=(\d+)/) || [, '0'])[1]);
  }

  it('reports NOT advanced when no ladder is configured', () => {
    expect(realSwap({ EPAM_MODEL_LADDER_HIGH: '', EPAM_MODEL_LADDER: '', EPAM_FINAL_FALLBACK_MODEL: '' }),
      'no ladder but reported a successful escalation — the caller would re-run the same model')
      .not.toBe(0);
  });

  it('reports NOT advanced when the ladder has no next rung for this model', () => {
    expect(realSwap({ EPAM_MODEL_LADDER_HIGH: 'other=thing', EPAM_FINAL_FALLBACK_MODEL: '' }))
      .not.toBe(0);
  });

  it('reports advanced when a next rung exists', () => {
    expect(realSwap({ EPAM_MODEL_LADDER_HIGH: 'm-a=m-b' }),
      'a real escalation was reported as exhausted, stopping the climb early')
      .toBe(0);
  });
});
