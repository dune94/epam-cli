/**
 * AN AGENT MUST NOT PRODUCE OUTPUT NOTHING READS.
 *
 * The mint provisions a project copy of a prompt template into every project — 46 for one project.
 * There are TWO renderers and the split is deliberate:
 *
 *   prompt-library.js   reads the PROJECT copy. The template is never executed there, and a
 *                       missing project copy is a hard failure, because the project layer is what
 *                       self-heal may correct.
 *   engine-prompt.js    reads the TEMPLATE. For prompts the engine assembles before any project
 *                       agent exists — codeline discovery runs before the mint that would have
 *                       written its project copy.
 *
 * So a project copy of an engine-layer prompt can never be executed. It is paid work under
 * `generate` mode, it reads as live to anyone who opens it, and self-heal corrections land in it
 * and do nothing. One had already gone stale and silently dropped a whole numbered rule — the one
 * that makes discovery emit codeline facts.
 *
 * These tests pin the rule in BOTH directions: nothing is provisioned that no project-layer
 * renderer reads, and nothing a project-layer renderer reads is left unprovisioned.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const PROJECTS = join(ROOT, 'orchestrations/projects');

const templateIds = () => readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

const declaredLayer = (id: string): string => {
  const doc = JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8'));
  // Absent means engine: the engine layer is the larger set by an order of magnitude, and the
  // safe default is the one that provisions nothing rather than the one that writes files.
  return doc.layer || 'engine';
};

const projectDirs = () => readdirSync(PROJECTS)
  .map((n) => join(PROJECTS, n))
  .filter((p) => existsSync(join(p, 'prompts')));

describe('the mint provisions only prompts something reads', () => {
  it('finds templates and provisioned projects — not passing on empty lists', () => {
    expect(templateIds().length, 'no templates found').toBeGreaterThan(0);
    expect(projectDirs().length, 'no project has a provisioned prompt library').toBeGreaterThan(0);
  });

  it('every template declares a layer that is one of the two that exist', () => {
    const bad = templateIds().filter((id) => !['project', 'engine'].includes(declaredLayer(id)));
    expect(bad, `templates declare a layer that renders nowhere: ${bad.join(', ')}`).toEqual([]);
  });

  it('at least one template is project-layer — the rule has not collapsed to "provision nothing"', () => {
    const project = templateIds().filter((id) => declaredLayer(id) === 'project');
    expect(project.length,
      'no template is project-layer, so the project prompt library would be empty and every '
      + 'agent-facing prompt would fall back to a layer self-heal cannot correct',
    ).toBeGreaterThan(0);
  });

  it('no project holds a prompt whose template is engine-layer', () => {
    const engineLayer = new Set(templateIds().filter((id) => declaredLayer(id) === 'engine'));
    const unread: string[] = [];
    for (const dir of projectDirs()) {
      for (const f of readdirSync(join(dir, 'prompts')).filter((n) => n.endsWith('.json'))) {
        const id = f.replace(/\.json$/, '');
        if (engineLayer.has(id)) unread.push(`${dir.split('/').pop()}/prompts/${f}`);
      }
    }
    expect(unread,
      `${unread.length} provisioned prompt(s) can never be executed — engine-prompt.js reads the `
      + `template, never the project copy:\n  ${unread.slice(0, 12).join('\n  ')}`,
    ).toEqual([]);
  });

  it('every project-layer template is provisioned into a project that has a library', () => {
    // The other direction. prompt-library treats a missing project copy as a hard failure, so a
    // project-layer template that the mint skips takes its agent down at first invocation.
    const projectLayer = templateIds().filter((id) => declaredLayer(id) === 'project');
    const missing: string[] = [];
    for (const dir of projectDirs()) {
      for (const id of projectLayer) {
        if (!existsSync(join(dir, 'prompts', `${id}.json`))) {
          missing.push(`${dir.split('/').pop()} is missing ${id}`);
        }
      }
    }
    expect(missing, `a project-layer prompt was not provisioned:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
