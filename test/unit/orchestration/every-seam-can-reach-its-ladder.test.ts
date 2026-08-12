/**
 * A LADDER A SEAM CANNOT REACH IS NOT A LADDER ASSIGNMENT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * agents/invocation-profiles.json assigns a ladder to 17 seams. lib/seam-invocation.js turns
 * that into a MODEL — it exports EPAM_MODEL (the ladder's first rung) and EPAM_MODEL_LADDER —
 * but ONLY if EPAM_MODEL_LADDER_<TIER> exists in the calling process. Otherwise it warns and
 * returns effort and temperature alone, and the seam runs on whatever fixed model the script
 * already had.
 *
 * WHERE THE CHAIN BREAKS. The project declares its ladders in llm-settings.json (.ladders.high,
 * .medium, .highest). Only claude.sh's own loader reads them, exporting EPAM_MODEL_LADDER_HIGH
 * and _MEDIUM inside claude.sh's process. config.env sets _HIGHEST and deliberately not the
 * other two — its comment says they "live in one place".
 *
 * Seam scripts (team-lead-review.sh, code-review-cycle.sh, the repro-test writer, ...) are
 * children of the ORCHESTRATOR, not of claude.sh. They inherit _HIGHEST and nothing else. So a
 * seam declaring `"ladder": "high"` — impl-failure-analyst among them — resolves to no model at
 * all, which is exactly the warning observed:
 *
 *     [seam-invocation] seam 'impl-failure-analyst' asks for ladder 'high' but
 *                       EPAM_MODEL_LADDER_HIGH is unset — using the run's default ladder
 *
 * I assigned all 17 ladders on 2026-08-11 and reported "every agent can escalate". The field
 * was present and selected a model for none of them. The check was "is a ladder declared"; the
 * claim was "every agent can escalate".
 *
 * The ladders must be loaded WHERE THE ORCHESTRATOR CAN SEE THEM — the same reason
 * _load_timeout_config exists in the parent rather than in claude.sh, documented in
 * lib/story-guards.sh.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const GUARDS = join(ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const SEAM_JS = join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js');
const SETTINGS = join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json');
const CFG = JSON.parse(readFileSync(SETTINGS, 'utf8'));

/** Run the PARENT loader the way the orchestrator does, and report what it exported. */
function loadInParent(): Record<string, string> {
  const script = `
    . '${GUARDS}' 2>/dev/null || true
    EPAM_PROJECT_CONFIG_DIR='${join(ROOT, 'orchestrations/projects/metrolinx')}'
    command -v _load_timeout_config >/dev/null 2>&1 && _load_timeout_config >/dev/null 2>&1
    for v in EPAM_MODEL_LADDER_HIGH EPAM_MODEL_LADDER_MEDIUM EPAM_MODEL_LADDER_HIGHEST; do
      eval "printf '%s=%s\\n' \\"\\$v\\" \\"\\\${$v:-}\\""
    done
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** What seam-invocation.js resolves for a seam, given an environment. */
function seamEnv(seam: string, env: Record<string, string>): Record<string, string> {
  const r = spawnSync(process.execPath, ['-e',
    `const {seamInvocationEnv}=require(${JSON.stringify(SEAM_JS)});
     process.stdout.write(JSON.stringify(seamInvocationEnv(${JSON.stringify(seam)})));`],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}

describe('the project declares ladders for every tier a seam can ask for', () => {
  it('llm-settings.json defines high, medium and highest', () => {
    for (const tier of ['high', 'medium', 'highest']) {
      expect(CFG.ladders?.[tier]?.modelLadder?.length, `no ${tier} ladder declared`).toBeGreaterThan(0);
    }
  });

  it('every tier named by a profile is declared by the project', () => {
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    const tiers = [...new Set(Object.values(reg.profiles as Record<string, any>)
      .map((p) => p.ladder).filter(Boolean).map((t: string) => t.toLowerCase()))];
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      expect(CFG.ladders?.[t], `a profile asks for ladder '${t}' and the project declares none`).toBeTruthy();
    }
  });
});

describe('THE ORCHESTRATOR EXPORTS EVERY LADDER, NOT JUST HIGHEST', () => {
  it('THE DEFECT: the parent loader exports the HIGH ladder', () => {
    // config.env sets only _HIGHEST; _HIGH and _MEDIUM lived in llm-settings.json, read by
    // claude.sh alone. Seam scripts are children of the orchestrator and never saw them.
    expect(loadInParent().EPAM_MODEL_LADDER_HIGH, 'seams asking for ladder "high" resolve to no model')
      .toBeTruthy();
  });

  it('and the MEDIUM ladder', () => {
    expect(loadInParent().EPAM_MODEL_LADDER_MEDIUM).toBeTruthy();
  });

  it('the exported chain matches what the project declared', () => {
    const expected = CFG.ladders.high.modelLadder.map((p: any) => `${p.from}=${p.to}`).join('|');
    expect(loadInParent().EPAM_MODEL_LADDER_HIGH).toBe(expected);
  });

  it('an existing value is not overwritten — an explicit override still wins', () => {
    const r = spawnSync('bash', ['-c', `
      . '${GUARDS}' 2>/dev/null || true
      EPAM_PROJECT_CONFIG_DIR='${join(ROOT, 'orchestrations/projects/metrolinx')}'
      export EPAM_MODEL_LADDER_HIGH='a=b'
      command -v _load_timeout_config >/dev/null 2>&1 && _load_timeout_config >/dev/null 2>&1
      printf '%s' "$EPAM_MODEL_LADDER_HIGH"`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('a=b');
  });
});

describe('A SEAM NOW RESOLVES TO A MODEL, NOT JUST AN EFFORT', () => {
  it('THE POINT OF ALL OF IT: a "high" seam gets a model and a ladder', () => {
    const env = loadInParent();
    const resolved = seamEnv('impl-failure-analyst', env);
    expect(resolved.EPAM_MODEL, 'the seam still runs on whatever fixed model its script had')
      .toBeTruthy();
    expect(resolved.EPAM_MODEL_LADDER, 'the seam has a model but nowhere to escalate to')
      .toBeTruthy();
  });

  it('the model it starts on is the ladder\'s first rung', () => {
    const env = loadInParent();
    const first = CFG.ladders.high.modelLadder[0].from;
    expect(seamEnv('impl-failure-analyst', env).EPAM_MODEL).toBe(first);
  });

  it('an agent matching nothing resolves to the DECLARED default, never {}', () => {
    // INVERTED 2026-08-12: written an hour before the minted-agent design fix, this asserted
    // the very fail-open that left 64 minted agents unconfigured.
    const out = seamEnv('not-a-real-seam', loadInParent());
    expect(out, 'an unknown agent still gets nothing').not.toEqual({});
  });
});
