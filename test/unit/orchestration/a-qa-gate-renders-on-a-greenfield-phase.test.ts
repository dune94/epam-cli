/**
 * A QA GATE RENDERS ON A GREENFIELD PHASE.
 *
 * Every QA gate prompt carries __GATE_SCOPE__, the brownfield addendum run-agent-orchestration.sh's
 * _brownfield_gate_scope produces — "Empty on greenfield, whose flow is deliberately unchanged."
 * No gate template declared that emptiness, so on a greenfield phase every gate refused to render
 * and the testing gates failed with "cannot render its prompt — refusing to gate with no
 * instructions" (£0 greenfield harness, 2026-09-13). The universe is every template carrying the
 * placeholder; each is rendered through the real renderer with the greenfield value (empty).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const TPL = join(ROOT, 'orchestrations/prompts/templates');
const { renderEngineTemplate, placeholdersIn } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

const gates = readdirSync(TPL).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  .filter((id) => (JSON.parse(readFileSync(join(TPL, `${id}.json`), 'utf8')).placeholders || []).includes('__GATE_SCOPE__'));

describe('a QA gate renders on a greenfield phase', () => {
  it('the orchestrator produces an EMPTY gate scope on greenfield — the premise', () => {
    const fn = SRC.slice(SRC.indexOf('_brownfield_gate_scope() {'));
    expect(fn.slice(0, 200)).toMatch(/\[ "\$\{EPAM_BROWNFIELD:-0\}" = "1" \] \|\| return 0/);
    expect(gates.length, 'no template carries __GATE_SCOPE__').toBeGreaterThan(0);
  });
  it.each(gates)('%s declares __GATE_SCOPE__ may be empty and renders with it empty', (id) => {
    const doc = JSON.parse(readFileSync(join(TPL, `${id}.json`), 'utf8'));
    expect(doc.mayBeEmpty, `${id}: __GATE_SCOPE__ is not declared mayBeEmpty`).toContain('__GATE_SCOPE__');
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body || Object.values(doc.bodies || {}).join('\n'))) values[p] = p === '__GATE_SCOPE__' ? '' : optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    // A seam-declared prompt renders from the project's copy, which the mint builds from the
    // template through the contract — so the copy declares exactly what the template declares.
    const { buildGeneratedDoc } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));
    const fs = require('node:fs'); const os = require('node:os');
    const projectDir = fs.mkdtempSync(join(os.tmpdir(), 'qa-gate-')); fs.mkdirSync(join(projectDir, 'prompts'));
    fs.writeFileSync(join(projectDir, `prompts/${id}.json`), JSON.stringify(buildGeneratedDoc(doc, doc.body)));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = projectDir;
    let out = '';
    try { expect(() => { out = renderEngineTemplate(id, values); }).not.toThrow(); }
    finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; fs.rmSync(projectDir, { recursive: true, force: true }); }
    expect(out.length).toBeGreaterThan(100);
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
  });
});
