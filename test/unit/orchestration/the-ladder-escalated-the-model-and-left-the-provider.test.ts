/**
 * THE LADDER ESCALATED THE MODEL AND THE PROVIDER STAYED BEHIND.
 *
 * Live 2026-08-18 run 20260818T101809Z, both lanes. The writer's first two attempts were real
 * calls that failed a type check and retried correctly. Then the ladder escalated:
 *
 *   InferenceLadder[Rung1/R2]: model 'MiniMax-M3' → 'z-ai/glm-5.2'
 *
 * and every attempt from there returned instantly:
 *
 *   Cost[MOCK3-1] model=z-ai/glm-5.2 ... elapsed=.01min
 *   Coordinator[L1]: environment failure detected (raw=0 bytes, exit=1)
 *
 * Ten of twelve attempts were unreachable by construction. Reproduced exactly:
 *
 *   minimax + MiniMax-M3    exit=0  413 bytes
 *   openrouter    + z-ai/glm-5.2  exit=0  410 bytes
 *   minimax + z-ai/glm-5.2  exit=1  0 bytes    <-- "All providers exhausted"
 *
 * MODEL AND PROVIDER ARE ONE DECISION, made in many places. Several escalation arms remember to
 * re-resolve the provider after changing the model; the invocation trusts that every arm did.
 * Resolving at the point of USE means no arm can forget, including one written later — the same
 * reason the write perimeter moved into the engine rather than into eight launchers.
 *
 * AND THE RUN COULD NOT SAY WHICH PROVIDER IT USED. The model is logged every attempt, the
 * provider once per story, so the record cannot distinguish these three combinations at all.
 * A failure whose cause is invisible in its own log is the thing that cost the diagnosis here.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const MAP = 'zhipuai/*=openrouter|moonshotai/*=openrouter|z-ai/*=openrouter|glm-*=openrouter|kimi-*=openrouter|deepseek/*=openrouter|MiniMax-*=minimax';

/** Extract a shell function from claude.sh by name and run it — the established pattern. */
function extractFn(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const re = new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`claude.sh has no function ${name}()`);
  return m[0];
}

function runWith(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_MODEL_PROVIDER_MAP: MAP, ...env },
  });
}

describe('the ladder escalated the model and left the provider', () => {
  it('resolve_model_provider maps each escalation target — the raw material', () => {
    const fn = extractFn('resolve_model_provider');
    const r = runWith(`${fn}\nfor m in z-ai/glm-5.2 MiniMax-M3 glm-5.1 kimi-k3; do echo "$m=$(resolve_model_provider "$m")"; done`);
    expect(r.stdout).toContain('z-ai/glm-5.2=openrouter');
    expect(r.stdout).toContain('MiniMax-M3=minimax');
    expect(r.stdout).toContain('glm-5.1=openrouter');
  });

  it('THE PROVIDER FOLLOWS THE MODEL AT THE POINT OF USE — whatever the escalation arm did', () => {
    const fn = extractFn('resolve_model_provider');
    const sync = extractFn('sync_provider_to_model');
    // The exact live state: an arm escalated the model and left STORY_PROVIDER on minimax.
    const r = runWith(`${fn}\n${sync}\nSTORY_MODEL='z-ai/glm-5.2'; STORY_PROVIDER='minimax'\n`
      + `sync_provider_to_model\necho "provider=$STORY_PROVIDER"`);
    expect(r.stdout.trim(), `combination that returns 0 bytes: ${r.stderr}`).toBe('provider=openrouter');
  });

  it('leaves a provider alone when the model already matches it', () => {
    const fn = extractFn('resolve_model_provider');
    const sync = extractFn('sync_provider_to_model');
    const r = runWith(`${fn}\n${sync}\nSTORY_MODEL='MiniMax-M3'; STORY_PROVIDER='minimax'\n`
      + `sync_provider_to_model\necho "provider=$STORY_PROVIDER"`);
    expect(r.stdout.trim()).toBe('provider=minimax');
  });

  it('leaves it alone when the map knows nothing about the model — never guesses', () => {
    const fn = extractFn('resolve_model_provider');
    const sync = extractFn('sync_provider_to_model');
    const r = runWith(`${fn}\n${sync}\nSTORY_MODEL='some/unmapped-model'; STORY_PROVIDER='minimax'\n`
      + `sync_provider_to_model\necho "provider=$STORY_PROVIDER"`);
    expect(r.stdout.trim(), 'an unmapped model changed the provider on a guess').toBe('provider=minimax');
  });

  it('is a no-op with no map at all, rather than an error', () => {
    const fn = extractFn('resolve_model_provider');
    const sync = extractFn('sync_provider_to_model');
    const r = spawnSync('bash', ['-c', `${fn}\n${sync}\nSTORY_MODEL='z-ai/glm-5.2'; STORY_PROVIDER='minimax'\n`
      + `sync_provider_to_model\necho "provider=$STORY_PROVIDER"`],
      { encoding: 'utf8', env: { ...process.env, EPAM_MODEL_PROVIDER_MAP: '' } });
    expect(r.status, 'an unset map failed the caller').toBe(0);
    expect(r.stdout.trim()).toBe('provider=minimax');
  });

  it('THE INVOCATION SYNCS BEFORE IT RUNS — not just when an arm remembers', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    // A CALL, not the definition and not the comment above it — both contain the name, and a
    // substring search on it passed with the call site deleted.
    const call = src.match(/^[ \t]+sync_provider_to_model[ \t]*$/m);
    const sync = call ? src.indexOf(call[0]) : -1;
    const invoke = src.indexOf('"$_epam_run_binary" run \\');
    expect(sync, 'nothing calls sync_provider_to_model').toBeGreaterThan(-1);
    expect(invoke, 'the epam run invocation moved — this ordering check is blind').toBeGreaterThan(-1);
    expect(sync, 'the provider is synced after the call it was meant to fix').toBeLessThan(invoke);
  });

  it('AND THE PROVIDER IS RECORDED EVERY ATTEMPT — the log could not name the failing pair', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    // The per-attempt line must carry BOTH, or three very different failures look identical.
    expect(src, 'no per-attempt line records provider and model together')
      .toMatch(/Invoking \$story_cli \(attempt[^\n]*provider|Attempt\[[^\]]*\][^\n]*provider/i);
  });
});
