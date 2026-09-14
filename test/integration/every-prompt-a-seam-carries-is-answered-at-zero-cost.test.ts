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
const { substituteOnce: _substituteOnce, placeholdersIn } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
// The real one-pass substitution, over every placeholder the body carries.
const substituteOnce = (body: string, values: Record<string, string>) => _substituteOnce(body, placeholdersIn(body), values);
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

function register(url: string): Promise<void> {
  const p = greenfieldProject();
  return new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, [join(ROOT, 'orchestrations/scripts/mock-expectations.js'), '--host', url], {
      cwd: ROOT, env: { ...process.env, PRD_FILE: p.prd, EPAM_PROJECT_CONFIG_DIR: p.dir, OUTPUT_DIR: p.out, EPAM_PROVIDER_SET: 'mockserver', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = ''; c.stderr.on('data', (d) => { err += d; }); c.stdout.resume();
    c.on('close', (s) => (s === 0 ? resolve() : reject(new Error(`mock-expectations.js exited ${s}: ${err}`))));
  });
}
function askAt(url: string, prompt: string): Promise<{ seam: string; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, messages: [{ role: 'user', content: prompt }] });
    const req = httpRequest(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || ''), body: b }));
    });
    req.on('error', reject); req.end(body);
  });
}

const mock = new MiniMockServer();
beforeAll(async () => { await mock.start(); await register(mock.url); }, 300_000);
afterAll(() => mock.stop());
const ask = (prompt: string) => askAt(mock.url, prompt);

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

/**
 * A PROMPT THAT EMBEDS ANOTHER PROMPT IS ANSWERED AS ITSELF. The prompt reviewer is handed the whole
 * template it judges, so its request carries the reviewed seam's fingerprint too; matched on
 * fingerprints alone it was answered as the reviewed seam — `{"verdict":"pass"}`, no
 * <PROMPT_REVIEW> block — and seven prompts were installed UNREVIEWED (run 22, 2026-09-14). The real
 * reviewer, rendering its real template around every whole prompt, judged by whether it read a
 * review that RAN.
 */
