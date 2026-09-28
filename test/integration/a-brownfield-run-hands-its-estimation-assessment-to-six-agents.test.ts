/**
 * A BROWNFIELD RUN HANDS ITS ESTIMATION ASSESSMENT TO THE AGENTS THAT DECLARE IT — AND TO NO OTHER.
 *
 * Operator, 2026-09-28: "ingest jira - then inform the pipeline of this artefact to augment the
 * downstream agents. do not break the pipeline by doing so!!" EPAM_ESTIMATION_MANIFEST names the
 * estimation application's output; after ingest each ticket's assessment is persisted, and every
 * consumer the engine template `estimation-assessment` frames receives it in its own prompt.
 *
 * Executed: the real paused brownfield launcher on its seeded project, pause then resume, the model
 * answered by stand-ins (£0), with the variable set to a fixture shaped like the application's
 * page. Asserted on what each model call RECEIVED — the request bodies the mock recorded — and on
 * the record the run persisted:
 *   - every framed consumer that was called received the assessment (its marker and its frame);
 *   - no other agent received it, except those the registry says are handed another agent's attempt
 *     (attempt/failure evidence quotes a consumer's prompt by design);
 *   - the run still reaches the end: writer, reproducing test, review, phase gate.
 * The same launcher without the variable is a-brownfield-project-runs-to-the-writer-at-zero-cost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MiniMockServer, type Hit } from './lib/mini-mockserver';
import { ROOT, fixtureInstall, edgeFor, zeroCostEnv, run } from './lib/fixture-install';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const mock = new MiniMockServer();
let install = '';
let bin = '';
let workspaceRoot = '';
beforeAll(async () => {
  await mock.start();
  install = fixtureInstall(dirs);
  bin = edgeFor(install, mock.url, children).bin;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mock1-est-ws-')); dirs.push(workspaceRoot);
}, 120_000);
afterAll(() => mock.stop());

const LAUNCHER = 'orchestrations/scripts/mock1-paused-run.sh';
const MANIFEST = join(ROOT, 'test/fixtures/estimation/hello-dolly');
/** A finding only the fixture's code assessment carries. */
const MARKER = 'EST-FINDING-HW-7Q';

/** The consumers are the template's declaration, never a list here. */
const CONSUMERS = Object.keys(JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/estimation-assessment.json'), 'utf8')).bodies);
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles as Record<string, { consumes?: { kind: string }[] }>;
/** Agents handed another agent's attempt — they quote a consumer's prompt as evidence, by design. */
const QUOTES_ATTEMPTS = Object.entries(REGISTRY)
  .filter(([, p]) => (p.consumes || []).some((c) => /attempt-evidence|failure-evidence/.test(c.kind)))
  .map(([s]) => s);
const seamOf = (h: Hit) => h.seam.split(':')[0];
const isConsumer = (h: Hit) => CONSUMERS.includes(seamOf(h));

const env = () => zeroCostEnv(bin, mock.url, { MOCK1_WORKSPACE_ROOT: workspaceRoot, EPAM_ESTIMATION_MANIFEST: MANIFEST });

describe('a brownfield run with an estimation manifest', () => {
  it('hands the assessment to every consumer it calls, to no other agent, and still runs to the end', async () => {
    expect(existsSync(MANIFEST)).toBe(true);
    const r1 = await run('bash', [join(install, LAUNCHER)], { cwd: install, env: env(), timeout: 40 * 60_000 });
    const text1 = r1.stdout + r1.stderr;
    const pauseHits = [...mock.hits];
    const runId = (text1.match(/RUN NUMBER:\s+(\S+)/) || [])[1];
    expect(runId, `no run number — log tail:\n${text1.split('\n').slice(-40).join('\n')}`).toBeTruthy();
    expect(text1, 'the manifest was never read after ingest').toMatch(/\[estimation\] 1 ticket\(s\) assessed/);

    const r2 = await run('bash', [join(install, LAUNCHER), '--resume', runId], { cwd: install, env: env(), timeout: 40 * 60_000 });
    const text2 = r2.stdout + r2.stderr;
    const hits = [...pauseHits, ...mock.hits];
    const tail = `${text2.split('\n').slice(-50).join('\n')}\n--- calls ---\n${hits.map((h, i) => `${i + 1}. ${h.seam}`).join('\n')}`;
    expect(r2.status, `resume exited ${r2.status} — log tail:\n${tail}`).toBe(0);

    // The record the run persisted, where every later stage reads it.
    const recFile = join(install, 'orchestrations/logs/estimation/MOCK-HW-1.json');
    expect(existsSync(recFile), 'no record persisted for the ticket').toBe(true);
    expect(readFileSync(recFile, 'utf8')).toContain(MARKER);

    // Not vacuous: the consumers were actually called in this run, and more than one of them.
    const called = [...new Set(hits.filter(isConsumer).map(seamOf))];
    expect(called.length, `too few consumers were called to prove anything: ${called}\n${tail}`).toBeGreaterThanOrEqual(4);
    for (const seam of called) {
      const got = hits.filter((h) => seamOf(h) === seam);
      expect(got.some((h) => h.body.includes(MARKER) && h.body.includes('Estimation assessment for MOCK-HW-1')),
        `${seam} was called ${got.length} time(s) and never received the assessment`).toBe(true);
    }
    // The negative: nothing else was handed it.
    const leaked = hits.filter((h) => h.body.includes(MARKER) && !isConsumer(h) && !QUOTES_ATTEMPTS.includes(seamOf(h)))
      .map((h) => h.seam);
    expect([...new Set(leaked)], 'agents outside the declared consumers received the assessment').toEqual([]);

    // And the run still does its job: the fix, a reproducing test, a GO.
    const gates = readFileSync(join(install, 'orchestrations/logs/phase-gates.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(gates.some((g: { decision?: string }) => String(g.decision).toLowerCase() === 'go'), `no phase gate decided GO — ${tail}`).toBe(true);
    const clone = readdirSync(join(workspaceRoot, runId, 'workspace', 'codelines')).map((d) => join(workspaceRoot, runId, 'workspace', 'codelines', d))[0];
    expect(readFileSync(join(clone, 'src/hello.ts'), 'utf8')).toContain('hello dolly');
    expect(existsSync(join(clone, 'src/hello.test.ts')), 'no reproducing test was committed').toBe(true);
  }, 85 * 60_000);
});
