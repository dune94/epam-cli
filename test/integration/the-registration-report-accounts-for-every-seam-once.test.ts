/**
 * THE REGISTRATION REPORT ACCOUNTS FOR EVERY DECLARED SEAM EXACTLY ONCE.
 *
 * The report's total is the proof that no seam was decided somewhere nobody prints. Annotations —
 * "first attempt answers hollow", "first verdict rejects", the writer's per-story answers — were
 * pushed into the stand-in bucket beside the seam's terminal outcome, so the total ran OVER the
 * declared count ("118 of 114 … WARNING: -4 seam(s) reached no printed bucket", £0 brownfield
 * launcher, 2026-09-14) and the launcher test that reads the proof failed. An annotation is
 * printed under its own heading and never counted; a seam reaches one terminal bucket.
 *
 * Driven through the real registration against a mock of this test's own, for the brownfield
 * shape (a tracker story over an estate) — the shape that carries every annotation at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MiniMockServer } from './lib/mini-mockserver';

const ROOT = join(__dirname, '../../');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the registration report accounts for every declared seam exactly once', () => {
  const own = new MiniMockServer();
  let report = '';
  beforeAll(async () => {
    await own.start();
    const { loadProviders } = require(join(ROOT, 'orchestrations/scripts/lib/ecosystem-registry.js'));
    const eco = loadProviders().find((e: any) => e.standIn && e.codelineManifests && e.codelineManifests.contractGeneration);
    const ws = mkdtempSync(join(tmpdir(), 'bf-report-')); dirs.push(ws);
    const estate = join(ws, 'codelines'); const codeline = join(estate, 'codeline'); mkdirSync(join(codeline, 'src'), { recursive: true });
    spawnSync('git', ['-C', codeline, 'init', '-q']);
    writeFileSync(join(codeline, eco.file), typeof eco.standIn.manifest === 'function' ? eco.standIn.manifest(eco.file) : eco.standIn.manifest);
    const src = `src/module${eco.codelineManifests.contractGeneration.sourceExtensions[0]}`;
    writeFileSync(join(codeline, src), typeof eco.standIn.source === 'function' ? eco.standIn.source(src) : eco.standIn.source);
    const prd = join(ws, 'synthesized-prd.json');
    writeFileSync(prd, JSON.stringify({ project: { name: 'bf' }, stories: [{ id: 'TRK-1-codeline', codeline: 'codeline', title: 'a defect in the module', technicalNotes: { files: [src] } }] }));
    const project = readdirSync(PROJECTS).map((d) => join(PROJECTS, d)).find((d) => existsSync(join(d, 'config.env')) && existsSync(join(d, 'seed')))!;
    expect(project, 'no brownfield rehearsal project (config.env + seed/)').toBeTruthy();
    report = await new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', own.url], {
        cwd: ROOT, env: { ...process.env, PRD_FILE: prd, EPAM_PROJECT_CONFIG_DIR: project, OUTPUT_DIR: '', PROJECT_ROOT: '', JIRA_CODELINE_ROOT: estate, EPAM_BROWNFIELD: '1', EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('close', (s) => (s === 0 ? resolve(out) : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
    });
  }, 300_000);
  afterAll(() => own.stop());
  it('the report carries every annotation this shape produces — otherwise the count below is not tested', () => {
    expect(report).toMatch(/first attempt answers hollow/);
    expect(report).toMatch(/first verdict rejects/);
    expect(report).toMatch(/writer: declared deliverables written/);
  });
  it('the total equals the declared count and the proof line prints', () => {
    const m = report.match(/^(\d+) of (\d+) declared seam\(s\) accounted for/m);
    expect(m, `no accounting line in:\n${report.slice(-2000)}`).toBeTruthy();
    expect(Number(m![1]), `accounted ${m![1]} of ${m![2]}`).toBe(Number(m![2]));
    expect(report).toMatch(/every declared seam reached a printed bucket/);
    expect(report).not.toMatch(/reached no printed bucket/);
  });
});