describe('a prompt that embeds another prompt is answered as itself', () => {
  const { makePromptReviewer } = require(join(ROOT, 'orchestrations/scripts/lib/prompt-review.js'));
  // The reviewer's own template id, read from what the real reviewer asks its renderer for.
  let reviewerId = '';
  makePromptReviewer({ render: (id: string) => { reviewerId = id; return 'x'; }, invoke: async () => '', values: () => ({}), warn: () => {}, projectConfigDir: '/p' })({ id: 'probe', template: {}, generated: {} });
  const reviewerDoc = () => JSON.parse(readFileSync(join(TPL, `${reviewerId}.json`), 'utf8'));
  it('the reviewer renders a template that exists', () => { expect(reviewerId).toBeTruthy(); expect(existsSync(join(TPL, `${reviewerId}.json`))).toBe(true); });
  it.each(templates.map((t) => t.id))('the reviewer of %s reads a review that RAN', async (id) => {
    const { doc } = templates.find((t) => t.id === id)!;
    const embedded = substituteOnce(doc.body, Object.fromEntries(placeholdersIn(doc.body).map((p: string) => [p, `value of ${p}`])));
    const rdoc = reviewerDoc();
    const warnings: string[] = [];
    const review = makePromptReviewer({
      // Every placeholder of the reviewer's template carries the reviewed prompt — the template
      // under review and the generated copy are both that prompt, and anything else is at least
      // as embedded.
      render: () => substituteOnce(rdoc.body, Object.fromEntries(placeholdersIn(rdoc.body).map((p: string) => [p, embedded]))),
      invoke: async (prompt: string) => {
        const { seam, body } = await ask(prompt);
        expect(seam, `the reviewer's request for ${id} was answered as "${seam}"`).toBe(reviewerId);
        const text = [...body.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
        return text;
      },
      values: () => ({}), warn: (m: string) => warnings.push(m), projectConfigDir: '/p',
    });
    const out = await review({ id, template: { body: doc.body }, generated: { body: embedded } });
    expect(out.ok).toBe(true);
    expect(warnings.join('\n'), warnings.join('\n')).not.toMatch(/UNREVIEWED/);
  });
});

/**
 * THE ATTEMPT ANALYST IS REACHED: one first attempt fails on purpose. The registry declares whose
 * failed attempts reach agent-failure-analyst (diagnosesAttemptsOf); a stand-in that always answers
 * never lets that seam execute — twenty-two rehearsals reported it never run (2026-09-14). For each
 * declared seam the first call is prose that satisfies no contract and the second is the answer.
 */
describe('one first attempt fails on purpose for the seams the analyst diagnoses', () => {
  // A fresh mock: the first attempt is consumed once, and the suites above have already asked.
  const own = new MiniMockServer();
  beforeAll(async () => { await own.start(); await register(own.url); }, 300_000);
  afterAll(() => own.stop());
  const ask = (prompt: string) => askAt(own.url, prompt);
  const declared = Object.values(reg).flatMap((p: any) => (Array.isArray(p.diagnosesAttemptsOf) ? p.diagnosesAttemptsOf : [])) as string[];
  it('the registry declares whose attempts the analyst diagnoses', () => { expect(declared.length).toBeGreaterThan(0); });
  const rr = require(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'));
  const gp = greenfieldProject();
  const prevSet2 = process.env.EPAM_PROVIDER_SET; process.env.EPAM_PROVIDER_SET = 'mockserver';
  let soTool = '';
  try { soTool = rr.declaredRunners({ projectConfigDir: gp.dir }).map((n: string) => rr.resolveRunner(n, { projectConfigDir: gp.dir }).structuredOutputTool).find(Boolean) as string; }
  finally { if (prevSet2 === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = prevSet2; }
  it('the set declares the structured-output tool the first failure must survive', () => { expect(soTool).toBeTruthy(); });
  it.each(declared.filter((s) => reg[s] && templates.some((t) => t.id === reg[s].template)))('%s: first prose, then the answer', async (seam) => {
    const { doc } = templates.find((t) => t.id === reg[seam].template)!;
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    const prompt = substituteOnce(doc.body, values);
    // The runner enforces its schema, so the first failure is a HOLLOW structured answer — the
    // contract's shape with nothing in it — delivered as a call to the structured-output tool.
    const askSO = (p: string) => new Promise<{ seam: string; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, tools: [{ name: soTool, input_schema: { type: 'object' } }], messages: [{ role: 'user', content: p }] });
      const req = httpRequest(`${own.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || ''), body: b }));
      });
      req.on('error', reject); req.end(body);
    });
    const payloadOf = (b: string) => JSON.parse(JSON.parse(`"${b.match(/"partial_json":"((?:[^"\\]|\\.)*)"/)![1]}"`));
    const hollow = (v: any): boolean => (Array.isArray(v) ? v.length === 0 : v && typeof v === 'object' ? Object.values(v).every(hollow) : typeof v === 'string' ? v === '' : true);
    const first = await askSO(prompt);
    expect(first.seam).toBe(`${seam}:first-attempt-fails`);
    expect(hollow(payloadOf(first.body)), 'the first answer carries nothing a consumer can use').toBe(true);
    const second = await askSO(prompt);
    expect(second.seam).toBe(`${seam}:structured`);
    expect(hollow(payloadOf(second.body)), 'the second answer is the real one').toBe(false);
  });
});

/**
 * ONE FIRST VERDICT REJECTS ON PURPOSE, for the reviewer whose rejection runs another seam
 * (runsOnRejectionBy): a stand-in that always approves never let the change summarizer execute.
 */
describe('one first verdict rejects on purpose for the reviewer whose rejection runs a seam', () => {
  const own = new MiniMockServer();
  beforeAll(async () => { await own.start(); await register(own.url); }, 300_000);
  afterAll(() => own.stop());
  const ask = (prompt: string) => askAt(own.url, prompt);
  const reviewers = Object.values(reg).flatMap((p: any) => (Array.isArray(p.runsOnRejectionBy) ? p.runsOnRejectionBy : [])) as string[];
  it('the registry declares a seam that runs on a rejection', () => { expect(reviewers.length).toBeGreaterThan(0); });
  it.each(reviewers.filter((s) => reg[s] && templates.some((t) => t.id === reg[s].template)))('%s: fail first, then pass', async (seam) => {
    const { doc } = templates.find((t) => t.id === reg[seam].template)!;
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    const prompt = substituteOnce(doc.body, values);
    const text = (b: string) => [...b.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
    // The rejecting and passing words are the seam's own: declared by its contract (rejectsWith)
    // and offered first by its prompt, else the generic verdict vocabulary (fail / pass).
    const contract = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/seam-output-contracts.json'), 'utf8')).seams[seam] || {};
    const rejecting = (contract.rejectsWith && contract.rejectsWith.verdict) || 'fail';
    const first = await ask(prompt);
    expect(first.seam).toBe(`${seam}:first-verdict-rejects`);
    expect(JSON.parse(text(first.body)).verdict).toBe(rejecting);
    const second = await ask(prompt);
    expect(second.seam).toBe(seam);
    const passing = JSON.parse(text(second.body)).verdict;
    expect(passing).not.toBe(rejecting);
    const offered = [...String(doc.body).matchAll(/"verdict"\s*:\s*(.*)$/gm)].flatMap((m) => [...m[1].split(/,\s*"[A-Za-z_]+"\s*:/)[0].matchAll(/"([a-z_-]+)"/g)].map((w) => w[1]));
    expect(offered.length ? offered : ['pass']).toContain(passing);
  });
});

/**
 * A REQUEST THAT DECLARES THE RUNNER'S STRUCTURED-OUTPUT TOOL IS ANSWERED BY CALLING IT. Under
 * --json-schema the runner declares that tool and requires the reply to call it; answered in text,
 * every seam of the £0 harness cost an enforcement turn and the structured-output path a real model
 * takes was never exercised (2026-09-14). The tool's name is the set's declaration for its runner.
 */
describe('a schema-bound request is answered by calling the structured-output tool', () => {
  const r = require(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'));
  const p = greenfieldProject();
  // The rehearsal set — the one the registration above runs under.
  const prevSet = process.env.EPAM_PROVIDER_SET; process.env.EPAM_PROVIDER_SET = 'mockserver';
  let tool = '';
  try { tool = r.declaredRunners({ projectConfigDir: p.dir }).map((n: string) => r.resolveRunner(n, { projectConfigDir: p.dir }).structuredOutputTool).find(Boolean) as string; }
  finally { if (prevSet === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = prevSet; }
  it('the set declares its runner\'s structured-output tool', () => { expect(tool).toBeTruthy(); });
  const askWithTool = (prompt: string) => new Promise<{ seam: string; body: string }>((resolve, reject) => {
    const body = JSON.stringify({ model: 'x', max_tokens: 1, stream: true, tools: [{ name: tool, input_schema: { type: 'object' } }], messages: [{ role: 'user', content: prompt }] });
    const req = httpRequest(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ seam: String(res.headers['x-seam'] || ''), body: b }));
    });
    req.on('error', reject); req.end(body);
  });
  // The seams the analyst/rejection first-failures do not touch, so the first answer is the answer.
  const plain = templates.filter(({ doc }) => !Object.values(reg).some((q: any) => (q.diagnosesAttemptsOf || []).concat(q.runsOnRejectionBy || []).includes(doc.seams[0])));
  it.each(plain.slice(0, 12).map((t) => t.id))('%s: answered as a call to the structured-output tool carrying a payload', async (id) => {
    const { doc } = templates.find((t) => t.id === id)!;
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const ph of placeholdersIn(doc.body)) values[ph] = optional.has(ph) ? '' : `value of ${ph.replace(/_/g, ' ').trim()}`;
    const { seam, body } = await askWithTool(substituteOnce(doc.body, values));
    expect(seam).toMatch(new RegExp(`^${doc.seams[0]}(:|$)`));
    expect(seam).toMatch(/:structured$/);
    expect(body).toContain(`"name":"${tool}"`);
    const json = body.match(/"partial_json":"((?:[^"\\]|\\.)*)"/);
    expect(json, 'the call carries a payload').toBeTruthy();
    const payload = JSON.parse(JSON.parse(`"${json![1]}"`));
    expect(payload && typeof payload === 'object').toBe(true);
    expect(Object.keys(payload).length).toBeGreaterThan(0);
  });
});

