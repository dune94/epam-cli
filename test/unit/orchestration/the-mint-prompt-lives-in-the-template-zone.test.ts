/**
 * THE MINT PROMPT LIVES IN THE TEMPLATE ZONE.
 *
 * Operator mandate, 2026-08-15: every prompt belongs in orchestrations/prompts/templates,
 * and the mint's prompts are no exception. Today `mintProjectAgents` loads its prompt from
 * `dist/sdk.js` — a BUILD ARTEFACT compiled from src/scaffold/prompts.ts. A prompt that
 * only exists inside a compiled bundle cannot be diffed, reviewed per project, corrected by
 * self-heal, or evaluated by mock3, whose stated job is to evaluate the prompts of every
 * agent. Editing it means editing and rebuilding the engine.
 *
 * THE BOOTSTRAP PROBLEM, which is why this one is COPIED and not generated. Project prompts
 * are supposed to be generated into <project>/prompts/ by the mint. But the mint needs its
 * OWN prompt before it can run, and the prompt-builder needs ITS own prompt before it can
 * build anything. Those two cannot be outputs of the process that requires them. They are
 * provisioned at pre-launch by copying the template verbatim; everything else is generated.
 *
 * MIGRATION MUST NOT CHANGE THE PROMPT. The roster this text produces is the roster every
 * later stage runs under, so a migration that "tidies" the wording silently changes which
 * agents exist. These tests pin the rendered template to the CURRENT compiled output byte
 * for byte. They fail if the migration drifts, and they fail if the code drifts away from
 * the template afterwards.
 *
 * Nothing here is project-specific: the fixed roles come from the engine's own declaration.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/prompt-library.js');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');

/**
 * The oracle is the SOURCE, not dist/. Only getAgentProposalPrompt is re-exported from
 * sdk.js; the other two are bundled into the CLI and not individually reachable. Comparing
 * against source also means a stale build cannot make a drifted template look correct — the
 * separate check below pins dist to source for the one the mint actually loads at runtime.
 */
import {
  getAgentProposalPrompt,
  getManifestAnalysisPrompt,
  getPrdGenerationPrompt,
} from '../../../src/scaffold/prompts.js';
import { FIXED_AGENT_ROLES } from '../../../src/scaffold/prdTypes.js';
// The naming rule is derived from the invocation registry, not written in the template, so the
// template render must be given the same value the source render computes — otherwise this
// oracle would compare a rendered rule against an unreplaced placeholder.
import { mintNameRule } from '../../../src/scaffold/seamVocabulary.js';

function fixedRoles(): string[] {
  return [...FIXED_AGENT_ROLES];
}

/** Render a TEMPLATE (not a project copy) with supplied values, as the bootstrap path will. */
function renderTemplate(id: string, values: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mintprompt-'));
  try {
    // The bootstrap copies the template into a project prompts dir verbatim, so render it
    // exactly as prompt-library will once it is there.
    const projectDir = join(dir, 'proj');
    const promptsDir = join(projectDir, 'prompts');
    spawnSync('mkdir', ['-p', promptsDir]);
    const src = readFileSync(join(TEMPLATES, `${id}.json`), 'utf8');
    writeFileSync(join(promptsDir, `${id}.json`), src);
    const valuesFile = join(dir, 'values.json');
    writeFileSync(valuesFile, JSON.stringify(values));
    const res = spawnSync(process.execPath, [LIB, 'render', id, projectDir, valuesFile], {
      encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`render failed: ${res.stderr}`);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the agent-proposal (mint) prompt is a template', () => {
  it('the template file exists in the template zone', () => {
    expect(existsSync(join(TEMPLATES, 'agent-proposal.json')),
      'the mint prompt is still only inside dist/sdk.js').toBe(true);
  });

  it('renders BYTE-IDENTICAL to what the engine compiles today', () => {
    // The migration is a move, not an edit. Different bytes here means the roster changes.
    const roles = fixedRoles();
    const out = renderTemplate('agent-proposal', {
      __FIXED_ROLE_COUNT__: String(roles.length),
      __FIXED_ROLE_LIST__: roles.join(', '),
      __NAME_RULE__: mintNameRule(),
    });
    expect(out).toBe(getAgentProposalPrompt());
  });

  it('carries no role name of its own — the list is supplied', () => {
    // Fixed roles are an engine declaration. Baking them into the prompt text would fork
    // them, and the fork would drift silently.
    const body = JSON.parse(readFileSync(join(TEMPLATES, 'agent-proposal.json'), 'utf8')).body;
    for (const r of fixedRoles()) {
      expect(body, `the template hardcodes the role '${r}'`).not.toContain(r);
    }
    expect(body).toContain('__FIXED_ROLE_LIST__');
  });
});

describe('the other scaffold prompts are templates too', () => {
  it('manifest-analysis renders byte-identical', () => {
    expect(renderTemplate('manifest-analysis', {})).toBe(getManifestAnalysisPrompt());
  });

  it('prd-generation renders byte-identical for a given prefix and role list', () => {
    const prefix = 'MOCK';
    const roles = ['alpha-engineer', 'beta-engineer'];
    expect(renderTemplate('prd-generation', {
      __STORY_ID_PREFIX__: prefix,
      __AGENT_ROLES__: roles.join(', '),
    })).toBe(getPrdGenerationPrompt(prefix, roles));
  });

  it('prd-generation carries no prefix or role of its own', () => {
    const body = JSON.parse(readFileSync(join(TEMPLATES, 'prd-generation.json'), 'utf8')).body;
    expect(body).not.toContain('MOCK');
    expect(body).toContain('__STORY_ID_PREFIX__');
    expect(body).toContain('__AGENT_ROLES__');
  });
});

describe('the runtime artefact matches the source', () => {
  it('dist/sdk.js exports the same mint prompt as src — a stale build cannot hide drift', () => {
    // The mint loads dist/sdk.js at runtime. If dist lags src, the roster is minted from
    // instructions nobody is reviewing.
    const dist = require(join(ROOT, 'dist/sdk.js'));
    expect(dist.getAgentProposalPrompt()).toBe(getAgentProposalPrompt());
  });
});
