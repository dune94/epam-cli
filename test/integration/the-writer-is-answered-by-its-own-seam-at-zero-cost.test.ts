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
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
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

/**
 * THE WRITER'S CALL FOR A REAL STORY IS ANSWERED WITH THAT STORY'S WRITES. The tests above render
 * the story id as a placeholder value, so they are satisfied by the seam's generic answer — which
 * writes nothing. The per-story answer is keyed on the line the writer's template names the story
 * with; the frame was read from the FIRST writer template in directory order (file generation),
 * the implementation prompt uses a different line, and every attempt fell to the generic answer:
 * "missing 4 declared deliverables", eight attempts, HealingBroken (£0 greenfield harness run 20,
 * 2026-09-14). Every greenfield project that declares stories and an OUTPUT_DIR is driven here.
 */
describe("the writer's call for a real story is answered with that story's writes", () => {
  const greenfield = readdirSync(PROJECTS).map((d) => {
    const dir = join(PROJECTS, d); const cfg = join(dir, 'config.env');
    if (!existsSync(cfg)) return null;
    const c = readFileSync(cfg, 'utf8');
    if (!/^EPAM_BROWNFIELD=0$/m.test(c)) return null;
    const prdM = c.match(/^PRD_CANONICAL=(.+)$/m); const outM = c.match(/^OUTPUT_DIR=(.+)$/m);
    if (!prdM || !outM) return null;
    const prd = prdM[1].trim().startsWith('/') ? prdM[1].trim() : join(ROOT, prdM[1].trim());
    let stories: any[] = []; try { stories = JSON.parse(readFileSync(prd, 'utf8')).stories || []; } catch { return null; }
    return stories.length ? { name: d, dir, prd, out: outM[1].trim(), stories } : null;
  }).filter(Boolean) as { name: string; dir: string; prd: string; out: string; stories: any[] }[];
  it('there is a greenfield project with stories and an OUTPUT_DIR', () => { expect(greenfield.length).toBeGreaterThan(0); });

  for (const p of greenfield) {
    const own = new MiniMockServer();
    beforeAll(async () => {
      await own.start();
      await new Promise<void>((resolve, reject) => {
        const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', own.url], {
          cwd: ROOT, env: { ...process.env, PRD_FILE: p.prd, EPAM_PROJECT_CONFIG_DIR: p.dir, OUTPUT_DIR: p.out, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
        c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
      });
    }, 300_000);
    afterAll(() => own.stop());
    const askOwn = (prompt: string) => new Promise<{ seam: string; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }] });
      const req = httpRequest(`${own.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || ''), body: b }));
      });
      req.on('error', reject); req.end(body);
    });
    // The per-story answer is a SEQUENCE (write turn, answer, …) shared by every prompt the writer
    // carries; only the first request to this fresh mock is asserted to be a write turn.
    let first = true;
    for (const id of writerTemplates) {
      it(`${p.name}: ${id} rendered for a real story is answered as that story's writer, with write calls`, async () => {
        const doc = JSON.parse(readFileSync(templatePath(id), 'utf8'));
        const story = p.stories[0];
        const values: Record<string, string> = {};
        const optional = new Set(doc.mayBeEmpty || []);
        for (const ph of placeholdersIn(doc.body)) values[ph] = optional.has(ph) ? '' : `value of ${ph.replace(/_/g, ' ').trim()}`;
        values.__STORY_ID__ = story.id;
        if ('__TITLE__' in values) values.__TITLE__ = story.title || 'title';
        const { seam, body } = await askOwn(renderEngineTemplate(id, values));
        expect(seam, `${id} for ${story.id} was not answered by the per-story writer stand-in`).toBe(`${WRITER}:${story.id}`);
        if (first) { first = false; expect(body, 'the first answer is a turn of write calls').toMatch(/"type":"tool_use"/); }
      });
    }
  }
});

/**
 * THE WRITER'S PER-STORY ANSWERS DO NOT DEPEND ON THE SEAM'S GENERIC KEY. The writer's registry
 * template is multi-part and its joined fingerprint can equal an earlier entry's; the generic-key
 * dedup then skipped the whole seam and the brownfield rehearsal's writer was answered eight
 * times with the generic text and wrote nothing (£0 brownfield harness run 8, 2026-09-14).
 * Driven with a tracker-shaped story (id suffixed by its codeline, files declared) over a codeline
 * whose ecosystem the providers recognise — the brownfield shape, not the greenfield fixture's.
 */