/**
 * A SEAM ASKED IN TEXT — no structured-output tool declared — meets a prose first failure. The
 * tc-writer binds no schema; once the assessment's schema stopped leaking into it (run 27), it was
 * asked in text and met no first failure at all.
 */
describe('a seam asked in text meets a prose first failure', () => {
  const own = new MiniMockServer();
  beforeAll(async () => { await own.start(); await register(own.url); }, 300_000);
  afterAll(() => own.stop());
  const declared = Object.values(reg).flatMap((p: any) => (Array.isArray(p.diagnosesAttemptsOf) ? p.diagnosesAttemptsOf : [])) as string[];
  it.each(declared.filter((s) => reg[s] && templates.some((t) => t.id === reg[s].template)))('%s: prose first, the answer second', async (seam) => {
    const { doc } = templates.find((t) => t.id === reg[seam].template)!;
    const values: Record<string, string> = {};
    const optional = new Set(doc.mayBeEmpty || []);
    for (const p of placeholdersIn(doc.body)) values[p] = optional.has(p) ? '' : `value of ${p.replace(/_/g, ' ').trim()}`;
    const prompt = substituteOnce(doc.body, values);
    const text = (b: string) => [...b.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
    const first = await askAt(own.url, prompt);
    expect(first.seam).toBe(`${seam}:first-attempt-fails`);
    expect(() => JSON.parse(text(first.body))).toThrow();
    const second = await askAt(own.url, prompt);
    expect(second.seam).toBe(seam);
  });
});
