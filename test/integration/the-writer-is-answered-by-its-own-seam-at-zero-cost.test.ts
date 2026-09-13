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

function anyProject(): { dir: string; prd: string } {
  for (const d of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, d); const cfg = join(dir, 'config.env');
    const candidates = [join(dir, 'prd.authored.json')];
    if (existsSync(cfg)) { const m = readFileSync(cfg, 'utf8').match(/^PRD_CANONICAL=(.+)$/m); if (m) candidates.push(m[1].trim().startsWith('/') ? m[1].trim() : join(ROOT, m[1].trim())); }
    for (const prd of candidates) { try { if ((JSON.parse(readFileSync(prd, 'utf8')).stories || []).length) return { dir, prd }; } catch { /* next */ } }
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

describe('the writer is answered by its own seam at £0', () => {
  it('a writer prompt with NO fix plan and no other optional section reaches the story-writer seam', async () => {
    const doc = JSON.parse(readFileSync(templatePath('story-writer-main'), 'utf8'));
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    values.__STORY_ID__ = 'GF-1'; values.__TITLE__ = 'a greenfield story'; values.__DESCRIPTION__ = 'build it';
    const prompt = renderEngineTemplate('story-writer-main', values);
    const seam = await ask(prompt);
    expect(seam, 'the writer call matched no registered seam').toMatch(/^story-writer/);
  });
});
