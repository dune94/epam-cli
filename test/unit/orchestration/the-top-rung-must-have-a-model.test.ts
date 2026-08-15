/**
 * THE TOP RUNG MUST HAVE A MODEL.
 *
 * compute_escalation_profile prices the story's escalation path: rung1 → rung2 → rung3 → k3.
 * It resolves the rungs above the ones it is given by walking the tier's ladder:
 *
 *     _chain = os.environ.get("EPAM_MODEL_LADDER", "")
 *     _tier  = (os.environ.get("EPAM_STORY_LADDER_TIER", "") or "").upper()
 *     if _tier:
 *         _chain = os.environ.get("EPAM_MODEL_LADDER_" + _tier, _chain)
 *     _hops = {...}                        # built from _chain
 *     k3_model = _hops.get(rung3_model, "")
 *
 * `EPAM_STORY_LADDER_TIER` is set NOWHERE in this repository, and the bare
 * `EPAM_MODEL_LADDER` is only ever exported empty (and only by two other launchers). So
 * `_tier` is always empty, the `if` never fires, `_chain` is always empty, `_hops` is
 * always empty — and the top rung silently has no model.
 *
 * Measured, both versions executed under identical environment:
 *
 *     gotransit (4cfba9f):  k3 = "z-ai/glm-5.2"
 *     after 2f8d980:        k3 = ""
 *
 * The predecessor read `EPAM_MODEL_LADDER_HIGH` unconditionally and found the hop. The
 * replacement routes through a variable nothing assigns. The cost model then prices a k3
 * attempt at 0.0 for a model that does not exist.
 *
 * NOTHING IS HARDCODED HERE. The expected rung is read from the project's own
 * llm-settings.json; this test names no model and no tier of its own.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CPA = join(ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const SETTINGS = join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json');

/** Extract the real function, terminating AFTER its embedded python heredoc. */
function extractFn(): string {
  const src = readFileSync(CPA, 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('compute_escalation_profile() {'));
  expect(start, 'compute_escalation_profile not found').toBeGreaterThan(-1);
  // A `}` at column 0 also occurs INSIDE the heredoc (it emits JSON), so the function's
  // real end is the first one AFTER the heredoc terminator.
  const pyEnd = src.findIndex((l, i) => i > start && l === 'PYEOF');
  expect(pyEnd, 'PYEOF terminator not found').toBeGreaterThan(start);
  const end = src.findIndex((l, i) => i > pyEnd && l.startsWith('}'));
  return src.slice(start, end + 1).join('\n');
}

/** Run the real function under the project's real exported ladders. */
function profile(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'cep-'));
  try {
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      `. ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/model-ladders.sh'))}`,
      `export_model_ladders ${JSON.stringify(SETTINGS)}`,
      extractFn(),
      'compute_escalation_profile "high" "0.5" "20000" "${EPAM_MODEL:-}"',
    ].join('\n'));
    const res = spawnSync('bash', [script], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    try { return JSON.parse(res.stdout || '{}'); } catch { return {}; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every model the project declares as a rung of any tier. */
function declaredRungs(): string[] {
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  const out = new Set<string>();
  for (const tier of Object.values<any>(s.ladders ?? {})) {
    for (const hop of tier.modelLadder ?? []) { out.add(hop.from); out.add(hop.to); }
    if (tier.startModel) out.add(tier.startModel);
  }
  return [...out];
}

/** A tier the project actually declares — never a name written here. */
const A_TIER = Object.keys(JSON.parse(readFileSync(SETTINGS, 'utf8')).ladders)[0];

const BASE = {
  ORCH_GATE_MODEL: 'z-ai/glm-5.2',
  ESCALATION_MODEL: 'z-ai/glm-5.2',
  ESCALATION_MODEL_HIGH: 'MiniMax-M3',
  EPAM_MODEL: 'MiniMax-M3',
};

describe('compute_escalation_profile resolves every rung it prices', () => {
  it('produces a profile at all — otherwise the assertions below prove nothing', () => {
    const p = profile({ ...BASE, EPAM_STORY_LADDER_TIER: A_TIER });
    expect(p.modelProfile, 'no modelProfile emitted').toBeTruthy();
    expect(p.modelProfile.rung1.model).toBeTruthy();
  });

  it('gives the TOP rung a real model when the story declares its tier', () => {
    const p = profile({ ...BASE, EPAM_STORY_LADDER_TIER: A_TIER });
    expect(
      p.modelProfile.k3.model,
      'the top rung has no model — the cost model prices an attempt on a model that does not exist',
    ).not.toBe('');
    expect(declaredRungs(), 'the top rung names a model this project never declared')
      .toContain(p.modelProfile.k3.model);
  });

  it('the caller supplies the tier — it is not left to an unset variable', () => {
    // The function reads EPAM_STORY_LADDER_TIER. Something must SET it from the story's
    // own declaration, or _hops is empty and every derived rung silently resolves to "".
    // A property of the file set, which no single execution can observe.
    const src = readFileSync(CPA, 'utf8');
    expect(src, 'nothing exports EPAM_STORY_LADDER_TIER — the tier branch can never fire')
      .toMatch(/export\s+EPAM_STORY_LADDER_TIER|EPAM_STORY_LADDER_TIER=/);
    // ...and it must come from the story's declared tier, not a tier named in the engine.
    expect(src).toMatch(/ladderTier/);
  });

  it('names no tier or model of its own — the vocabulary is the project\'s', () => {
    const src = readFileSync(CPA, 'utf8');
    const fn = extractFn().replace(/^\s*#.*$/gm, '');
    for (const m of declaredRungs()) {
      expect(fn, `compute_escalation_profile hardcodes the model '${m}'`).not.toContain(m);
    }
    expect(src.length).toBeGreaterThan(0);
  });
});
