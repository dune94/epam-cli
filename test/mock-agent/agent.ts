/**
 * THE MOCKING AGENT — the model side of a £0 run, answering every call live.
 *
 * It stands where the vendor stands (the base URL the providers already read), so the pipeline is
 * driven exactly as a paid run drives it: the real launcher, orchestrator, runners, parsers and
 * gates, with nothing lifted out of them. For each call it:
 *
 *   1. recognises the seam from the fixed text of the template the prompt was rendered from;
 *   2. reads that seam's contract from the engine's declarations, at the moment of the call;
 *   3. answers from the request's own content, in the format the prompt states — or, where the
 *      scenario says so for this seam/story/attempt, in one of the ways models really go wrong.
 *
 * Every exchange is written to the journal directory as it happens, so a run is diagnosed from what
 * the pipeline actually sent and received, and nothing generated is lost.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Declarations } from './declarations';
import { parse, encode, type Req, type Turn } from './wire';
import { reconcile, contractConflict } from './answer';

export type Call = { n: number; seam: string; template: string; coverage: number; story: string; attempt: number; req: Req };
/** A seam's behaviour: given the call, the next turn. Returning null falls through to the default. */
export type Behaviour = (call: Call, agent: MockAgent) => Turn | null;
/** A turn the scenario means to be WRONG is labelled so; everything else must fit the current code. */
export const negative = (t: Turn, why: string): Turn & { negative: string } => ({ ...t, negative: why } as Turn & { negative: string });

export class MockAgent {
  private server: Server;
  readonly decl: Declarations;
  readonly calls: Call[] = [];
  readonly other: { method: string; path: string }[] = [];
  /** Answers meant as correct that the CURRENT contract rejects — never served; the test must fail. */
  readonly stale: { n: number; seam: string; reasons: string[] }[] = [];
  /** Where a prompt and its seam's declared contract disagree — pipeline findings, one per template. */
  readonly conflicts = new Map<string, { seam: string; template: string; reasons: string[] }>();
  private attempts = new Map<string, number>();
  private behaviours = new Map<string, Behaviour>();
  port = 0;

  constructor(orchestrationsDir: string, readonly journal: string, readonly knownStories: () => string[] = () => [], readonly modes: string[] = []) {
    this.decl = new Declarations(orchestrationsDir);
    mkdirSync(journal, { recursive: true });
    this.server = createServer((req, res) => this.handle(req, res));
  }

  /** Register how a seam answers. The last registration for a seam wins. */
  on(seam: string, b: Behaviour) { this.behaviours.set(seam, b); return this; }

  async start() { await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r)); this.port = (this.server.address() as AddressInfo).port; return this.url; }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url || '/').split('?')[0];
      const method = (req.method || 'GET').toUpperCase();
      const parsed = method === 'POST' ? parse(path, raw) : null;
      if (parsed) return this.answer(parsed, path, raw, res);
      this.other.push({ method, path });
      // The observability surfaces a run touches (dashboard, Langfuse, Grafana): a healthy stack.
      if (path === '/build-info.json') return this.json(res, { generatedAt: new Date().toISOString(), metrics: { selfHealing: {} } });
      if (path.startsWith('/api/public/')) return method === 'POST' ? this.json(res, { successes: [], errors: [] }, 207) : this.json(res, { data: [], meta: { totalItems: 0, totalPages: 0 } });
      if (/\/credits$/.test(path)) return this.json(res, { data: { total_credits: 1000, total_usage: 0 } });
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
  }

  private answer(req: Req, path: string, raw: string, res: ServerResponse) {
    // The FIRST user turn is the rendered prompt; the system text may carry the persona.
    const first = req.messages.find((m) => m.role === 'user')?.text || '';
    const whole = `${req.system}\n${first}`;
    const id = this.decl.identify(whole, this.modes);
    const seam = id ? this.decl.seamOf(id.template, this.modes) : 'UNRECOGNISED';
    // THE STORY THIS CALL IS FOR: the one the prompt names FIRST. A prompt names its own story in
    // its header before any dependency it cites; PRD order picked the dependency (REGI-002's writer
    // was answered as REGI-001's).
    const story = this.knownStories()
      .map((s) => ({ s, at: first.search(new RegExp(`(^|[^\\w-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`)) }))
      .filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0]?.s || '';
    // An attempt is a fresh conversation (one user turn, no tool results) for this seam and story.
    const fresh = !req.messages.some((m) => m.role === 'tool' || m.toolCalls);
    const key = `${seam}|${story}`;
    if (fresh) this.attempts.set(key, (this.attempts.get(key) || 0) + 1);
    const call: Call = { n: this.calls.length + 1, seam, template: id?.template.id || '', coverage: id?.coverage || 0, story, attempt: this.attempts.get(key) || 1, req };
    this.calls.push(call);

    let turn: Turn | null = null; let error = '';
    try { turn = (this.behaviours.get(seam) || this.behaviours.get('*'))?.(call, this) ?? null; } catch (e) { error = String((e as Error).stack || e); }
    if (!turn) turn = { kind: 'text', text: `{"error":"the mock agent has no behaviour for seam ${seam}"}` };
    // RECONCILED BEFORE SERVED: a correct answer the current contract cannot accommodate is a stale
    // mock. It is recorded and replaced by an HTTP error, so the run shows the mock's fault as the
    // mock's, never as a pipeline defect.
    const conflict = contractConflict(whole, this.decl.contractOf(seam));
    if (conflict.length && !this.conflicts.has(call.template)) this.conflicts.set(call.template, { seam, template: call.template, reasons: conflict });
    const neg = (turn as { negative?: string }).negative || '';
    const stale = !neg && turn.kind === 'text' ? reconcile(turn.text, this.decl.contractOf(seam), whole) : [];
    if (stale.length) { this.stale.push({ n: call.n, seam, reasons: stale }); turn = { kind: 'http-error', status: 599, body: JSON.stringify({ error: { message: `STALE MOCK for ${seam}: ${stale.join('; ')}` } }) }; }
    const file = join(this.journal, `${String(call.n).padStart(4, '0')}-${seam.replace(/[^\w.-]+/g, '_')}${story ? `-${story}` : ''}.json`);
    writeFileSync(file, JSON.stringify({ n: call.n, path, seam, template: call.template, coverage: call.coverage, story, attempt: call.attempt, negative: neg, stale, turn, error, request: JSON.parse(raw) }, null, 1));
    if (turn.kind === 'hang') return; // the client's own timeout is what is under test
    const out = encode(req, turn);
    res.writeHead(out.status, out.headers); res.end(out.body);
  }

  private json(res: ServerResponse, o: unknown, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }
}
