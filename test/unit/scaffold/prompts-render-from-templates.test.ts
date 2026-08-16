/**
 * PROMPTS LIVE IN THE TEMPLATE ZONE ONLY.
 *
 * These three held their text as template literals in TypeScript, and dist/sdk.js is what the
 * orchestration mint requires to get its agent-proposal prompt — so the FIRST agent of every run
 * took its instructions from compiled code. Templates had been written for all three, placeholders
 * and all, and were rendered by nothing: editing one changed nothing, and fixing a wording problem
 * meant editing TypeScript and rebuilding.
 *
 * It went unnoticed because the migration and the guard that certifies it both walk
 * orchestrations/ only. src/ was never in either sweep.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getManifestAnalysisPrompt, getAgentProposalPrompt, getPrdGenerationPrompt } from '../../../src/scaffold/prompts.js';
import { FIXED_AGENT_ROLES } from '../../../src/scaffold/prdTypes.js';

const TEMPLATES = join(__dirname, '../../../orchestrations/prompts/templates');
const body = (id: string) => JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8')).body as string;

describe('the scaffold prompts render from the template layer', () => {
  it('holds no prompt text of its own', () => {
    // The module may contain code and comments; what it must not contain is the prompt. Any of
    // these opening lines appearing here means the text came back.
    const src = readFileSync(join(__dirname, '../../../src/scaffold/prompts.ts'), 'utf8');
    for (const id of ['manifest-analysis', 'agent-proposal', 'prd-generation']) {
      const firstLine = body(id).split('\n')[0].slice(0, 60);
      expect(src, `${id}'s text is back in prompts.ts`).not.toContain(firstLine);
    }
  });

  it('renders the manifest-analysis template unchanged', () => {
    expect(getManifestAnalysisPrompt()).toBe(body('manifest-analysis'));
  });

  it('renders agent-proposal with the fixed roles substituted', () => {
    const out = getAgentProposalPrompt();
    expect(out, 'a placeholder survived, so the model receives literal __FIXED_ROLE_LIST__')
      .not.toMatch(/__[A-Z_]+__/);
    expect(out).toContain(String(FIXED_AGENT_ROLES.length));
    expect(out).toContain(FIXED_AGENT_ROLES.join(', '));
  });

  it('renders prd-generation with the prefix and roles substituted', () => {
    const out = getPrdGenerationPrompt('SKY', ['x-engineer', 'y-engineer']);
    expect(out, 'a placeholder survived').not.toMatch(/__[A-Z_]+__/);
    expect(out).toContain('SKY');
    expect(out).toContain('x-engineer, y-engineer');
  });

  it('depends only on templates that exist', () => {
    // A renamed or deleted template takes the mint down at its first invocation, which is the
    // FIRST agent of a run. Cheaper to know here.
    for (const id of ['manifest-analysis', 'agent-proposal', 'prd-generation']) {
      expect(() => body(id), `the module renders '${id}', which is not in the template layer`)
        .not.toThrow();
    }
  });
});
