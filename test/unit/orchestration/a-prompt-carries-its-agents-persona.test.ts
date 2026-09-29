/**
 * A RENDERED PROMPT CARRIES ITS AGENT'S PERSONA — ON EVERY STACK, NOT ONLY CODEMIE WEB.
 *
 * Each seam declares whose persona it speaks as (agents/invocation-profiles.json `persona`). On the
 * codemie-web stack the persona is the stored assistant's system instructions; every other stack
 * sees only the prompt. A template now carries the persona in one slot, `__PERSONA__`, and the
 * renderer fills it from the seam's declaration when the caller does not — so the identity is written
 * once (the profiles), not once there and again as an inline sentence in the template.
 *
 * Executed: the real renderer (lib/engine-prompt.js renderEngineTemplate) on every seam whose template
 * has the slot — through the project copy for a project-layer seam, as a run renders it, and from the
 * template for a bootstrap one — with every other placeholder supplied and the persona NOT supplied.
 * Seams whose persona reaches the prompt through a caller-filled slot of their own are proven where
 * the caller runs: the rehearsal drivers assert every call a run makes carried its persona.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, { template?: string; persona?: string; layer?: string }>;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const templateOf = (id: string) => JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8'));
const bodiesOf = (t: any): Record<string, string> => (t.bodies && typeof t.bodies === 'object' ? t.bodies : { '': t.body });
const SLOT = '__PERSONA__';
/** Seams whose template has the persona slot — enumerated from the registry, not named here. */
const SLOTTED = Object.keys(reg).filter((s) => reg[s].template && Object.values(bodiesOf(templateOf(reg[s].template!))).some((b) => String(b).includes(SLOT)));

/** Render as the engine does, in a child (the renderer reads the environment at call time). */
function render(seam: string, supplyPersona?: string) {
  const id = reg[seam].template!; const t = templateOf(id);
  const project = mkdtempSync(join(tmpdir(), 'persona-render-')); dirs.push(project);
  mkdirSync(join(project, 'prompts'));
  // The project copy, as provisioning writes it: the template's own text under project authority.
  writeFileSync(join(project, 'prompts', `${id}.json`), JSON.stringify({ ...t, id, authority: 'project' }));
  const out: Record<string, string> = {};
  for (const [part, body] of Object.entries(bodiesOf(t)).filter(([, b]) => String(b).includes(SLOT))) {
    // Every other placeholder, named by the pipeline's own parser (placeholdersIn), is supplied.
    const r = spawnSync(process.execPath, ['-e', `
      const { renderEngineTemplate, placeholdersIn } = require(${JSON.stringify(join(LIB, 'engine-prompt.js'))});
      const [id, body, part, supplied] = process.argv.slice(1);
      const values = Object.fromEntries(placeholdersIn(body).filter((p) => p !== '${SLOT}').map((p) => [p, '«' + p + '»']));
      if (supplied) values['${SLOT}'] = supplied;
      process.stdout.write(renderEngineTemplate(id, values, part || undefined));
    `, id, String(body), part, supplyPersona ?? ''], { encoding: 'utf8', env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: project, EPAM_AGENTS_DIR: join(ROOT, 'orchestrations/agents') } });
    out[part] = r.status === 0 ? r.stdout : `RENDER FAILED: ${r.stderr.slice(-400)}`;
  }
  return out;
}

const persona = (seam: string) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { agentPersona } = require(join(LIB, 'agent-roster.js'));
  return String(agentPersona(reg[seam].persona || '', join(ROOT, 'orchestrations/agents'), '') || '').trim();
};

describe('a rendered prompt carries its agent\'s persona', () => {
  it('there are slotted templates to prove this on', () => {
    expect(SLOTTED.length).toBeGreaterThan(0);
  });

  it.each(SLOTTED)('%s: with no persona from the caller, the renderer fills it from the seam\'s declaration', (seam) => {
    const want = persona(seam);
    expect(want, `${seam} declares no persona the profiles carry`).not.toBe('');
    for (const [part, text] of Object.entries(render(seam))) {
      expect(text, `${seam}${part ? ` (${part})` : ''}`).toContain(want);
    }
  });

  it.each(SLOTTED)('%s: a persona the caller supplies wins', (seam) => {
    for (const text of Object.values(render(seam, 'CALLER-SUPPLIED-PERSONA'))) {
      expect(text).toContain('CALLER-SUPPLIED-PERSONA');
      expect(text).not.toContain(persona(seam));
    }
  });
});
