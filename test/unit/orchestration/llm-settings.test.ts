/**
 * llm-settings.json is the single source of truth for the ladder/retry/
 * self-heal/cost-control settings claude.sh's load_llm_settings_json() reads
 * as FALLBACK DEFAULTS — an already-exported EPAM_* env var always wins.
 * Before this, EPAM_MODEL_LADDER_HIGH/MEDIUM, EPAM_MAX_RETRIES,
 * EPAM_RETRY_EXTENSION_*, EPAM_STORY_TIMEOUT_SECS, EPAM_GATE_TIMEOUT_SECS and
 * EPAM_TEMPERATURE were duplicated across orchestrations/jira/metrolinx.env
 * AND orchestrations/projects/metrolinx/config.env, and had already drifted
 * apart (EPAM_STORY_TIMEOUT_SECS: 600 vs 690) — these tests exist to catch
 * that class of drift returning, and to prove the loader actually applies
 * the JSON rather than silently no-op'ing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const SCHEMA_FILE = join(REPO_ROOT, 'orchestrations/config/llm-settings.schema.json');
const METROLINX_SETTINGS_FILE = join(REPO_ROOT, 'orchestrations/projects/metrolinx/llm-settings.json');
const METROLINX_ENV_FILE = join(REPO_ROOT, 'orchestrations/jira/metrolinx.env');
const METROLINX_CONFIG_ENV_FILE = join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

// The invocation-time model-override resolver isn't its own named function —
// it's an inline block in implement_story()'s provider-invocation branch —
// so it's extracted by its distinctive start/end markers instead of a
// function name.
function extractModelOverrideResolverBlock(src: string): string {
  const start = src.indexOf('local _effective_max_iterations="${STORY_MAX_ITERATIONS:-6}"');
  // Anchored to the ModelOverride log line, which is emitted AFTER every override value is
  // applied. The previous anchor was the first 16-space `fi`, so any new conditional added
  // inside the resolver silently truncated the lifted block and the harness reported empty
  // values for overrides the pipeline was applying correctly.
  const marker = src.indexOf('ModelOverride[', start);
  const end = src.indexOf('\n                fi\n', marker) + '\n                fi\n'.length;
  return src.slice(start, end);
}


/** The effort helpers claude.sh's override resolver depends on, lifted from the real source. */
function effortHelpers(): string {
  return ['effort_rank', 'max_effort', 'next_effort'].map((n) => {
    const m = new RegExp(`^${n}\\(\\) \\{$`, 'm').exec(claudeSrc);
    if (!m) return '';
    return claudeSrc.slice(m.index, claudeSrc.indexOf('\n}\n', m.index) + 3);
  }).join('\n');
}

