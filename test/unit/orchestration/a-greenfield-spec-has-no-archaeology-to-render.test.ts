/**
 * A GREENFIELD SPEC HAS NO ARCHAEOLOGY TO RENDER.
 *
 * spec-agent-openspec carries __BROWNFIELD_ARCHAEOLOGY_BLOCK__ and __LOCATION_HINT_SCHEMA_LINE__,
 * both produced by buildBrownfieldArchaeologyBlock — which, for a project that declares
 * EPAM_BROWNFIELD=0, produces nothing: there is no existing code to locate a fix site in and no
 * ticket to dig through. That is a real state, not a failed lookup, and the renderer's rule is
 * that a template says so in `mayBeEmpty`. It did not, so the £0 greenfield run rendered the spec
 * prompt three times per story, refused three times with no model involved, and the scaffold
 * phase aborted at "Step 1: Specification pass". Found 2026-09-13 by the greenfield integration
 * test, one stage past the mint.
 *
 * Executed: the real block builder under a greenfield environment, its output handed to the real
 * renderer of the real template.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const { renderEngineTemplate, placeholdersIn, templatePath } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
const fs = require('node:fs');

describe('a greenfield spec has no archaeology to render', () => {
  const greenfield = { ...process.env, EPAM_BROWNFIELD: '0' };
  const { archaeologyBlock, schemaLine } = spec.buildBrownfieldArchaeologyBlock(greenfield, { hasAcceptanceCriteria: true, hasReferencedDocs: false });

  it('the builder produces nothing for a greenfield project — the premise of this test', () => {
    expect(archaeologyBlock).toBe('');
    expect(schemaLine).toBe('');
  });

  it('the spec prompt renders with both blanks, and the rest of the story still reaches it', () => {
    const doc = JSON.parse(fs.readFileSync(templatePath('spec-agent-openspec'), 'utf8'));
    // A seam-declared prompt renders from THE PROJECT'S copy, which the mint builds from the
    // template through the contract — so the copy carries what the template declares, no more.
    const { buildGeneratedDoc } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));
    const projectDir = fs.mkdtempSync(join(require('node:os').tmpdir(), 'gf-spec-'));
    fs.mkdirSync(join(projectDir, 'prompts'));
    fs.writeFileSync(join(projectDir, 'prompts/spec-agent-openspec.json'), JSON.stringify(buildGeneratedDoc(doc, doc.body)));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = projectDir;
    try {
    const values: Record<string, string> = {};
    for (const p of placeholdersIn(doc.body || Object.values(doc.bodies || {}).join('\n'))) values[p] = `value of ${p.replace(/_/g, ' ').trim()}`;
    values.__BROWNFIELD_ARCHAEOLOGY_BLOCK__ = archaeologyBlock;
    values.__LOCATION_HINT_SCHEMA_LINE__ = schemaLine;
    values.__STORY_ID__ = 'GF-1';
    let out = '';
    expect(() => { out = renderEngineTemplate('spec-agent-openspec', values); }).not.toThrow();
    expect(out).toContain('GF-1');
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
    } finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; fs.rmSync(projectDir, { recursive: true, force: true }); }
  });

  it('a brownfield project still supplies both — the blanks are declared, not ignored', () => {
    const b = spec.buildBrownfieldArchaeologyBlock({ ...process.env, EPAM_BROWNFIELD: '1' }, { hasAcceptanceCriteria: true, hasReferencedDocs: false });
    expect(b.archaeologyBlock.length).toBeGreaterThan(0);
    expect(b.schemaLine.length).toBeGreaterThan(0);
  });
});
