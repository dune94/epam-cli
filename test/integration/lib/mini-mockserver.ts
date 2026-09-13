/**
 * THE NETWORK EDGE OF A £0 RUN, IN-PROCESS.
 *
 * A rehearsal answers every model call from MockServer and talks to three observability services
 * (dashboard, Langfuse, Grafana). This is the subset of those four HTTP surfaces a run actually
 * touches, so an integration test can drive the REAL launcher, orchestrator, mint, runners and
 * the real `claude` CLI with nothing outside the test process on the wire. It is the edge, not a
 * stub of any pipeline component: what it serves for the model is whatever mock-expectations.js
 * registered, exactly as the container would.
 *
 * Implemented MockServer semantics (the ones mock-expectations.js relies on):
 *   PUT /mockserver/expectation   store {priority, times, httpRequest{method,path,body}, httpResponse}
 *   PUT /mockserver/reset         forget everything
 *   PUT /mockserver/status        200
 *   POST <anything>               highest priority first, insertion order within a priority;
 *                                 path is a regex; body STRING/subString or Java REGEX ((?s) prefix
 *                                 → dotAll, full match); remainingTimes consumed per hit.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Expectation = {
  priority: number; seq: number;
  times?: { remainingTimes: number; unlimited: boolean };
  httpRequest: { method?: string; path?: string; body?: any };
  httpResponse: { statusCode?: number; headers?: Record<string, string[]>; body?: string };
};

export type Hit = { path: string; seam: string; body: string };

export class MiniMockServer {
  private server: Server;
  private expectations: Expectation[] = [];
  private seq = 0;
  /** Every model call served, in order, with the x-seam header the expectation carried. */
  readonly hits: Hit[] = [];
  /** Every non-mock request (dashboard, Langfuse, Grafana), for the assertions that care. */
  readonly other: { method: string; path: string }[] = [];
  port = 0;

  constructor() { this.server = createServer((req, res) => this.handle(req, res)); }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this.url;
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url || '/').split('?')[0];
      const method = (req.method || 'GET').toUpperCase();
      if (path.startsWith('/mockserver/')) return this.control(path, body, res);
      if (method === 'POST' && this.serveExpectation(path, body, res)) return;
      this.other.push({ method, path });
      // The observability surfaces: a run asks for these, and a healthy stack answers 200.
      if (path === '/build-info.json') {
        return this.json(res, { generatedAt: new Date().toISOString(), metrics: { selfHealing: {} } });
      }
      if (path.startsWith('/api/public/')) {
        // Langfuse: nothing recorded here; ingestion accepted.
        return method === 'POST' ? this.json(res, { successes: [], errors: [] }, 207) : this.json(res, { data: [], meta: { totalItems: 0, totalPages: 0 } });
      }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
  }

  private control(path: string, body: string, res: ServerResponse) {
    if (path === '/mockserver/expectation') {
      const e = JSON.parse(body);
      this.expectations.push({ ...e, priority: e.priority ?? 0, seq: this.seq++ });
      this.expectations.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
      res.writeHead(201); return res.end();
    }
    if (path === '/mockserver/reset') { this.expectations = []; this.hits.length = 0; res.writeHead(200); return res.end(); }
    res.writeHead(200); res.end();
  }

  private matches(e: Expectation, path: string, body: string): boolean {
    const r = e.httpRequest;
    if (r.method && r.method.toUpperCase() !== 'POST') return false;
    if (r.path && !new RegExp(`^(?:${r.path})$`).test(path)) return false;
    const b = r.body;
    if (!b) return true;
    if (b.type === 'STRING') return b.subString ? body.includes(b.string) : body === b.string;
    if (b.type === 'REGEX') {
      let src = String(b.regex); let flags = '';
      if (src.startsWith('(?s)')) { src = src.slice(4); flags += 's'; }
      return new RegExp(`^(?:${src})$`, flags).test(body);
    }
    return false;
  }

  private serveExpectation(path: string, body: string, res: ServerResponse): boolean {
    const e = this.expectations.find((x) => this.matches(x, path, body));
    if (!e) return false;
    if (e.times && !e.times.unlimited) {
      e.times.remainingTimes -= 1;
      if (e.times.remainingTimes <= 0) this.expectations = this.expectations.filter((x) => x !== e);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.httpResponse.headers || {})) headers[k] = v.join(', ');
    this.hits.push({ path, seam: headers['x-seam'] || '', body });
    res.writeHead(e.httpResponse.statusCode || 200, headers);
    res.end(e.httpResponse.body || '');
    return true;
  }

  private json(res: ServerResponse, o: unknown, code = 200) {
    res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o));
  }
}