function resolveModelOverride(settings: object, provider: string, model: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'llm-settings-override-'));
  try {
    writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify(settings));
    const block = extractModelOverrideResolverBlock(claudeSrc);
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      `EPAM_PROJECT_CONFIG_DIR="${dir}"\n` +
        `STORY_PROVIDER="${provider}"\n` +
        `STORY_MODEL="${model}"\n` +
        `log() { :; }\n` +
        // The resolver now applies effort via max_effort() (an override is a FLOOR, not an
        // overwrite, so a rung's escalation survives). Undefined here, it returns empty and
        // the harness reports no override for one the pipeline applies correctly.
        `${effortHelpers()}\n` +
        `resolve_override() {\n${block}\n` +
        `  echo "EPAM_REASONING_EFFORT=${'$'}{EPAM_REASONING_EFFORT:-}"\n` +
        `  echo "EPAM_TEMPERATURE=${'$'}{EPAM_TEMPERATURE:-}"\n` +
        `  echo "_effective_max_iterations=${'$'}{_effective_max_iterations:-}"\n` +
        `  echo "_effective_compress_at=${'$'}{_effective_compress_at:-}"\n` +
        `  echo "_effective_compress_every_n=${'$'}{_effective_compress_every_n:-}"\n` +
        `}\n` +
        `resolve_override\n` +
        `exit 0\n`
    );
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    const result: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runLoader(settings: object): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'llm-settings-test-'));
  try {
    writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify(settings));
    const fnBody = extractFunctionBody(claudeSrc, 'load_llm_settings_json');
    const scriptPath = join(dir, 'run.sh');
    // Print every EPAM_* var the loader could touch as NAME=value lines,
    // so an unset var is distinguishable from one exported as "".
    const probeVars = [
      'EPAM_TEMPERATURE', 'EPAM_MAX_RETRIES', 'EPAM_RETRY_EXTENSION_ENABLED',
      'EPAM_RETRY_EXTENSION_MAX', 'EPAM_STORY_TIMEOUT_SECS', 'EPAM_GATE_TIMEOUT_SECS',
      'EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS', 'EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS',
      'EPAM_AUTO_COMPRESS_AT', 'EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS',
      'EPAM_RUNG1_TEMPERATURE', 'EPAM_RUNG2_TEMPERATURE', 'EPAM_RUNG3_TEMPERATURE',
      'EPAM_RUNG0_REASONING_EFFORT', 'EPAM_RUNG1_REASONING_EFFORT',
      'EPAM_RUNG2_REASONING_EFFORT', 'EPAM_RUNG3_REASONING_EFFORT',
      'EPAM_MODEL_LADDER_HIGH', 'EPAM_MODEL_LADDER_MEDIUM',
      'EPAM_STORY_MAX_TOOL_CALLS', 'EPAM_STORY_BUDGET_WARNING_USD', 'EPAM_STORY_BUDGET_HARD_LIMIT_USD',
      // These two are intentionally NOT set by the loader anymore (superseded
      // by the generic per-attempt modelOverrides resolver) — probed here
      // only to prove that absence, not because the loader should set them.
      'EPAM_MINIMAX_REASONING_EFFORT', 'EPAM_KIMI_TEMPERATURE',
    ];
    const probe = probeVars.map(v => `[ -n "\${${v}+x}" ] && echo "${v}=$${v}"`).join('\n');
    writeFileSync(scriptPath, `EPAM_PROJECT_CONFIG_DIR="${dir}"\n${fnBody}\nload_llm_settings_json\n${probe}\nexit 0\n`);
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    const result: Record<string, string> = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('  LLMSettings:') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const METROLINX_SETTINGS = JSON.parse(readFileSync(METROLINX_SETTINGS_FILE, 'utf8'));

