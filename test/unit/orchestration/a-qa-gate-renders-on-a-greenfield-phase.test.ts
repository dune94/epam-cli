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
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const TPL = join(ROOT, 'orchestrations/prompts/templates');
const { renderEngineTemplate, placeholdersIn } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
const SRC = engineSource(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'));

const gates = readdirSync(TPL).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  .filter((id) => (JSON.parse(engineSource(join(TPL, `${id}.json`))).placeholders || []).includes('__GATE_SCOPE__'));

/**
 * THE UNIVERSE IS THE CALL SITES, NOT A PLACEHOLDER NAME. The runtime-boundary gate handed the
 * scope to __STORY_TITLE__, not __GATE_SCOPE__, so the universe above never held it: on a greenfield
 * phase it refused to render — "cannot render its prompt — refusing to gate with no instructions"
 * — and reported "no structured output, non-blocking warn" (£0 harness run 23, 2026-09-14). Every
 * (template, placeholder) that RECEIVES the scope is read from run-agent-orchestration.sh: the
 * jq variable assigned from _brownfield_gate_scope, the placeholder that variable fills, and the
 * template the next render_engine_prompt names.
 */
function scopeReceivers(): { id: string; placeholder: string }[] {
  const out: { id: string; placeholder: string }[] = [];
  const re = /--arg\s+(\w+)\s+"\$\(_brownfield_gate_scope\s+[\w-]+\)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) {
    const after = SRC.slice(m.index);
    const ph = after.match(new RegExp(`"(__[A-Z0-9_]+__)":\\$${m[1]}\\b`));
    const tpl = after.match(/render_engine_prompt\s+([a-z0-9-]+)/);
    if (ph && tpl) out.push({ id: tpl[1], placeholder: ph[1] });
  }
  return out;
}

describe('a QA gate renders on a greenfield phase', () => {
  it('the orchestrator produces an EMPTY gate scope on greenfield — the premise', () => {
    const fn = SRC.slice(SRC.indexOf('_brownfield_gate_scope() {'));
    expect(fn.slice(0, 200)).toMatch(/\[ "\$\{EPAM_BROWNFIELD:-0\}" = "1" \] \|\| return 0/);
    expect(gates.length, 'no template carries __GATE_SCOPE__').toBeGreaterThan(0);
  });
  it.each(gates)('%s declares __GATE_SCOPE__ may be empty and renders with it empty', (id) => {
    const doc = JSON.parse(engineSource(join(TPL, `${id}.json`)));
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

describe('every placeholder that receives the gate scope may be empty', () => {
  const receivers = scopeReceivers();
  it('the orchestrator hands the scope to gates', () => { expect(receivers.length).toBeGreaterThan(3); });
  it.each(receivers.map((r) => [r.id, r.placeholder]))('%s: %s is declared mayBeEmpty', (id, placeholder) => {
    const doc = JSON.parse(engineSource(join(TPL, `${id}.json`)));
    expect(doc.mayBeEmpty || [], `${id} receives the brownfield scope in ${placeholder}`).toContain(placeholder);
  });
});
