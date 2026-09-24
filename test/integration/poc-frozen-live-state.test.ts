/**
 * POC — BREAK THE PIPELINE WITH THE STATE A REAL RUN LEFT BEHIND.
 *
 * Inputs are NOT authored: the whole directory the last live run left (install, codeline, PRD,
 * logs, .epam/escalations, retry state, review files) is copied as it stands — commit-independent
 * data, exactly what the next resume reads. The code is the real pipeline step, claude.sh for one
 * story. The model is the only stand-in: every request is recorded at the vendor boundary and
 * answered with a minimal message. The assertions are PROPERTIES of what the agents were handed,
 * so a prompt edit does not break them and a regression does.
 *
 *   POC_FROZEN=<dir>  the frozen run directory (default: the 2026-09-24 REGI-009a live run)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MiniMockServer } from './lib/mini-mockserver';
import { edgeFor, zeroCostEnv, run } from './lib/fixture-install';

const FROZEN = process.env.POC_FROZEN || join(process.env.HOME || '', 'projects/ai/frozen-runs/20260924-regi009a-live-v2.0.66');
const STORY = process.env.POC_STORY || 'REGI-009a';
const children: ChildProcess[] = [];
const mock = new MiniMockServer();
let work = ''; let log = ''; let runStart = 0; let startedWith: { reviews: Record<string, number>; escalations: string[] } = { reviews: {}, escalations: [] };
const texts: { seam: string; text: string }[] = [];

/** The Anthropic stream shape the claude CLI reads — one text block. */
function sse(text: string) {
  const ev = (t: string, o: object) => `event: ${t}\ndata: ${JSON.stringify(o)}\n\n`;
  return ev('message_start', { type: 'message_start', message: { id: 'poc', type: 'message', role: 'assistant', model: 'poc', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    + ev('message_stop', { type: 'message_stop' });
}
/** Every text a request carried (system + messages), as one string. */
function requestText(body: string): string {
  try {
    const j = JSON.parse(body);
    const parts: string[] = [];
    const take = (c: any) => { if (typeof c === 'string') parts.push(c); else if (Array.isArray(c)) c.forEach((b) => b && typeof b.text === 'string' && parts.push(b.text)); };
    take(j.system); for (const m of j.messages || []) take(m.content);
    return parts.join('\n');
  } catch { return body; }
}

// THE FIXTURE LIVES OUTSIDE THE REPOSITORY: a real run's leftovers are 400MB and their install/.env
// holds live vendor keys, so they are never committed. Where it is absent this file says so and runs
// nothing — the frozen state IS the input; without it there is nothing to run on.
const HAVE = existsSync(FROZEN);
describe('POC fixture', () => {
  it(HAVE ? `frozen state present: ${FROZEN}` : `SKIPPED — no frozen run state at ${FROZEN} (set POC_FROZEN to a kept live run)`, () => {
    if (!HAVE) console.log(`[poc] no frozen run state at ${FROZEN} — nothing to run on`);
  });
});

beforeAll(async () => {
  if (!HAVE) return;
  await mock.start();
  // Everything answered, everything recorded. Unlimited, lowest priority.
  await fetch(`${mock.url}/mockserver/expectation`, { method: 'PUT', body: JSON.stringify({
    priority: 0, times: { unlimited: true }, httpRequest: { method: 'POST', path: '/v1/messages' },
    httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream; charset=utf-8'], 'x-seam': ['poc-recorded'] }, body: sse('poc stand-in: no work done') } }) });
  work = mkdtempSync(join(tmpdir(), 'poc-frozen-'));
  expect(spawnSync('cp', ['-a', `${FROZEN}/.`, work]).status).toBe(0);
  const install = join(work, 'install');
  // THE ENGINE UNDER TEST, NOT THE FROZEN RUN'S. A frozen run carries both its state and the engine
  // that produced it; only the state is the fixture. The frozen install's engine (scripts, prompt
  // templates, engine config, ecosystems, the built CLI) is replaced by this checkout's, and its state
  // (projects/, logs/, agents/, the codeline, the PRD) is kept exactly as the live run left it.
  const REPO = join(__dirname, '../..');
  for (const d of ['orchestrations/scripts', 'orchestrations/prompts/templates', 'orchestrations/config', 'orchestrations/ecosystems', 'dist']) {
    rmSync(join(install, d), { recursive: true, force: true });
    expect(spawnSync('cp', ['-a', join(REPO, d), join(install, d)]).status, `could not install ${d} under test`).toBe(0);
  }
  const L = join(install, 'orchestrations/logs');
  // WHAT THE RUN STARTS WITH, recorded before it starts: the review files and their age, and the
  // escalation records already on the codeline.
  for (const f of readdirSync(L).filter((x) => /^review-feedback-.*\.json$/.test(x))) startedWith.reviews[f] = statSync(join(L, f)).mtimeMs;
  const escDir = join(work, 'codeline/.epam/escalations');
  startedWith.escalations = existsSync(escDir) ? readdirSync(escDir) : [];
  // NO REAL VENDOR CAN BE REACHED: the copy's .env held live keys. edgeFor rewrites it blank.
  const { bin } = edgeFor(install, mock.url, children);
  const proj = join(install, 'orchestrations/projects/regintel');
  const cfg = (f: string) => Object.fromEntries(readFileSync(join(proj, f), 'utf8').split('\n')
    .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
  const env = zeroCostEnv(bin, mock.url, {
    ...cfg('config.env'), ...cfg('config.mockserver.env'),
    PROJECT_ROOT: join(work, 'codeline'), OUTPUT_DIR: join(work, 'codeline'), PRD_FILE: join(work, 'prd.json'),
    EPAM_PROJECT_CONFIG_DIR: proj, EPAM_PROVIDER_SET: 'mockserver', EPAM_MAX_RETRIES: '1',
    OPENROUTER_API_KEY: '', MINIMAX_API_KEY: '', OPENAI_API_KEY: '',
  });
  runStart = Date.now();
  // A new run, launched now, as the orchestrator launches one: ORCH_RUN_ID is its start stamp.
  env.ORCH_RUN_ID = new Date(runStart).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const r = await run('bash', [join(install, 'orchestrations/scripts/claude.sh'), STORY], { cwd: install, env, timeout: 20 * 60_000 });
  log = (r.stdout || '') + (r.stderr || '');
  writeFileSync(join(work, 'poc-run.log'), log);
  for (const h of mock.hits) texts.push({ seam: h.seam, text: requestText(h.body) });
  console.log(`[poc] frozen=${FROZEN} work=${work} exit=${r.status} model-calls=${mock.hits.length} other=${(mock as any).other?.length ?? '?'}`);
}, 25 * 60_000);
afterAll(async () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } await mock.stop(); });

const writerPrompts = () => texts.filter((t) => new RegExp(`Implement user story ${STORY}\\b|STORY_ID: ${STORY}\\b|# ${STORY}\\b`).test(t.text) && /Acceptance Criteria/.test(t.text));

describe.runIf(HAVE)('POC: the pipeline, run on the state a real run left', () => {
  it('the run reached the model and the writer was asked — otherwise nothing below is tested', () => {
    expect(mock.hits.length, log.split('\n').slice(-40).join('\n')).toBeGreaterThan(0);
    expect(writerPrompts().length, 'no writer prompt for the story was recorded').toBeGreaterThan(0);
  });

  it('nothing left the machine: every model call reached the stand-in', () => {
    expect(log).not.toMatch(/openrouter\.ai|api\.minimax|api\.anthropic\.com/);
  });

  it('BREAK 1: a review written before this run is not handed to the writer as a current rejection', () => {
    const stale = Object.entries(startedWith.reviews).filter(([f, t]) => f.includes(STORY) && t < runStart);
    const first = writerPrompts()[0]?.text || '';
    const presented = /Reviewer Feedback — ADDRESS THESE|this attempt is REJECTED/.test(first);
    console.log(`[poc] BREAK 1: stale review files for ${STORY}: ${stale.map(([f, t]) => `${f} (${new Date(t).toISOString()})`).join(', ') || 'none'}; presented as current: ${presented}`);
    expect(!(stale.length && presented), 'a review from an earlier run was presented to this run\'s first attempt as "BLOCKERS — this attempt is REJECTED"').toBe(true);
  });

  it('...and it is NOT dropped: its findings reach the writer, dated, as a review from an earlier run', () => {
    const first = writerPrompts()[0]?.text || '';
    expect(first).toMatch(/A Review From An Earlier Run \(2026-09-22/);
    expect(first, 'the review\'s own findings were dropped').toMatch(/RU-006/);
  });

  it('BREAK 2: "What Your Last Attempt Did" on this run\'s first attempt is not a diff of the whole codeline', () => {
    const first = writerPrompts()[0]?.text || '';
    writeFileSync(join(work, 'writer-prompt-1.txt'), first);   // the exact prompt, kept for diagnosis
    const block = (first.split('## What Your Last Attempt Did')[1] || '').split('\n## ')[0];
    const foreign = (block.match(/^\s*(\S+)\s+\|/gm) || []).map((l) => l.trim().split(/\s+/)[0])
      .filter((f) => /^\.epam\/|^\.codegraph\/|^\.contracts\//.test(f));
    console.log(`[poc] BREAK 2: block present: ${!!block.trim()}; engine/other-state paths listed as "your last attempt": ${foreign.length} (e.g. ${foreign.slice(0, 4).join(', ')})`);
    expect(foreign, 'the engine\'s own state was described to the writer as its last attempt').toEqual([]);
    expect(block, 'the codeline\'s drift was described as the previous attempt, on the first attempt of the run').not.toMatch(/^The previous attempt changed/m);
  });

  it('BREAK 3: an escalation record left by an earlier run does not start an escalation this run never diagnosed', () => {
    const had = startedWith.escalations.includes(`${STORY}.json`);
    const escalated = new RegExp(`\\[Escalation\\] ${STORY} escalated a defect`).test(log);
    const filedThisRun = new RegExp(`\\[FailureAnalyst\\] target=escalate — filed|escalate_defect_to_sibling_story`).test(log);
    console.log(`[poc] BREAK 3: stale ${STORY}.json on disk at start: ${had}; escalation started: ${escalated}; filed by this run: ${filedThisRun}`);
    expect(!(had && escalated && !filedThisRun), 'an escalation record from an earlier run started a scoped fix nobody in this run asked for').toBe(true);
  });

  it('...and it is NOT dropped: the record is kept as history and its analyst is shown it', () => {
    const hist = join(work, 'codeline/.epam/escalations/history');
    const kept = existsSync(hist) ? readdirSync(hist).filter((f) => f.startsWith(`${STORY}-`)) : [];
    expect(kept.length, 'the earlier record was deleted, not kept').toBeGreaterThan(0);
    const analyst = texts.filter((t) => /self-healing failure analyst/.test(t.text) && t.text.includes(`STORY: ${STORY}`));
    expect(analyst.length, 'the analyst was never asked — nothing to check').toBeGreaterThan(0);
    expect(analyst[0].text).toMatch(/Escalations filed for this story BEFORE this attempt/);
    expect(analyst[0].text).toContain('tests/test_escalation.py');
  });
});
