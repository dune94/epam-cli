/**
 * THE WRITER RENDERS FOR A PROJECT WITH NO DEPENDENCY DECLARATION.
 *
 * __MODULE_RESOLUTION__ is produced by _module_resolution_context (claude.sh), which returns
 * nothing — by design, `[ -f "$_cfg" ] || return 0` — for a project that declares no
 * dependency-check.json. The writer's template did not declare that emptiness, so the writer
 * prompt refused to render for every story of such a project and every attempt failed before a
 * model was asked (£0 brownfield harness run 6, 2026-09-14; latent since the writer prompt moved
 * to the template layer on 2026-08-16). Judged by rendering the real template, the way the mint
 * provisions it, with that one value empty.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const TPL = join(ROOT, 'orchestrations/prompts/templates');
const { renderEngineTemplate, placeholdersIn } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
const SRC = engineSource(join(ROOT, 'orchestrations/scripts/claude.sh'));

describe('the writer renders for a project with no dependency declaration', () => {
  it('the producer returns nothing for such a project — the premise', () => {
    const fn = SRC.slice(SRC.indexOf('_module_resolution_context() {'));
    expect(fn.slice(0, 400)).toMatch(/\[ -f "\$_cfg" \] \|\| return 0/);
  });
  // Every template the writer's runner renders whole that carries the placeholder.
  const ids = engineSource(join(ROOT, 'orchestrations/scripts/claude.sh')).match(/render_engine_prompt ([a-z0-9-]+)/g)!.map((m) => m.split(' ')[1])
    .filter((id, i, a) => a.indexOf(id) === i)
    .filter((id) => { try { const d = JSON.parse(engineSource(join(TPL, `${id}.json`))); return typeof d.body === 'string' && placeholdersIn(d.body).includes('__MODULE_RESOLUTION__'); } catch { return false; } });
  it('some rendered template carries __MODULE_RESOLUTION__', () => { expect(ids.length).toBeGreaterThan(0); });
  it.each(ids)('%s renders with __MODULE_RESOLUTION__ empty', (id) => {
    const doc = JSON.parse(engineSource(join(TPL, `${id}.json`)));
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = p === '__MODULE_RESOLUTION__' ? '' : optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    const { buildGeneratedDoc } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));
    const projectDir = mkdtempSync(join(tmpdir(), 'writer-render-')); mkdirSync(join(projectDir, 'prompts'));
    writeFileSync(join(projectDir, `prompts/${id}.json`), JSON.stringify(buildGeneratedDoc(doc, doc.body)));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = projectDir;
    let out = '';
    try { expect(() => { out = renderEngineTemplate(id, values); }).not.toThrow(); }
    finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; rmSync(projectDir, { recursive: true, force: true }); }
    expect(out.length).toBeGreaterThan(200);
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
  });
});
