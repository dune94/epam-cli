/**
 * THE HIGHEST TIER WAS BLOCKED AT FOUR SEPARATE LAYERS, EACH SILENTLY.
 *
 * A story asking for the strongest escalation chain got the WEAKEST one, and nothing said so:
 *
 *   1. llm-settings.schema.json    ladders.additionalProperties:false with properties
 *                                  {high, medium} — a `highest` key failed validation
 *   2. llm-settings.json           no `highest` ladder defined
 *   3. claude.sh loader            only .ladders.high and .ladders.medium were serialised into
 *                                  EPAM_MODEL_LADDER_* env vars
 *   4. get_model_ladder_step       `case "$tier" in high) ...; *) MEDIUM ;; esac` — `highest`
 *                                  fell through the catch-all onto the medium ladder
 *   5. classify_ladder_tier        `case "$_prd_tier" in medium|high)` — a PRD asking for
 *                                  `highest` was discarded before any of the above mattered
 *
 * Layer 4 is the dangerous one: a ladder WAS found, the run looked entirely normal, and the
 * story escalated along a chain it never requested. Silent wrong-answer, not a visible failure.
 *
 * Tier names are configuration (`ladders.*`), so none of them appear as literals in the engine.
 * These tests read the configured tiers and assert behaviour for each, which is what keeps a
 * fourth tier from needing a sixth code change.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
// The ladder SERIALISATION moved to a shared lib on 2026-08-13 so entry points that never
// load claude.sh (detective-rerun.sh) get the same ladders. claude.sh still owns the
// RESOLVER (get_model_ladder_step), so this file reads both.
const LADDER_LIB = readFileSync(join(ROOT, 'orchestrations/scripts/lib/model-ladders.sh'), 'utf8');
const CFG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-settings.schema.json'), 'utf8'));
const TIERS: string[] = Object.keys(CFG.ladders);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  expect(m, `no definition for ${name}()`).toBeTruthy();
  const i = (m as RegExpExecArray).index;
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
}

const ladderEnv = () => TIERS.map((t) =>
  `export EPAM_MODEL_LADDER_${t.toUpperCase()}=${JSON.stringify(
    (CFG.ladders[t].modelLadder ?? []).map((e: { from: string; to: string }) => `${e.from}=${e.to}`).join('|'))}`
).join('\n');

/** Runs the real classify_ladder_tier against a PRD declaring `tier`. */
function classify(tier: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tier-')); dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', ladderTier: tier }] }));
  return execFileSync('bash', ['-c',
    `set -u
     warning() { :; }; log() { :; }
     export EPAM_LADDER_TIERS=${JSON.stringify(TIERS.join('|'))}
     MAIN_PRD_FILE=${JSON.stringify(prd)}
     PRD_FILE=${JSON.stringify(prd)}
${lift('classify_ladder_tier')}
     classify_ladder_tier S-1`], { encoding: 'utf8' }).trim();
}

/** Runs the real get_model_ladder_step for a tier. */
function step(model: string, tier: string): string {
  return execFileSync('bash', ['-c',
    `set -u
     warning() { :; }
     ${ladderEnv()}
${lift('get_model_ladder_step')}
     get_model_ladder_step ${JSON.stringify(model)} ${JSON.stringify(tier)}`], { encoding: 'utf8' }).trim();
}

describe('layer 1+2: the tier exists in schema and config', () => {
  it('the schema admits a highest ladder', () => {
    expect(Object.keys(SCHEMA.properties.ladders.properties)).toContain('highest');
  });

  it('the project defines one', () => {
    expect(TIERS, `configured tiers: ${TIERS.join(', ')}`).toContain('highest');
    expect(CFG.ladders.highest.modelLadder.length).toBeGreaterThan(0);
  });

  it('every configured tier is declared in the schema — no tier can exist unvalidated', () => {
    for (const t of TIERS) expect(Object.keys(SCHEMA.properties.ladders.properties)).toContain(t);
  });
});

describe('layer 3: the loader serialises every configured tier', () => {
  // REPOINTED 2026-08-13. This asserted claude.sh named each tier literally. The serialisation
  // moved to lib/model-ladders.sh, which iterates the tiers the FILE declares rather than
  // naming three — so a project adding a tier needs no engine edit, and a hand-written list
  // cannot go stale the way the pinned HIGHEST ladder did. Naming tiers here would recreate
  // exactly the staleness this replaced.
  it('the shared loader serialises whatever tiers the project declares', () => {
    expect(LADDER_LIB, 'the loader hard-codes a tier list instead of reading the declared ones')
      .toContain('.ladders[$t].modelLadder');
    expect(LADDER_LIB, 'the tiers are not enumerated from the settings file')
      .toMatch(/\(\.ladders \/\/ \{\}\) \| keys/);
  });

  it('and every tier in TIERS is reachable through it', () => {
    // The behavioural half: each declared tier really does end up in its own env var.
    const out = execFileSync('bash', ['-c', `set +e
      . ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/model-ladders.sh'))}
      export_model_ladders ${JSON.stringify(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'))} >/dev/null 2>&1
      for t in ${TIERS.join(' ')}; do
        v=EPAM_MODEL_LADDER_$(printf '%s' "$t" | tr '[:lower:]' '[:upper:]')
        printf '%s=%s\n' "$t" "\${!v:-}"
      done`], { encoding: 'utf8' });
    for (const t of TIERS) {
      const line = out.split('\n').find((l) => l.startsWith(`${t}=`)) || '';
      expect(line.slice(t.length + 1), `tier '${t}' resolved to nothing`).toBeTruthy();
    }
  });
});

