// ── LLM prompts for `epam new` project scaffolding ──────────────────────────
//
// THE TEXT IS NOT HERE. Every prompt lives in orchestrations/prompts/templates — all of them, no
// exceptions — and this module renders three of them.
//
// It used to hold the text as template literals, and `dist/sdk.js` is what the orchestration mint
// requires to get its agent-proposal prompt. So the first agent of every run took its
// instructions from compiled TypeScript: the template that had been written for it, placeholders
// and all, was rendered by nothing, and editing it changed nothing. Correcting a wording problem
// meant editing this file and rebuilding.
//
// The three templates were byte-identical to the text they replaced, so this move changed no
// wording. Both callers — `epam new` and the orchestration mint — now read the same file, which is
// the point: two paths rendering one prompt cannot drift.

import { readFileSync } from 'node:fs';
import { templatesDir } from '../prompts/templatesDir';
import { join } from 'node:path';

import { FIXED_AGENT_ROLES } from './prdTypes.js';
import { mintNameRule } from './seamVocabulary.js';

/**
 * The template layer, found from this module rather than from the working directory: `epam new`
 * runs wherever the user happens to be, and the orchestration mint loads this through dist/sdk.js.
 */

/**
 * Render one template. STRICT IN BOTH DIRECTIONS, like the pipeline's own renderers: a placeholder
 * left unreplaced means evidence silently never reached the model, and a value nobody uses means
 * the caller believes it supplied something that went nowhere.
 */
function render(id: string, values: Record<string, string> = {}): string {
  const file = join(templatesDir(), `${id}.json`);
  let doc: { body?: string; placeholders?: string[] };
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`[prompts] cannot load template '${id}' from ${file}: ${(e as Error).message}`);
  }
  if (!doc.body) throw new Error(`[prompts] template '${id}' has no body`);

  let out = doc.body;
  for (const [key, value] of Object.entries(values)) {
    if (!out.includes(key)) throw new Error(`[prompts] template '${id}' has no placeholder ${key}`);
    out = out.split(key).join(value);
  }
  const left = (doc.placeholders || []).filter((p) => out.includes(p));
  if (left.length) throw new Error(`[prompts] template '${id}' left ${left.join(', ')} unreplaced`);
  return out;
}

/** Phase A: analyse the manifest and generate clarifying questions. */
export function getManifestAnalysisPrompt(): string {
  return render('manifest-analysis');
}

/** Phase B: propose project-specific agent roles. */
export function getAgentProposalPrompt(): string {
  // The naming rule is DERIVED from the invocation registry, not written here or in the
  // template: the registry decides which name shapes resolve to a seam, and a rule written
  // separately drifted from it — 'ending in "-engineer" or "-specialist"' offered a shape that
  // resolves to nothing and killed the run at mint.
  return render('agent-proposal', {
    __FIXED_ROLE_COUNT__: String(FIXED_AGENT_ROLES.length),
    __FIXED_ROLE_LIST__: FIXED_AGENT_ROLES.join(', '),
    __NAME_RULE__: mintNameRule(),
  });
}

/** Phase C: generate the full prd.json. */
export function getPrdGenerationPrompt(prefix: string, agentRoles: string[]): string {
  return render('prd-generation', {
    __STORY_ID_PREFIX__: prefix,
    __AGENT_ROLES__: agentRoles.join(', '),
  });
}
