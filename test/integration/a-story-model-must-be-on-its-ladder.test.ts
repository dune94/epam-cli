/**
 * RETEST OF fd72da1 — "a story may not be assigned a model its own ladder does not declare",
 * shipped with no test.
 *
 * The claim: prd-model-coordinator writes its assignment straight into the PRD and nothing looked
 * at it until the NEXT run's pre-flight, which then refused to start. Two mock3 stories were
 * assigned MiniMax-M3 on a claude stack; the provider map routed MiniMax-* to minimax, the writer
 * spent twelve attempts per story against a model this stack does not declare, and the resumed run
 * would not start at all.
 *
 * This matters beyond the commit: the SAME shape was observed again on 2026-08-30 — a mockserver
 * rehearsal whose writer ran `provider=minimax model=MiniMax-M3` while the active set declared a
 * Claude ladder. So the question this retest has to answer is not only "was a guard added" but
 * "does the guard actually bound what a story may be assigned".
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const HANDLER = join(__dirname, '../../orchestrations/scripts/lib/handlers/ladder-models.js');
const PROJECT = join(__dirname, '../../orchestrations/projects/mock3');

/** The models this run's ladder declares, as the pipeline itself asks for them. */
function declaredModels(set: string): string[] {
  const r = spawnSync(process.execPath, [HANDLER], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, EPAM_PROVIDER_SET: set, EPAM_PROJECT_CONFIG_DIR: PROJECT },
  });
  try { return JSON.parse((r.stdout || '[]').trim()); } catch { return []; }
}

describe('a story model must be on its ladder', () => {
  it('the handler answers at all — an empty answer would permit everything', () => {
    // A guard that returns [] is not a permissive guard, it is no guard: every model is equally
    // absent from an empty list, so callers cannot distinguish allowed from forbidden.
    const models = declaredModels('claude');
    expect(models.length, 'the ladder handler returned nothing').toBeGreaterThan(0);
  }, 60_000);

  it('the claude set declares claude models and NOT MiniMax-M3', () => {
    const models = declaredModels('claude');
    expect(models.some((m) => /claude/i.test(m)), 'no claude model in the claude set').toBe(true);
    expect(models, 'MiniMax-M3 is permitted on a claude stack — the exact assignment that made a '
      + 'writer spend twelve attempts per story against a model this stack cannot route')
      .not.toContain('MiniMax-M3');
  }, 60_000);

  it('the mockserver set — the free rehearsal — also excludes it', () => {
    // The 2026-08-30 observation: a rehearsal whose whole purpose is to cost nothing ran the
    // writer on minimax. Whatever assigned that model, it was not this set's ladder.
    const models = declaredModels('mockserver');
    expect(models.length).toBeGreaterThan(0);
    expect(models).not.toContain('MiniMax-M3');
  }, 60_000);

  it('the opening model is first, so a caller can take a default without choosing one', () => {
    const models = declaredModels('claude');
    expect(models[0], 'no opening model — a caller has nothing to start from').toBeTruthy();
  }, 60_000);
});
