/**
 * THE ROSTER SPECIALISER DID NOT RECEIVE prd.configuration.
 *
 * Run 20260916T200108Z (regintel greenfield): prd.configuration declares
 * configuration.sourceRepoReadOnly — the path the engineer must copy dial/, docs/,
 * requirements.txt and manifest.md FROM. The roster-specialisation seam received
 * stories but never the prd object, so it could not see that key. The specialiser
 * invented a workaround: "the codeline declares no manifest configuration, so
 * configuration.sourceRepoReadOnly does not resolve to a path you can verify —
 * obtain the path from the run configuration or team-lead." The writer then failed
 * because the value it needed was neither in the spec nor in the persona.
 *
 * The fix — identical in shape to the spec-agent fix landed in commit 2f9c5c8f —
 * adds __PRD_CONFIGURATION_BLOCK__ to the roster-specialisation template and wires
 * the value through roster-seams.js (which is handed the full prd object) and
 * mint-agents-step.js (which calls rosterSeams and holds prd).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const TEMPLATE = join(REPO_ROOT, 'orchestrations/prompts/templates/roster-specialisation.json');
const ROSTER_SEAMS = join(REPO_ROOT, 'orchestrations/scripts/lib/roster-seams.js');
const MINT_STEP = join(REPO_ROOT, 'orchestrations/scripts/mint-agents-step.js');
const { renderEngineTemplate } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const rosterSrc = readFileSync(ROSTER_SEAMS, 'utf8');
const mintSrc = readFileSync(MINT_STEP, 'utf8');

// ── Template contract ─────────────────────────────────────────────────────────

describe('roster-specialisation — prd.configuration contract', () => {
  it('THE GAP: template declares __PRD_CONFIGURATION_BLOCK__ slot', () => {
    expect(
      template.placeholders,
      'roster-specialisation has no __PRD_CONFIGURATION_BLOCK__ slot — the specialiser '
      + 'cannot see configuration keys like sourceRepoReadOnly and will invent workarounds',
    ).toContain('__PRD_CONFIGURATION_BLOCK__');
  });

  it('__PRD_CONFIGURATION_BLOCK__ is in mayBeEmpty — projects with no configuration must still render', () => {
    expect(
      template.mayBeEmpty,
      'a project with no prd.configuration must still render without error',
    ).toContain('__PRD_CONFIGURATION_BLOCK__');
  });

  it('template body contains __PRD_CONFIGURATION_BLOCK__', () => {
    expect(template.body).toContain('__PRD_CONFIGURATION_BLOCK__');
  });

  it('rendered prompt carries configuration values when prd declares them', () => {
    const cfgJson = JSON.stringify({ sourceRepoReadOnly: '/home/user/workshop', protectedPaths: ['dial/'] }, null, 2);
    const values: Record<string, string> = {
      __CANONICAL_COPY_PATH__: '/tmp/canonical.json',
      __CANONICAL_DIR__: '/tmp/canonical',
      __PROJECT_CONTEXT__: 'ctx',
      __CODELINE_CONTEXT__: '- regintel-build (/repo)',
      __STACK__: 'python',
      __PREVIOUS_REFUSAL__: '',
      __DECLARED_SEAMS__: '- spec-agent',
      __SURVEY_LEADS__: '',
      __PRD_CONFIGURATION_BLOCK__: `\n## Project Configuration\n\`\`\`json\n${cfgJson}\n\`\`\`\n`,
    };
    const rendered = renderEngineTemplate('roster-specialisation', values);
    expect(rendered.length, 'nothing rendered — assertions below would be vacuous').toBeGreaterThan(200);
    expect(rendered, 'configuration values did not reach the rendered specialiser prompt')
      .toContain('sourceRepoReadOnly');
    expect(rendered).toContain('/home/user/workshop');
  });

  it('rendered prompt is valid when __PRD_CONFIGURATION_BLOCK__ is empty — no configuration declared', () => {
    const values: Record<string, string> = {
      __CANONICAL_COPY_PATH__: '/tmp/canonical.json',
      __CANONICAL_DIR__: '/tmp/canonical',
      __PROJECT_CONTEXT__: 'ctx',
      __CODELINE_CONTEXT__: '- regintel-build (/repo)',
      __STACK__: 'python',
      __PREVIOUS_REFUSAL__: '',
      __DECLARED_SEAMS__: '- spec-agent',
      __SURVEY_LEADS__: '',
      __PRD_CONFIGURATION_BLOCK__: '',
    };
    const rendered = renderEngineTemplate('roster-specialisation', values);
    expect(rendered.length).toBeGreaterThan(200);
    expect(rendered).not.toContain('sourceRepoReadOnly');
  });
});

// ── Source wiring ─────────────────────────────────────────────────────────────

describe('roster-specialisation — wiring', () => {
  it('THE GAP: roster-seams.js passes __PRD_CONFIGURATION_BLOCK__ to the specialiser', () => {
    expect(
      rosterSrc,
      'roster-seams.js never sets __PRD_CONFIGURATION_BLOCK__ — the value cannot reach the prompt',
    ).toContain('__PRD_CONFIGURATION_BLOCK__');
  });

  it('roster-seams.js computes prdConfigurationBlock from prd.configuration', () => {
    expect(rosterSrc).toMatch(/prdConfigurationBlock|prd\.configuration|prd_configuration/i);
  });

  it('mint-agents-step.js passes prd to rosterSeams', () => {
    expect(
      mintSrc,
      'mint-agents-step.js never passes prd into rosterSeams — configuration cannot propagate',
    ).toMatch(/rosterSeams\s*\(\s*\{[^}]*\bprd\b/s);
  });
});
