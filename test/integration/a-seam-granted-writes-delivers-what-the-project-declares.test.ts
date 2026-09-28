/**
 * A SEAM THE REGISTRY GRANTS WRITES DELIVERS THE FILES THE PROJECT DECLARES FOR IT.
 *
 * The repro-test writer's stand-in was a note in prose, so no reproducing test was ever written
 * and the seam — with the attempt analyst its failed attempt should reach — never executed at £0
 * (brownfield harness run 14, 2026-09-14). A seam with `toolGrant: write` whose project declares a
 * `stand-in/<seam>/` tree answers as a model does: its declared first failure, then a read of each
 * file that exists, then the write turn carrying the declared content, then the text.
 * Driven through the real registration against a mock of this test's own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MiniMockServer } from './lib/mini-mockserver';

const ROOT = join(__dirname, '../../');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const { substituteOnce: _substituteOnce, placeholdersIn, templatePath } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
// A seam-declared prompt renders from a project's copy; the mock's fingerprint is taken from the template, substituted once.
const substituteOnce = (body: string, values: Record<string, string>) => _substituteOnce(body, placeholdersIn(body), values);
const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, any>;
// A seam granted writes whose registry template is a whole prompt and is not the story writer.
const SEAM = Object.entries(reg).find(([k, p]) => p && p.toolGrant === 'write' && p.produces !== 'implementation' && typeof p.template === 'string' && existsSync(templatePath(p.template)) && JSON.parse(readFileSync(templatePath(p.template), 'utf8')).body)![0];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('a seam granted writes delivers what the project declares for it', () => {
  const own = new MiniMockServer();
  let codeline = ''; let content = ''; let rel = '';
  beforeAll(async () => {
    await own.start();
    const { loadProviders } = require(join(ROOT, 'orchestrations/scripts/lib/ecosystem-registry.js'));
    const eco = loadProviders().find((e: any) => e.standIn && e.codelineManifests && e.codelineManifests.contractGeneration);
    const ws = mkdtempSync(join(tmpdir(), 'bf-deliver-')); dirs.push(ws);
    const estate = join(ws, 'codelines'); codeline = join(estate, 'codeline'); mkdirSync(join(codeline, 'src'), { recursive: true });
    spawnSync('git', ['-C', codeline, 'init', '-q']);
    writeFileSync(join(codeline, eco.file), typeof eco.standIn.manifest === 'function' ? eco.standIn.manifest(eco.file) : eco.standIn.manifest);
    const ext = eco.codelineManifests.contractGeneration.sourceExtensions[0];
    rel = `src/module.test${ext}`; writeFileSync(join(codeline, rel), 'the test before\n');   // exists: must be read first
    const base = readdirSync(PROJECTS).map((d) => join(PROJECTS, d)).find((d) => existsSync(join(d, 'config.env')) && existsSync(join(d, 'seed')))!;
    const project = join(ws, 'project'); cpSync(base, project, { recursive: true, filter: (p: string) => !/\/(runs|stand-in)(\/|$)/.test(p) });
    content = `the reproducing test the project declares ${Date.now()}\n`;
    mkdirSync(join(project, 'stand-in', SEAM, 'src'), { recursive: true }); writeFileSync(join(project, 'stand-in', SEAM, rel), content);
    const prd = join(ws, 'synthesized-prd.json');
    writeFileSync(prd, JSON.stringify({ project: { name: 'bf' }, stories: [{ id: 'TRK-1-codeline', codeline: 'codeline', title: 'a defect', technicalNotes: { files: [`src/module${ext}`] } }] }));
    await new Promise<void>((resolve, reject) => {
      const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', own.url], {
        cwd: ROOT, env: { ...process.env, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: project, OUTPUT_DIR: '', PROJECT_ROOT: '', JIRA_CODELINE_ROOT: estate, EPAM_BROWNFIELD: '1', EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
      c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
    });
  }, 300_000);
  afterAll(() => own.stop());
  it(`${SEAM}: the declared first failure, then read → write with the declared content → text`, async () => {
    const doc = JSON.parse(readFileSync(templatePath(reg[SEAM].template), 'utf8'));
    const values: Record<string, string> = {}; const optional = new Set(doc.mayBeEmpty || []);
    for (const ph of placeholdersIn(doc.body)) values[ph] = optional.has(ph) ? '' : `value of ${ph.replace(/_/g, ' ').trim()}`;
    const prompt = substituteOnce(doc.body, values);
    // A WRITER'S REQUEST OFFERS ITS TOOLS — the runner's declared ones, by their declared names. The
    // self-heal analyst's request quotes the same prompt and offers none; it consumed the delivery
    // until 2026-09-28 (the £0 brownfield halt), so a request without the write tool is asked below too.
    const runner = Object.values<any>(JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.mockserver.json'), 'utf8')).runners)
      .find((r) => r && r.writeTool && r.writeTool.name);
    const tools = [runner.readTool, runner.writeTool].filter(Boolean).map((t: any) => ({ name: t.name, description: t.name, input_schema: { type: 'object' } }));
    const ask = (withTools = true) => new Promise<{ seam: string; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }], ...(withTools ? { tools } : {}) });
      const req = httpRequest(`${own.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || ''), body: b })); });
      req.on('error', reject); req.end(body);
    });
    const events = (sse: string) => sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const calls = (sse: string) => events(sse).filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use').map((e) => e.content_block.name as string);
    // A tool input streams as partial JSON over several deltas: assembled per content block, then parsed.
    const inputs = (sse: string) => {
      const parts = new Map<number, string>();
      for (const e of events(sse)) if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') parts.set(e.index, (parts.get(e.index) || '') + e.delta.partial_json);
      return [...parts.values()].map((j) => JSON.parse(j));
    };
    const turns: { seam: string; calls: string[]; inputs: any[] }[] = [];
    const take = async (withTools = true) => { const r = await ask(withTools); const t = { seam: r.seam, calls: calls(r.body), inputs: inputs(r.body) }; turns.push(t); return t; };
    const diagnosed = Array.isArray(reg['agent-failure-analyst'] && reg['agent-failure-analyst'].diagnosesAttemptsOf) && reg['agent-failure-analyst'].diagnosesAttemptsOf.includes(SEAM);
    if (diagnosed) {
      const first = await take();
      expect(first.seam, 'the first attempt did not fail on purpose').toMatch(/first-attempt-fails/);
      expect(first.calls).toEqual([]);
      turns.length = 0;
    }
    // The analyst's shape: the same prompt quoted, no write tool offered. It must not be handed the
    // delivery — it cannot execute it, and the writer would never see it again.
    const quoting = await take(false);
    expect(quoting.seam, 'a request that cannot write was served the delivery').not.toBe(`${SEAM}:delivers`);
    expect(quoting.calls, 'a request that cannot write was handed tool calls').toEqual([]);
    turns.length = 0;
    for (let n = 0; n < 5; n += 1) await take();
    const i = 0;
    expect(turns[i].seam, 'no delivery turn').toBe(`${SEAM}:delivers`);
    expect(turns[i].calls, 'the existing file was not read first').toEqual(['Read']);
    expect(turns[i].inputs[0].file_path).toBe(join(codeline, rel));
    expect(turns[i + 1].calls, 'no write turn').toEqual(['Write']);
    expect(turns[i + 1].inputs[0].file_path).toBe(join(codeline, rel));
    expect(turns[i + 1].inputs[0].content, 'the content is not what the project declares').toBe(content);
    expect(turns[i + 2].calls, 'the answer after the delivery is not text').toEqual([]);
    expect(turns[i + 2].seam).toBe(SEAM);
  });
});