describe("the writer's per-story answers are registered whatever the generic key collides with", () => {
  const own = new MiniMockServer();
  let codeline = ''; let storyId = '';
  beforeAll(async () => {
    await own.start();
    const { loadProviders } = require(join(ROOT, 'orchestrations/scripts/lib/ecosystem-registry.js'));
    const eco = loadProviders().find((e: any) => e.standIn && e.codelineManifests && e.codelineManifests.contractGeneration);
    const ws = mkdtempSync(join(tmpdir(), 'bf-writer-')); dirs.push(ws);
    // The estate: one repository under the codeline root, named for the story's codeline — as the
    // brownfield launcher lays it out. No OUTPUT_DIR: the story's codeline is what the writer has.
    const estate = join(ws, 'codelines'); codeline = join(estate, 'codeline'); require('node:fs').mkdirSync(join(codeline, 'src'), { recursive: true });
    spawnSync('git', ['-C', codeline, 'init', '-q']);
    const { writeFileSync: wf } = require('node:fs');
    wf(join(codeline, eco.file), typeof eco.standIn.manifest === 'function' ? eco.standIn.manifest(eco.file) : eco.standIn.manifest);
    const src = `src/module${eco.codelineManifests.contractGeneration.sourceExtensions[0]}`;
    wf(join(codeline, src), typeof eco.standIn.source === 'function' ? eco.standIn.source(src) : eco.standIn.source);
    storyId = 'TRK-1-codeline';
    const prd = join(ws, 'synthesized-prd.json');
    wf(prd, JSON.stringify({ project: { name: 'bf' }, stories: [{ id: storyId, codeline: 'codeline', title: 'a defect in the module', technicalNotes: { files: [src] } }] }));
    const p = anyProject();
    await new Promise<void>((resolve, reject) => {
      const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', own.url], {
        cwd: ROOT, env: { ...process.env, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: p.dir, OUTPUT_DIR: '', PROJECT_ROOT: '', JIRA_CODELINE_ROOT: estate, EPAM_BROWNFIELD: '1', EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
      c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
    });
  }, 300_000);
  afterAll(() => own.stop());
  /**
   * A DELIVERABLE THAT ALREADY EXISTS IS READ BEFORE IT IS WRITTEN. Claude Code's Write tool refuses
   * to overwrite a file the session has not read ("File has not been read yet. Read it first before
   * writing to it."): the brownfield rehearsal's per-story write turn was served and rejected eight
   * times running, and the deliverable stayed unchanged (£0 brownfield harness run 10, 2026-09-14).
   * A brownfield story's files exist by definition. The stand-in answers as a model would: a turn
   * of read calls for the files that exist, then the write turn, then the text.
   */
  // FIRST: the per-story answer is a sequence, and only a fresh mock's first request is its first turn.
  it('a story whose deliverable already exists is answered read turn → write turn → text', async () => {
    const id = writerTemplates[0];
    const doc = JSON.parse(readFileSync(templatePath(id), 'utf8'));
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const ph of placeholdersIn(doc.body)) values[ph] = optional.has(ph) ? '' : `value of ${ph.replace(/_/g, ' ').trim()}`;
    values.__STORY_ID__ = storyId; if ('__TITLE__' in values) values.__TITLE__ = 'a defect in the module';
    const prompt = renderEngineTemplate(id, values);
    const askBody = () => new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }] });
      const req = httpRequest(`${own.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); });
      req.on('error', reject); req.end(body);
    });
    const events = (sse: string) => sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const calls = (sse: string) => events(sse).filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use').map((e) => e.content_block.name as string);
    const inputs = (sse: string) => events(sse).filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta').map((e) => JSON.parse(e.delta.partial_json));
    const { resolveRunner, declaredRunners } = require(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'));
    const p = anyProject();
    // Resolved under the set the mock was registered with — the rehearsal set.
    const prior = process.env.EPAM_PROVIDER_SET; process.env.EPAM_PROVIDER_SET = 'mockserver';
    let decl: any;
    try { decl = declaredRunners({ projectConfigDir: p.dir }).map((n: string) => resolveRunner(n, { projectConfigDir: p.dir })).find((d: any) => d && d.writeTool); }
    finally { if (prior === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = prior; }
    expect(decl, 'no runner of the rehearsal set declares a write tool').toBeTruthy();
    expect(decl.readTool, 'the set declares no read tool beside its write tool').toBeTruthy();
    const first = await askBody();
    expect(calls(first), 'the first turn is not a turn of read calls').toEqual([decl.readTool.name]);
    const target = join(codeline, 'src');
    expect(inputs(first)[0][decl.readTool.path], 'the read is not of the existing deliverable').toContain(target);
    const second = await askBody();
    expect(calls(second), 'the second turn is not the write turn').toEqual([decl.writeTool.name]);
    expect(inputs(second)[0][decl.writeTool.path]).toBe(inputs(first)[0][decl.readTool.path]);
    const third = await askBody();
    expect(calls(third), 'the third answer is not text').toEqual([]);
    expect(third).toMatch(/"type":"text_delta"/);
  });
  it.each(writerTemplates)('%s rendered for the tracker story is answered with that story\'s write turn', async (id) => {
    const doc = JSON.parse(readFileSync(templatePath(id), 'utf8'));
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const ph of placeholdersIn(doc.body)) values[ph] = optional.has(ph) ? '' : `value of ${ph.replace(/_/g, ' ').trim()}`;
    values.__STORY_ID__ = storyId; if ('__TITLE__' in values) values.__TITLE__ = 'a defect in the module';
    const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: renderEngineTemplate(id, values) }] });
    const r = await new Promise<{ seam: string }>((resolve, reject) => {
      const req = httpRequest(`${own.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || '') })); });
      req.on('error', reject); req.end(body);
    });
    expect(r.seam).toBe(`${WRITER}:${storyId}`);
  });
});
