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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

/**
 * THE MINT LOADS THIS FROM dist/sdk.js, NOT FROM src/.
 *
 * templatesDir() resolves the template directory relative to __dirname, and the loop asserted that
 * "dist/ and src/scaffold/ are both two levels below the repository root". They are not:
 * src/scaffold/ is two levels down, dist/ is ONE. Every candidate therefore resolved above the
 * repository when running from the compiled bundle, getAgentProposalPrompt threw, and the FIRST
 * agent of every run would have failed — spec-mode-runner.js raises "[mint] cannot load the agent
 * proposal prompt from dist/sdk.js" on exactly that.
 *
 * The existing tests never caught it because they exercise the source tree, where the old guess is
 * correct. The mint does not use the source tree. This one requires the same artefact the mint
 * requires, which is the only way this class of defect is visible.
 */
describe('the compiled bundle can find the template layer', () => {
  const DIST = join(__dirname, '../../../dist/sdk.js');

  it('dist/sdk.js exists — the mint refuses to run without it', () => {
    expect(existsSync(DIST),
      'dist/sdk.js is missing; run tsup. The mint loads getAgentProposalPrompt from it.',
    ).toBe(true);
  });

  it('getAgentProposalPrompt renders when called from the compiled bundle', () => {
    const r = spawnSync(process.execPath, ['-e',
      'process.stdout.write(String(require(process.argv[1]).getAgentProposalPrompt()))', DIST,
    ], { encoding: 'utf8' });
    expect(r.status, `the mint would fail here: ${r.stderr.slice(0, 300)}`).toBe(0);
    expect(r.stdout.length, 'the compiled bundle rendered an empty prompt').toBeGreaterThan(200);
  });

  it('the template location comes from config, not from engine code', () => {
    // WAS: asserted the candidate list contained a '..' entry — i.e. that the walk guessed the
    // right number of levels. That mechanism is gone: guessing levels is what produced three
    // different wrong answers in three files. The location is declared in
    // orchestrations/config/engine-layout.json, so the requirement is that no engine file spells
    // it out at all.
    const resolver = readFileSync(join(__dirname, '../../../src/prompts/templatesDir.ts'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(resolver, 'the resolver names the template directory in code')
      .not.toMatch(/'prompts'\s*,\s*'templates'|orchestrations\/prompts\/templates/);
    expect(resolver, 'the location is no longer read from config').toMatch(/engine-layout\.json/);
  });
});
