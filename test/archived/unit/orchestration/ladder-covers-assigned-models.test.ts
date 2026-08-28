/**
 * Root cause of a live defect (SKY-003 sandbox test, 2026-07-05): SKY-002/003/004
 * are all assigned `moonshotai/kimi-k2` as their base model (per
 * travel-app-prd.canonical.json's `.model` field), but neither
 * EPAM_MODEL_LADDER_MEDIUM nor _HIGH had an entry keyed on it —
 * get_model_ladder_step() silently returned empty ("no ladder step — keeping
 * model"), so a story on kimi-k2 could reach Rung 3 (max rung, "effort → high
 * (maximum)") without the model EVER actually changing.
 *
 * This was only discovered by running a full live sandbox test with real
 * tokens (45 minutes, 8 attempts) — exactly the kind of bug a cheap, free,
 * static test should have caught instead. This file is that test: it reads
 * every distinct model actually assigned to a story in the canonical PRD and
 * asserts each one has an escalation entry in BOTH ladder tiers (as "from"
 * keys, pipe-separated in tier3-travel-app-run.sh). Generic on purpose — this
 * doesn't hardcode "moonshotai/kimi-k2" as a special case; it derives the set
 * of models to check directly from the PRD, so any future story assigned a
 * new base model is automatically covered.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const PRD_CANONICAL = join(REPO_ROOT, 'orchestrations/travel-app-prd.canonical.json');

function parseLadderFromKeys(varName: string): string[] {
  const src = readFileSync(TIER3_SH, 'utf8');
  const idx = src.indexOf(`export ${varName}=`);
  expect(idx, `${varName} export not found in tier3-travel-app-run.sh`).toBeGreaterThan(-1);
  const lineEnd = src.indexOf('\n', idx);
  const line = src.slice(idx, lineEnd);
  // Extract the default value inside ${VAR:-...} — greedy match up to the LAST
  // `}"` on the line, since the default value itself contains nested ${...}
  // references (e.g. ${ESCALATION_MODEL}) that a non-greedy match would stop at.
  const defaultMatch = line.match(/:-(.*)\}"$/);
  expect(defaultMatch, `Could not parse default value for ${varName}`).not.toBeNull();
  const ladderValue = expandShellVars(defaultMatch![1], src);
  // Pipe-separated "from=to" pairs; collect the "from" side of each
  return ladderValue.split('|').map(pair => pair.split('=')[0]);
}

/**
 * Resolve ${VAR} against the script's OWN `export VAR="${VAR:-default}"` lines.
 *
 * The ladder is written in terms of ${ESCALATION_MODEL}/${ESCALATION_MODEL_HIGH},
 * but a story's `model` field is a literal ("z-ai/glm-5.2"). Comparing the two
 * verbatim only ever matched while stories happened to be pinned to a literal that
 * also appeared literally in the ladder — it did not survive stories moving onto
 * the escalation model itself. Expanding first checks what the shell ACTUALLY
 * produces at runtime, which is what the guard is for.
 */
function expandShellVars(value: string, src: string): string {
  return value.replace(/\$\{([A-Z_]+)\}/g, (whole, name) => {
    const m = src.match(new RegExp(`export ${name}="\\$\\{${name}:-([^}"]+)\\}"`));
    return m ? m[1] : whole;
  });
}

function assignedModels(): string[] {
  const prd = JSON.parse(readFileSync(PRD_CANONICAL, 'utf8'));
  const models = new Set<string>();
  for (const story of prd.stories) {
    if (story.model) models.add(story.model);
  }
  return [...models];
}

describe('model ladder covers every model actually assigned to a story (both tiers)', () => {
  const models = assignedModels();

  it('the canonical PRD assigns at least one model to check (sanity check the test itself has data)', () => {
    expect(models.length).toBeGreaterThan(0);
  });

  it('EPAM_MODEL_LADDER_MEDIUM has a "from" entry for every assigned model', () => {
    const fromKeys = parseLadderFromKeys('EPAM_MODEL_LADDER_MEDIUM');
    const missing = models.filter(m => !fromKeys.includes(m));
    expect(
      missing,
      `Model(s) assigned to a story but missing from EPAM_MODEL_LADDER_MEDIUM: ${missing.join(', ')} — ` +
        `a story on this model can reach Rung 2 escalation and get "no ladder step — keeping model" ` +
        `(confirmed live: SKY-003 exhausted all 8 attempts stuck on moonshotai/kimi-k2 for exactly this reason)`,
    ).toEqual([]);
  });

  it('EPAM_MODEL_LADDER_HIGH has a "from" entry for every assigned model', () => {
    const fromKeys = parseLadderFromKeys('EPAM_MODEL_LADDER_HIGH');
    const missing = models.filter(m => !fromKeys.includes(m));
    expect(
      missing,
      `Model(s) assigned to a story but missing from EPAM_MODEL_LADDER_HIGH: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every assigned model escalates to a DIFFERENT model in EPAM_MODEL_LADDER_MEDIUM (a self-referencing entry would be a no-op)', () => {
    const src = readFileSync(TIER3_SH, 'utf8');
    const idx = src.indexOf('export EPAM_MODEL_LADDER_MEDIUM=');
    const lineEnd = src.indexOf('\n', idx);
    const line = src.slice(idx, lineEnd);
    const defaultMatch = line.match(/:-(.*)\}"$/);
    const pairs = defaultMatch![1].split('|').map(p => {
      const [from, to] = p.split('=');
      return { from, to };
    });
    for (const model of models) {
      const entry = pairs.find(p => p.from === model);
      if (entry) {
        expect(entry.to, `${model} escalates to itself in EPAM_MODEL_LADDER_MEDIUM — not a real escalation`).not.toBe(model);
      }
    }
  });
});
