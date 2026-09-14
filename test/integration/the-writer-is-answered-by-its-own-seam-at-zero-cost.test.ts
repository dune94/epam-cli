/**
 * THE WRITER IS ANSWERED BY ITS OWN SEAM AT £0.
 *
 * The registry names story-writer's template as `story-writer` — a multi-part document whose
 * sections (fix-plan, attempt-evidence) the writer CONSUMES — while the prompt every writer call
 * carries is story-writer-main. The mock fingerprinted the registry template, whose only
 * placeholder-free line is the fix-plan heading, so a greenfield writer call (no fix plan) matched
 * nothing and fell to the catch-all: the £0 run of 2026-09-13 reached the writer and the writer
 * was never invoked. Proven through the real registration, the real engine renderer and the edge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MiniMockServer } from './lib/mini-mockserver';

const ROOT = join(__dirname, '../../');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const { renderEngineTemplate, placeholdersIn, templatePath } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

let _prdPath = '';
function anyProjectPrd(): string { return _prdPath; }
function anyProject(): { dir: string; prd: string } {
  for (const d of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, d); const cfg = join(dir, 'config.env');
    const candidates = [join(dir, 'prd.authored.json')];
    if (existsSync(cfg)) { const m = readFileSync(cfg, 'utf8').match(/^PRD_CANONICAL=(.+)$/m); if (m) candidates.push(m[1].trim().startsWith('/') ? m[1].trim() : join(ROOT, m[1].trim())); }
    for (const prd of candidates) { try { if ((JSON.parse(readFileSync(prd, 'utf8')).stories || []).length) { _prdPath = prd; return { dir, prd }; } } catch { /* next */ } }
  }
  throw new Error('no project declares stories');
}

const mock = new MiniMockServer();
beforeAll(async () => {
  await mock.start();
  const p = anyProject();
  await new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', mock.url], {
      cwd: ROOT, env: { ...process.env, PRD_FILE: p.prd, EPAM_PROJECT_CONFIG_DIR: p.dir, LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
    c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
  });
}, 300_000);
afterAll(() => mock.stop());

function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }] });
    const req = httpRequest(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', () => resolve(String(res.headers['x-seam'] || '')));
    });
    req.on('error', reject); req.end(body);
  });
}

const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
const WRITER = Object.entries(reg).find(([, p]) => p && p.produces === 'implementation')![0];
const TPL = join(ROOT, 'orchestrations/prompts/templates');
/**
 * The prompts a writer call CARRIES WHOLE: single-body templates that declare the writer seam AND
 * that the writer's own runner script renders as a prompt (`render_engine_prompt <id>`) and that
 * name the story they are for. A note that only ever rides inside another prompt is not one of
 * them — read from the call sites and the template, not listed here.
 */
const rendered = new Set([...readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8').matchAll(/render_engine_prompt ([a-z0-9-]+)/g)].map((m) => m[1]));
const writerTemplates = readdirSync(TPL).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  .filter((id) => rendered.has(id))
  // A prompt FOR a story names the story; a note that rides inside another prompt does not.
  .filter((id) => { const t = JSON.parse(readFileSync(join(TPL, `${id}.json`), 'utf8')); return typeof t.body === 'string' && Array.isArray(t.seams) && t.seams.includes(WRITER) && placeholdersIn(t.body).includes('__STORY_ID__'); });

describe('the writer is answered by its own seam at £0', () => {
  it('there are templates the writer renders — otherwise nothing below is tested', () => {
    expect(writerTemplates.length).toBeGreaterThan(0);
  });
  it.each(writerTemplates)('%s rendered with NO optional section reaches the writer seam', async (id) => {
    const doc = JSON.parse(readFileSync(templatePath(id), 'utf8'));
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    const prompt = renderEngineTemplate(id, values);
    const seam = await ask(prompt);
    expect(seam, `${id}: the writer call matched no registered seam`).toMatch(new RegExp(`^${WRITER}(:|$)`));
  });
});

/**
 * THE WRITER'S ANSWER GOES TO THE WRITER ALONE. A roster review quotes every persona — the writer's
 * included — and lists the tickets in scope, so a writer matcher built from the seam's fingerprint
 * plus a story title matched the ROSTER REVIEW and handed it a turn of file-writing calls
 * (2026-09-14). The writer's per-story answer is keyed on the line the writer's own prompt names
 * its story with, which no other prompt carries.
 */
describe("the writer's answer goes to the writer alone", () => {
  it('a roster-review request quoting the writer persona and naming the stories is not answered as a writer', async () => {
    const { readFileSync: rf } = require('node:fs');
    const registry = JSON.parse(rf(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
    const reviewSeam = Object.entries(registry).find(([, p]) => p && p.produces === 'roster-verdict' && /project/.test(p.template || ''))?.[0];
    expect(reviewSeam, 'no project roster review seam').toBeTruthy();
    const reviewTpl = JSON.parse(rf(join(TPL, `${registry[reviewSeam!].template}.json`), 'utf8'));
    // What a roster review really quotes: every CANONICAL persona (agents/profiles.json), plus
    // the tickets in scope by id and title.
    const canonical = JSON.parse(rf(join(ROOT, 'orchestrations/agents/profiles.json'), 'utf8')) as Record<string, any>;
    const personas = Object.entries(canonical).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : (v && v.persona) || ''}`).join('\n');
    const stories = JSON.parse(rf(anyProjectPrd(), 'utf8')).stories || [];
    const values: Record<string, string> = {};
    for (const p of placeholdersIn(reviewTpl.body || Object.values(reviewTpl.bodies || {}).join('\n'))) values[p] = `${personas}\n${stories.map((s: any) => `${s.id}: ${s.title}`).join('\n')}`;
    const prompt = renderEngineTemplate(registry[reviewSeam!].template, values);
    const seam = await ask(prompt);
    expect(seam).not.toMatch(new RegExp(`^${WRITER}(:|$)`));
  });
});
