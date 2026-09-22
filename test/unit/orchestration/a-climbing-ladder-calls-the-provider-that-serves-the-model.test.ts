/**
 * A LADDER RUNG IS A MODEL *AND* A PROVIDER.
 *
 * Found live, 2026-09-22, regintel resume 7, review cycle 2 (three empty reviews):
 *
 *   [ai-run] 'team-lead-review' resuming ladder on '<top rung>' (persisted from an earlier invocation)
 *   [ai-run] attempt 2/3 — at the top of its declared chain, retrying the same rung
 *   Error: All providers exhausted without a successful response.
 *     Attempted: <launch provider>/<top rung>: 400 invalid params, unknown model '<top rung>'
 *
 * llm-handler.sh builds its `providers` list from the provider it was LAUNCHED with and then
 * climbs the ladder — the cross-process resume and the in-process escalation both reassign
 * AI_MODEL and neither re-resolves the provider. On a set whose ladder spans two vendors (the
 * project declares that routing in EPAM_MODEL_PROVIDER_MAP) every rung above the launch vendor
 * is therefore called on the WRONG endpoint: the vendor answers 400, the reply is empty, and the
 * caller records "review output unparseable" — a routing error wearing a model failure's clothes.
 *
 * lib/model-ladder.sh already states the rule this violates (sync_provider_to_model): "MODEL AND
 * PROVIDER ARE ONE DECISION ... Resolving at the point of USE means no arm can forget."
 *
 * Executes the REAL llm-handler.sh against a stub CLI that records every (provider, model) pair
 * it is actually called with. No model names are authored here beyond fixtures; the routing comes
 * from the project's own declaration, as it does in a run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const LLM_HANDLER = join(REPO_ROOT, 'orchestrations/scripts/llm-handler.sh');

// Two fixture rungs served by two DIFFERENT declared providers, exactly as a real
// set's ladder spans two vendors. Names are fixtures; the providers are the ones
// orchestrations/config/providers.json declares, because the handler dispatches on them.
const LADDER = 'fixture-small-1=fixture-big-1';
const PROVIDER_MAP = 'fixture-small-*=minimax|fixture-big-*=openrouter';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-provider-'));
  dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const callsFile = join(dir, 'calls.txt');
  writeFileSync(callsFile, '');

  // The umbrella CLI both `minimax` and `openrouter` dispatch through. Records the
  // (provider, model) pair it was ACTUALLY called with, then fails — as the real vendor
  // does when it is handed a model it does not serve.
  const epamStub = join(binDir, 'epam');
  writeFileSync(epamStub, `#!/usr/bin/env bash
prov=""; model=""
prev=""
for a in "$@"; do
  case "$prev" in --provider) prov="$a" ;; --model) model="$a" ;; esac
  prev="$a"
done
echo "$prov|$model" >> ${JSON.stringify(callsFile)}
echo "stub: no completion" >&2
exit 1
`);
  chmodSync(epamStub, 0o755);
  return { dir, logDir, binDir, callsFile, epamStub };
}

function invoke(s: ReturnType<typeof setup>, extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [LLM_HANDLER], {
    encoding: 'utf8',
    timeout: 60000,
    input: 'do the thing',
    env: {
      PATH: `${s.binDir}:${process.env.HOME}/.local/bin:/usr/bin:/bin`,
      HOME: process.env.HOME,
      LOG_DIR: s.logDir,
      PROJECT_ROOT: s.dir,
      EPAM_CLI: s.epamStub,
      EPAM_PROVIDER_SET: 'openrouter',
      AI_PROVIDER: 'minimax',
      AI_MODEL: 'fixture-small-1',
      EPAM_MODEL_LADDER_HIGH: LADDER,
      EPAM_MODEL_LADDER_HIGHEST: LADDER,
      EPAM_MODEL_LADDER: LADDER,
      EPAM_MODEL_LADDER_TIER_ORDER: 'medium high highest',
      EPAM_MODEL_PROVIDER_MAP: PROVIDER_MAP,
      EPAM_AGENT_NAME: 'team-lead-review',
      EPAM_STORY_ID: 'S-1',
      EPAM_PLAN_EXECUTE: '0',
      EPAM_CALL_MAX_ATTEMPTS: '2',
      EPAM_CALL_ATTEMPT_TIMEOUT_SECS: '25',
      ...extraEnv,
    },
  });
  return { out: (r.stdout || '') + (r.stderr || '') };
}

function calls(s: ReturnType<typeof setup>): string[] {
  return readFileSync(s.callsFile, 'utf8').trim().split('\n').filter(Boolean);
}

describe('a climbing ladder calls the provider that serves the model', () => {
  it('IN-PROCESS: the escalated rung is called on ITS OWN provider, never on the launch provider', () => {
    const s = setup();
    invoke(s);
    const seen = calls(s);
    expect(seen.length, 'the handler never reached the stub CLI at all').toBeGreaterThan(1);
    expect(seen[0], 'the first attempt should use the launch pair').toBe('minimax|fixture-small-1');
    expect(
      seen,
      'the escalated rung was sent to the provider the run was LAUNCHED with — the live 400 "unknown model"',
    ).not.toContain('minimax|fixture-big-1');
    expect(seen).toContain('openrouter|fixture-big-1');
  });

  it('CROSS-PROCESS: a fresh process resuming a persisted rung routes to that rung\'s provider', () => {
    const s = setup();
    invoke(s);                     // records the failures, persisting the rung
    writeFileSync(s.callsFile, '');
    invoke(s);                     // fresh process, same agent+story: resumes on the top rung
    const seen = calls(s);
    expect(seen.length, 'the second process never reached the stub CLI').toBeGreaterThan(0);
    expect(
      seen.filter((c) => c.startsWith('minimax|fixture-big-1')),
      'the resumed rung was called on the provider persisted from the launch, not the one that serves it',
    ).toEqual([]);
    expect(seen[0]).toBe('openrouter|fixture-big-1');
  });
});