describe('layer 4: the resolver never silently substitutes another tier', () => {
  const START = 'MiniMax-M3';

  it('each tier resolves through its OWN configured chain', () => {
    for (const t of TIERS) {
      const edges = new Map<string, string>(
        CFG.ladders[t].modelLadder.map((e: { from: string; to: string }) => [e.from, e.to]));
      expect(step(START, t), `[${t}] resolved off its own ladder`).toBe(edges.get(START) ?? '');
    }
  });

  /** Walks the RESOLVER (not the config) to the end of a tier's chain. */
  function terminalVia(tier: string): string {
    let m = START;
    for (let i = 0; i < 6; i++) {
      const next = step(m, tier);
      if (!next || next === m) break;
      m = next;
    }
    return m;
  }

  it('THE DEFECT: highest does not fall through to the medium ladder', () => {
    // Compared against the RESOLVER's own output. An earlier version of this test compared the
    // CONFIG chains instead — and a mutation pointing `highest` at EPAM_MODEL_LADDER_MEDIUM
    // survived it, because the two chains share their first step. Config equality proves
    // nothing about which ladder the resolver actually read.
    expect(
      terminalVia('highest'),
      'highest resolved to the medium ladder — the operator asked for the strongest chain and ' +
      'got the weakest, with no warning',
    ).not.toBe(terminalVia('medium'));
  });

  it('highest reaches the top of its OWN configured chain', () => {
    const edges = new Map<string, string>(
      CFG.ladders.highest.modelLadder.map((e: { from: string; to: string }) => [e.from, e.to]));
    let expected = START;
    for (let i = 0; i < 6 && edges.get(expected) && edges.get(expected) !== expected; i++) {
      expected = edges.get(expected) as string;
    }
    expect(terminalVia('highest')).toBe(expected);
  });

  it('an unknown tier is not silently served a ladder', () => {
    // It may fall back, but the fallback must be announced — see the warning in the resolver.
    expect(SRC).toMatch(/unknown effort tier/);
  });
});

describe('layer 5: a PRD asking for a tier gets that tier', () => {
  it('every configured tier is honoured from the PRD', () => {
    for (const t of TIERS) {
      expect(classify(t), `PRD ladderTier '${t}' was discarded`).toBe(t);
    }
  });

  it('THE DEFECT: highest specifically survives classification', () => {
    expect(
      classify('highest'),
      'the case accepted only medium|high, so the operator\'s explicit choice was dropped',
    ).toBe('highest');
  });

  it('a tier with no configured ladder is refused and ANNOUNCED', () => {
    // It falls through to the historical classifier (which needs more of the run's state than
    // this harness provides, so the call may exit non-zero here) — what must never happen is
    // silent acceptance of a tier that has no ladder behind it.
    const dir = mkdtempSync(join(tmpdir(), 'tier-bad-')); dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', ladderTier: 'not-a-tier' }] }));
    const out = execFileSync('bash', ['-c',
      `set +e
       warning() { echo "WARN:$*"; }; log() { :; }
       export EPAM_LADDER_TIERS=${JSON.stringify(TIERS.join('|'))}
       MAIN_PRD_FILE=${JSON.stringify(prd)}
       PRD_FILE=${JSON.stringify(prd)}
${lift('classify_ladder_tier')}
       classify_ladder_tier S-1 2>&1 | head -5`], { encoding: 'utf8' });
    expect(out, 'an unbacked tier was accepted silently').not.toMatch(/^not-a-tier$/m);
    expect(out).toMatch(/WARN:.*no configured ladder/);
  });

  it('tier names are not hardcoded in the engine — the list comes from config', () => {
    const i = SRC.indexOf('classify_ladder_tier() {');
    const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
    expect(
      /case "\$_prd_tier" in\s*\n\s*medium\|high\)/.test(body),
      'the hardcoded medium|high pair is back — a new tier needs a code change again',
    ).toBe(false);
    expect(body).toContain('EPAM_LADDER_TIERS');
  });
});
