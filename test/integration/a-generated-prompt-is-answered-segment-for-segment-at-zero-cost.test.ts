/**
 * A GENERATED PROMPT IS ANSWERED SEGMENT FOR SEGMENT AT £0.
 *
 * In `generate` provisioning mode the prompt builder shows the model a template's prose between
 * its placeholders — N `--- SEGMENT n ---` blocks — and requires exactly N back. N is a property
 * of the template being generated, different for each of the ~40, so no single recorded reply and
 * no contract stand-in can answer it: the £0 greenfield run was refused five times on the first
 * template ("no --- SEGMENT n --- blocks and no usable JSON in the reply") and the mint aborted.
 * Found 2026-09-13 by the greenfield integration test.
 *
 * The harness now registers one answer per template for the generator seam — matched on the
 * generator's own fingerprint AND the template's — returning that template's segments as they are.
 * Proven here through the REAL producer and the REAL parser: mock-expectations.js registers against
 * the in-process edge, renderGeneratorPrompt builds the request the builder would send, the edge
 * answers, and parseSegmentsReply must accept it with the template's own count. Every template
 * the generic zone holds is a case; a template added tomorrow is covered by existing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MiniMockServer } from './lib/mini-mockserver';

const ROOT = join(__dirname, '../../');
const TPL = join(ROOT, 'orchestrations/prompts/templates');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const builder = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));
const contract = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));

/** The first project that declares stories through its authored PRD — discovered, never named. */
function anyProject(): { dir: string; prd: string } {
  for (const d of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, d);
    const cfg = join(dir, 'config.env');
    const candidates = [join(dir, 'prd.authored.json')];
    if (existsSync(cfg)) {
      const m = readFileSync(cfg, 'utf8').match(/^PRD_CANONICAL=(.+)$/m);
      if (m) candidates.push(m[1].trim().startsWith('/') ? m[1].trim() : join(ROOT, m[1].trim()));
    }
    for (const prd of candidates) {
      try { if ((JSON.parse(readFileSync(prd, 'utf8')).stories || []).length) return { dir, prd }; } catch { /* next */ }
    }
  }
  throw new Error('no project declares stories');
}

const templateFiles = readdirSync(TPL).filter((f) => f.endsWith('.json'));
const readTemplate = (f: string) => { const t = JSON.parse(readFileSync(join(TPL, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...t }; };
const bodyOf = (t: any) => (typeof t.body === 'string' && t.body) ? t.body : Object.values(t.bodies || {}).filter((b) => typeof b === 'string').join('\n');
/** The generator: the one template whose body carries the slot the segments are embedded in. */
const generator = templateFiles.map(readTemplate).find((t) => bodyOf(t).includes('__GEN_TEMPLATE_BODY__'));

const mock = new MiniMockServer();
beforeAll(async () => {
  await mock.start();
  const p = anyProject();
  await new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', mock.url], {
      cwd: ROOT, env: { ...process.env, PRD_FILE: p.prd, EPAM_PROJECT_CONFIG_DIR: p.dir, LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
    c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
  });
}, 300_000);
afterAll(() => mock.stop());

/** POST the prompt the way the claude runner does: an Anthropic messages call carrying it. */
function ask(prompt: string): Promise<{ seam: string; text: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }] });
    const req = httpRequest(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let sse = ''; res.on('data', (d) => { sse += d; });
      res.on('end', () => {
        // The text the runner would assemble from the stream.
        const text = sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
          .filter((e) => e && e.type === 'content_block_delta' && e.delta && typeof e.delta.text === 'string').map((e) => e.delta.text).join('');
        resolve({ seam: String(res.headers['x-seam'] || ''), text });
      });
    });
    req.on('error', reject); req.end(body);
  });
}

describe('a generated prompt is answered segment for segment at £0', () => {
  it('the generic zone has a generator template — otherwise nothing below is tested', () => {
    expect(generator, 'no template carries __GEN_TEMPLATE_BODY__').toBeTruthy();
  });

  for (const f of templateFiles) {
    const t = readTemplate(f);
    if (generator && t.id === generator.id) continue;
    it(`${t.id}: the reply holds exactly its ${contract.splitByPlaceholders(bodyOf(t)).segments.length} segment(s)`, async () => {
      const expected = contract.splitByPlaceholders(bodyOf(t)).segments.length;
      const prompt = builder.renderGeneratorPrompt({ generatorBody: bodyOf(generator), template: t, projectContext: 'ctx', codelineContext: 'cl', mintedRoles: [], refusal: '' });
      const r = await ask(prompt);
      expect(r.seam, 'the request fell to the catch-all').not.toMatch(/CATCH-ALL/);
      const segs = contract.parseSegmentsReply(r.text, expected);
      expect(segs).toHaveLength(expected);
    });
  }
});
