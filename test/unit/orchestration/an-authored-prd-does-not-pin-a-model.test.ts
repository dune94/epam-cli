/**
 * THE LADDER OWNS THE MODEL. AN AUTHORED PRD DOES NOT.
 *
 * A story-level `model` outranks the ladder: run-agent-orchestration.sh says so in place — "THE
 * LADDER IS THE ONLY SOURCE ... a run-wide pin that silently outranked the seam, behind a literal
 * that always answered", which is how two of three ladder positions resolved no model for months
 * and nothing noticed.
 *
 * mock3's authored PRD pinned MiniMax-M3 on both stories. Under a mockserver rehearsal — whose
 * whole purpose is to cost nothing and whose set declares a Claude ladder — the writer ran
 * `provider=minimax model=MiniMax-M3`, exhausted a ladder that was not the declared one, and
 * abandoned both stories without ever climbing the ladder that was.
 *
 * A pin also silently defeats the provider set: EPAM_PROVIDER_SET routes the seams, and a pinned
 * story ignores it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECTS = path.join(__dirname, '../../../orchestrations/projects');

function authoredPrds(): string[] {
  return fs.readdirSync(PROJECTS)
    .map((d) => path.join(PROJECTS, d, 'prd.authored.json'))
    .filter((f) => fs.existsSync(f));
}

describe('an authored PRD does not pin a model', () => {
  it('there are authored PRDs to check — otherwise this proves nothing', () => {
    expect(authoredPrds().length).toBeGreaterThan(0);
  });

  it.each(authoredPrds())('%s lets the ladder choose', (file) => {
    const prd = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pinned = (prd.stories || [])
      .filter((s: any) => s && s.model)
      .map((s: any) => `${s.id}=${s.model}`);
    expect(pinned, `these stories pin a model, so the ladder and the provider set are both `
      + `overridden: ${pinned.join(', ')}`).toEqual([]);
  });
});
