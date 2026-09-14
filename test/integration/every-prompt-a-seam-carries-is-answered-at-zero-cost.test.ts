/**
 * EVERY PROMPT A SEAM CARRIES IS ANSWERED AT £0, UNDER THE TAG THAT PROMPT DEMANDS.
 *
 * The registry names one template per seam, and the rehearsal answered that one. A seam carries
 * more: the specification coordinator also renders a review prompt (<SPEC_REVIEW>) and a model
 * review (<MODEL_REVIEW>), the change reviewer a spec-pass prompt, the failure analyst a
 * post-phase one, the phase assessment two. None was registered — 24 calls fell to the catch-all
 * in one £0 greenfield run (2026-09-14), each answered `{}` and read as a seam with nothing to say.
 *
 * Driven through the real registration against a real mock: every single-body template that
 * declares a seam is rendered and sent, and the answer must come from that seam, carrying the
 * tagged block the template's own body demands where it demands one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MiniMockServer } from './lib/mini-mockserver';

const ROOT = join(__dirname, '../../');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const TPL = join(ROOT, 'orchestrations/prompts/templates');
const { substituteOnce, placeholdersIn } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
const { TAG_TO_TOOL } = require(join(ROOT, 'orchestrations/scripts/lib/agent-output-schema.js'));

function greenfieldProject() {
  for (const d of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, d); const cfg = join(dir, 'config.env');
    if (!existsSync(cfg)) continue;
    const c = readFileSync(cfg, 'utf8');
    if (!/^EPAM_BROWNFIELD=0$/m.test(c)) continue;
    const prdM = c.match(/^PRD_CANONICAL=(.+)$/m); const outM = c.match(/^OUTPUT_DIR=(.+)$/m);
    if (!prdM || !outM) continue;
    const prd = prdM[1].trim().startsWith('/') ? prdM[1].trim() : join(ROOT, prdM[1].trim());
    try { if ((JSON.parse(readFileSync(prd, 'utf8')).stories || []).length) return { dir, prd, out: outM[1].trim() }; } catch { /* next */ }
  }
  throw new Error('no greenfield project with stories');
}

const mock = new MiniMockServer();
beforeAll(async () => {
  await mock.start();
  const p = greenfieldProject();
  await new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', mock.url], {
      cwd: ROOT, env: { ...process.env, PRD_FILE: p.prd, EPAM_PROJECT_CONFIG_DIR: p.dir, OUTPUT_DIR: p.out, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
    c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
  });
}, 300_000);
afterAll(() => mock.stop());

function ask(prompt: string): Promise<{ seam: string; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }] });
    const req = httpRequest(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || ''), body: b }));
    });
    req.on('error', reject); req.end(body);
  });
}

const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
// Every single-body template that declares a registry seam and is a whole prompt (it opens with
// its own text, not a fragment that rides inside another prompt).
const templates = readdirSync(TPL).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  .map((id) => ({ id, doc: JSON.parse(readFileSync(join(TPL, `${id}.json`), 'utf8')) }))
  // A template declared for more than one seam is a fragment those seams share; it is never sent alone.
  .filter(({ doc }) => typeof doc.body === 'string' && Array.isArray(doc.seams) && doc.seams.length === 1 && doc.seams.some((s: string) => reg[s]))
  .filter(({ doc }) => /^[A-Z]/.test(doc.body.trim()) && doc.body.trim().length > 400);

describe('every prompt a seam carries is answered at £0', () => {
  it('there are whole prompts to check', () => { expect(templates.length).toBeGreaterThan(5); });
  it.each(templates.map((t) => t.id))('%s: answered by its seam, under the tag its body demands', async (id) => {
    const { doc } = templates.find((t) => t.id === id)!;
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    // A seam-declared prompt renders from the project's copy, which at £0 is generated from the
    // template's own segments verbatim — so the template body, substituted once, is what is sent.
    const { seam, body } = await ask(substituteOnce(doc.body, values));
    const owners = doc.seams.filter((s: string) => reg[s]);
    expect(owners.some((s: string) => seam === s || seam.startsWith(`${s}:`)), `${id}: answered by "${seam}", declared for ${owners.join('/')}`).toBe(true);
    const demanded = [...doc.body.matchAll(/<([A-Z][A-Z0-9_]{3,})>/g)].map((m) => m[1]).find((tag) => TAG_TO_TOOL[tag]);
    if (demanded) {
      const text = [...body.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
      expect(text, `${id} demands <${demanded}> and the answer does not carry it`).toContain(`<${demanded}>`);
    }
  });
});