describe('load_llm_settings_json() — applies JSON as fallback defaults', () => {
  it('exports the ladder/retry/timeout/temperature settings from the metrolinx fixture', () => {
    const env = runLoader(METROLINX_SETTINGS);
    expect(env.EPAM_TEMPERATURE).toBe('0');
    expect(env.EPAM_MAX_RETRIES).toBe('7');
    expect(env.EPAM_RETRY_EXTENSION_ENABLED).toBe('1');
    expect(env.EPAM_RETRY_EXTENSION_MAX).toBe('2');
    expect(env.EPAM_STORY_TIMEOUT_SECS).toBe('1800');
    expect(env.EPAM_GATE_TIMEOUT_SECS).toBe('2400');
    expect(env.EPAM_RUNG0_REASONING_EFFORT).toBe('medium');
    expect(env.EPAM_RUNG1_REASONING_EFFORT).toBe('medium');
    expect(env.EPAM_RUNG2_REASONING_EFFORT).toBe('high');
    expect(env.EPAM_RUNG3_REASONING_EFFORT).toBe('high');
    expect(env.EPAM_RUNG1_TEMPERATURE).toBe('0.2');
    expect(env.EPAM_RUNG2_TEMPERATURE).toBe('0.5');
    expect(env.EPAM_RUNG3_TEMPERATURE).toBe('0.7');
    expect(env.EPAM_MODEL_LADDER_HIGH).toBe(
      // glm-5.2 now escalates straight to kimi-k3: kimi-k2.5 is the one route measured at 0%
      // prompt-cache utilisation, so it repurchases the whole prefix every turn.
      'MiniMax-M2.5=MiniMax-M3|MiniMax-M3=z-ai/glm-5.2|zhipuai/glm-z1-9b=zhipuai/glm-z1-32b|zhipuai/glm-z1-32b=z-ai/glm-5.2|z-ai/glm-5.1=z-ai/glm-5.2|z-ai/glm-5.2=moonshotai/kimi-k3|moonshotai/kimi-k2.5=moonshotai/kimi-k3',
    );
    expect(env.EPAM_MODEL_LADDER_MEDIUM).toBe(
      'MiniMax-M2.5=MiniMax-M3|MiniMax-M3=z-ai/glm-5.2|zhipuai/glm-z1-9b=zhipuai/glm-z1-32b|zhipuai/glm-z1-32b=z-ai/glm-5.2|z-ai/glm-5.1=z-ai/glm-5.2'
    );
  });

  it('the loader no longer flattens modelOverrides into fixed minimax/kimi env vars — there can be any number of entries', () => {
    // Superseded by the generic resolver (see "model-override resolver"
    // describe block below), which reads modelOverrides directly per-attempt
    // instead of pre-flattening a fixed set of names at script start.
    const env = runLoader(METROLINX_SETTINGS);
    expect(env.EPAM_MINIMAX_REASONING_EFFORT).toBeUndefined();
    expect(env.EPAM_KIMI_TEMPERATURE).toBeUndefined();
  });

  it('exports the real (non-null) cost controls set 2026-08-01: tool-call cap, warning, and enforced hard limit', () => {
    const env = runLoader(METROLINX_SETTINGS);
    expect(env.EPAM_STORY_MAX_TOOL_CALLS).toBe('600');
    expect(env.EPAM_STORY_BUDGET_WARNING_USD).toBe('3.5');
    // Bumped 8 -> 15 on 2026-08-01: the $8 cap killed a Writer Retest run mid-way
    // through a real, correct fix (metrolinx needed ~$8.5 across its retry ladder).
    expect(env.EPAM_STORY_BUDGET_HARD_LIMIT_USD).toBe('15');
  });

  it('an already-exported EPAM_* env var always wins over the JSON value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-settings-precedence-'));
    try {
      writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify(METROLINX_SETTINGS));
      const fnBody = extractFunctionBody(claudeSrc, 'load_llm_settings_json');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `EPAM_PROJECT_CONFIG_DIR="${dir}"\nexport EPAM_MAX_RETRIES=3\n${fnBody}\nload_llm_settings_json\necho "EPAM_MAX_RETRIES=$EPAM_MAX_RETRIES"\n`
      );
      const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(out).toMatch(/EPAM_MAX_RETRIES=3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-ops cleanly when EPAM_PROJECT_CONFIG_DIR/llm-settings.json is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-settings-absent-'));
    try {
      const fnBody = extractFunctionBody(claudeSrc, 'load_llm_settings_json');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `set -e\nEPAM_PROJECT_CONFIG_DIR="${dir}"\n${fnBody}\nload_llm_settings_json\necho "no-op ok"\n`
      );
      const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(out.trim()).toBe('no-op ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REPRODUCES a live sibling defect and proves the fix: a MALFORMED llm-settings.json must not crash the caller under set -e', () => {
    // Live 2026-08-02, found while fixing the identical bug in the new
    // _load_timeout_config() (lib/story-guards.sh): claude.sh runs under
    // `set -e` from its very first line, and `_get()`'s `jq ... // empty`
    // only rescues a valid-but-absent VALUE — a JSON PARSE error is a hard
    // jq failure regardless, and every call site here is
    // `_v=$(_get ...)`, a bare simple command whose failing exit status
    // would otherwise kill claude.sh outright, silently contradicting this
    // loader's own "malformed config never blocks" intent. `_get()` now
    // ends in `|| true` to guarantee that.
    const dir = mkdtempSync(join(tmpdir(), 'llm-settings-malformed-'));
    try {
      writeFileSync(join(dir, 'llm-settings.json'), '{ not valid json');
      const fnBody = extractFunctionBody(claudeSrc, 'load_llm_settings_json');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `set -e\nEPAM_PROJECT_CONFIG_DIR="${dir}"\n${fnBody}\nload_llm_settings_json\necho "no-op ok"\n`
      );
      const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(out).toMatch(/no-op ok/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('llm-settings.schema.json / metrolinx llm-settings.json — structural validity', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));

  it('the schema file is valid JSON with the expected top-level sections', () => {
    expect(schema.properties).toHaveProperty('temperatureFloor');
    expect(schema.properties).toHaveProperty('rungs');
    expect(schema.properties).toHaveProperty('ladders');
    expect(schema.properties).toHaveProperty('modelOverrides');
    expect(schema.properties).toHaveProperty('retries');
    expect(schema.properties).toHaveProperty('timeouts');
    expect(schema.properties).toHaveProperty('brownfield');
    expect(schema.properties).toHaveProperty('compaction');
    expect(schema.properties).toHaveProperty('costControls');
  });

  it('the metrolinx example declares exactly 4 rungs (0-3), matching the fixed retry_count/2 case statement', () => {
    expect(METROLINX_SETTINGS.rungs).toHaveLength(4);
    expect(METROLINX_SETTINGS.rungs.map((r: any) => r.rung)).toEqual([0, 1, 2, 3]);
  });

  it("the HIGH ladder's real transition count for a novel-brownfield story is 4 (glm-5.1 -> glm-5.2 -> kimi-k2.5 -> kimi-k3), well above the 3-model floor", () => {
    // novel-brownfield stories start at glm-5.1 (skip MiniMax-M3). Before the
    // 2026-08-01 inversion fix, glm-5.1 was the ladder's incorrect CEILING
    // (glm-5.2 escalated DOWN to it) and the real chain was only 2 models
    // (glm-5.1 -> kimi-k3). GLM-5.2 (June 2026) is verified newer/cheaper/
    // stronger than GLM-5.1 (April 2026) — see llm-settings.schema.json's
    // modelOverride docstring — so glm-5.1 must escalate TO glm-5.2, not the
    // reverse. kimi-k2.5 was added as an intermediate step above glm-5.2.
    const highChain = METROLINX_SETTINGS.ladders.high.modelLadder;
    const fromGlm51 = highChain.filter((t: any) => t.from === 'z-ai/glm-5.1');
    expect(fromGlm51).toHaveLength(1);
    expect(fromGlm51[0].to).toBe('z-ai/glm-5.2');
    const fromGlm52 = highChain.filter((t: any) => t.from === 'z-ai/glm-5.2');
    expect(fromGlm52).toHaveLength(1);
    expect(fromGlm52[0].to).toBe('moonshotai/kimi-k3');
    const fromKimiK25 = highChain.filter((t: any) => t.from === 'moonshotai/kimi-k2.5');
    expect(fromKimiK25).toHaveLength(1);
    expect(fromKimiK25[0].to).toBe('moonshotai/kimi-k3');
  });

  it('regression guard: no modelLadder transition ever escalates FROM glm-5.2 TO glm-5.1 (the exact inversion bug found 2026-08-01)', () => {
    for (const ladder of Object.values(METROLINX_SETTINGS.ladders) as any[]) {
      const inverted = ladder.modelLadder.find(
        (t: any) => t.from === 'z-ai/glm-5.2' && t.to === 'z-ai/glm-5.1'
      );
      expect(inverted).toBeUndefined();
    }
  });

  it('regression guard: BOTH ladders have an escalation path from glm-5.1 (the medium-ladder dead-end found live 2026-08-01)', () => {
    // Live AMSD-2041 sandbox run 2026-08-01: a story classified ladderTier=
    // medium started on z-ai/glm-5.1 (via the novel-brownfield / final-fallback
    // routing that is independent of ladderTier) and reached Rung 2 with
    // "no ladder step — keeping model" because medium's modelLadder had no
    // "from": "z-ai/glm-5.1" entry (only high did). Any tier a story can be
    // classified into must have an escalation path from every model that
    // routing can actually hand it, or escalation silently no-ops.
    for (const [tierName, ladder] of Object.entries(METROLINX_SETTINGS.ladders) as [string, any][]) {
      const fromGlm51 = ladder.modelLadder.filter((t: any) => t.from === 'z-ai/glm-5.1');
      expect(fromGlm51, `${tierName} ladder has no escalation path from z-ai/glm-5.1`).toHaveLength(1);
    }
  });

  it('every modelLadder "from" and "to" is a non-empty string (schema-shape sanity)', () => {
    for (const ladder of Object.values(METROLINX_SETTINGS.ladders) as any[]) {
      for (const transition of ladder.modelLadder) {
        expect(typeof transition.from).toBe('string');
        expect(transition.from.length).toBeGreaterThan(0);
        expect(typeof transition.to).toBe('string');
        expect(transition.to.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('model-override resolver — picks the right entry per resolved STORY_PROVIDER/STORY_MODEL', () => {
  it('MiniMax-M2.5 gets its own (lighter) budget, distinct from MiniMax-M3', () => {
    const env = resolveModelOverride(METROLINX_SETTINGS, 'minimax', 'MiniMax-M2.5');
    expect(env.EPAM_REASONING_EFFORT).toBe('medium');
    expect(env._effective_max_iterations).toBe('45');
    expect(env._effective_compress_at).toBe('64000');
    expect(env._effective_compress_every_n).toBe('15');
  });

  it('MiniMax-M3 gets a distinct, heavier budget than MiniMax-M2.5', () => {
    const env = resolveModelOverride(METROLINX_SETTINGS, 'minimax', 'MiniMax-M3');
    expect(env.EPAM_REASONING_EFFORT).toBe('high');
    expect(env._effective_max_iterations).toBe('120');
    expect(env._effective_compress_at).toBe('128000');
    expect(env._effective_compress_every_n).toBe('25');
  });

  it('glm-5.2 gets its own high-effort, 1M-context-appropriate budget', () => {
    const env = resolveModelOverride(METROLINX_SETTINGS, 'qwen', 'z-ai/glm-5.2');
    expect(env.EPAM_REASONING_EFFORT).toBe('high');
    expect(env._effective_max_iterations).toBe('120');
    expect(env._effective_compress_at).toBe('128000');
    expect(env._effective_compress_every_n).toBe('20');
  });

  it('kimi-k2.5 (intermediate escalation step) gets its own distinct, lighter budget than kimi-k3', () => {
    const env = resolveModelOverride(METROLINX_SETTINGS, 'qwen', 'moonshotai/kimi-k2.5');
    expect(env.EPAM_TEMPERATURE).toBe('1');
    expect(env.EPAM_REASONING_EFFORT).toBe('medium');
    expect(env._effective_max_iterations).toBe('60');
    expect(env._effective_compress_at).toBe('128000');
  });

  it('kimi-k3 gets its own temperature/compaction override, distinct from kimi-k2.5 (no substring collision)', () => {
    const env = resolveModelOverride(METROLINX_SETTINGS, 'qwen', 'moonshotai/kimi-k3');
    expect(env.EPAM_TEMPERATURE).toBe('1');
    expect(env.EPAM_REASONING_EFFORT).toBe('max');
    expect(env._effective_max_iterations).toBe('150');
    expect(env._effective_compress_at).toBe('400000');
  });

  it('a model matching nothing gets no override applied (defaults untouched)', () => {
    const env = resolveModelOverride(METROLINX_SETTINGS, 'qwen', 'z-ai/glm-5.1');
    expect(env.EPAM_REASONING_EFFORT).toBe('');
    expect(env.EPAM_TEMPERATURE).toBe('');
  });
});

describe('metrolinx.env / config.env — ladder settings deduplicated, not just drifted', () => {
  const envSrc = readFileSync(METROLINX_ENV_FILE, 'utf8');
  const configEnvSrc = readFileSync(METROLINX_CONFIG_ENV_FILE, 'utf8');
  const dedupedKeys = [
    'EPAM_MAX_RETRIES=', 'EPAM_RETRY_EXTENSION_ENABLED=', 'EPAM_RETRY_EXTENSION_MAX=',
    'EPAM_STORY_TIMEOUT_SECS=', 'EPAM_GATE_TIMEOUT_SECS=', 'EPAM_TEMPERATURE=',
    'EPAM_MODEL_LADDER_HIGH=', 'EPAM_MODEL_LADDER_MEDIUM=',
  ];

  it('neither env file re-declares a setting llm-settings.json now owns', () => {
    for (const key of dedupedKeys) {
      expect(envSrc).not.toContain(key);
      expect(configEnvSrc).not.toContain(key);
    }
  });

  it('both env files still reference llm-settings.json so the removal is discoverable', () => {
    expect(envSrc).toMatch(/llm-settings\.json/);
    expect(configEnvSrc).toMatch(/llm-settings\.json/);
  });
});
