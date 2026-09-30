/**
 * CODEMIE, STOOD IN FOR — the service side of the codemie-web set at £0.
 *
 * The codemie-web runner (orchestrations/plugins/providers/codemie-web/) talks to two things CodeMie runs:
 *
 *   the API      users, the LLM catalog, Plugin integrations, stored assistants, and the assistant
 *                chat — which is CodeMie's own agent loop: the model is called with the assistant's
 *                tools, each tool call is carried out, and the loop ends on the model's text.
 *   the engine   a NATS server the local codemie-plugins process connects OUT to with its plugin key.
 *                CodeMie asks `<key>.list` for the plugin's tools and calls each tool on its subject
 *                with a protobuf ServiceRequest; the plugin answers with the tool's result.
 *
 * Both are stood in for here, and nothing else is: the runner, the SDK it calls through, the REAL
 * plugin process (a codeline write in a rehearsal is made by the same toolkit a live run uses) and
 * the model — the mocking agent, called over its own OpenAI wire so every seam is recognised,
 * answered and journalled exactly as on any other set. A plugin key that was never registered as an
 * integration is refused as CodeMie refuses it ("Authorization Violation").
 */
import { createServer as netServer, type Server as NetServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MockAgent } from './agent';

// ── protobuf: the three messages the plugin protocol uses (codemie/generated/proto/v1/service.proto) ──
function varint(n: number): Buffer { const b: number[] = []; while (n > 127) { b.push((n & 127) | 128); n >>>= 7; } b.push(n); return Buffer.from(b); }
const lenField = (no: number, v: Buffer) => Buffer.concat([varint((no << 3) | 2), varint(v.length), v]);
const intField = (no: number, v: number) => Buffer.concat([varint(no << 3), varint(v)]);
function fields(buf: Buffer): Map<number, (Buffer | number)[]> {
  const out = new Map<number, (Buffer | number)[]>(); let i = 0;
  const rd = () => { let r = 0; let s = 0; let b; do { b = buf[i++]; r |= (b & 127) << s; s += 7; } while (b & 128); return r >>> 0; };
  while (i < buf.length) {
    const tag = rd(); const no = tag >>> 3; const wt = tag & 7; let v: Buffer | number;
    if (wt === 0) v = rd(); else if (wt === 2) { const l = rd(); v = buf.subarray(i, i + l); i += l; } else throw new Error(`protobuf wire type ${wt} not used by the plugin protocol`);
    out.set(no, [...(out.get(no) || []), v]);
  }
  return out;
}
const sub = (m: Map<number, (Buffer | number)[]>, no: number) => fields((m.get(no)?.[0] as Buffer) || Buffer.alloc(0));
const str = (m: Map<number, (Buffer | number)[]>, no: number) => ((m.get(no)?.[0] as Buffer) || Buffer.alloc(0)).toString('utf8');
/** ServiceRequest{meta{handler: RUN}, puppet_request{lc_tool{query}}}. */
export const toolRequest = (query: string) => Buffer.concat([lenField(1, intField(2, 1)), lenField(2, lenField(1, lenField(6, Buffer.from(query, 'utf8'))))]);
/** ServiceResponse → the tool's result, or its error. */
export function toolResponse(buf: Buffer): { result: string; error: string } {
  const top = fields(buf); const lc = sub(sub(top, 2), 1);
  return { result: str(lc, 4), error: str(lc, 5) || str(top, 3) };
}

// ── the engine: just enough of the NATS protocol for a plugin to connect, subscribe and answer ──
type Conn = { socket: Socket; buf: Buffer; subs: Map<string, string> };
type Internal = (subject: string, reply: string, payload: Buffer) => void;
const matches = (pattern: string, subject: string) => {
  const p = pattern.split('.'); const s = subject.split('.');
  for (let i = 0; i < p.length; i += 1) { if (p[i] === '>') return true; if (i >= s.length || (p[i] !== '*' && p[i] !== s[i])) return false; }
  return p.length === s.length;
};

export class PluginEngine {
  private server: NetServer;
  private conns = new Set<Conn>();
  private internal = new Map<string, Internal>();
  private inbox = 0;
  port = 0;
  constructor(private authorised: (user: string) => boolean, private log: (line: string) => void = () => {}) {
    this.server = netServer((socket) => this.accept(socket));
    // CodeMie answers a plugin's liveness ping; without an answer it warns every minute.
    this.internal.set('*.live', (_s, reply) => { if (reply) this.publish(reply, '', Buffer.from('alive')); });
  }
  async start() { await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r)); this.port = (this.server.address() as AddressInfo).port; return this.uri; }
  get uri() { return `nats://127.0.0.1:${this.port}`; }
  async stop() { for (const c of this.conns) c.socket.destroy(); await new Promise<void>((r) => this.server.close(() => r())); }
  /** How many plugin connections are open — what a test reads to prove none outlived its run. */
  get connections() { return this.conns.size; }

  private accept(socket: Socket) {
    const c: Conn = { socket, buf: Buffer.alloc(0), subs: new Map() };
    this.conns.add(c);
    socket.on('close', () => this.conns.delete(c));
    socket.on('error', () => this.conns.delete(c));
    socket.write(`INFO ${JSON.stringify({ server_id: 'codemie-stand-in', server_name: 'codemie-stand-in', version: '2.10.0', proto: 1, headers: true, max_payload: 64 << 20, auth_required: true })}\r\n`);
    socket.on('data', (d) => { c.buf = Buffer.concat([c.buf, d]); this.drain(c); });
  }

  private drain(c: Conn) {
    for (;;) {
      const eol = c.buf.indexOf('\r\n'); if (eol < 0) return;
      const line = c.buf.subarray(0, eol).toString('utf8'); const [op, ...a] = line.split(' ').filter(Boolean);
      const OP = (op || '').toUpperCase();
      if (OP === 'PUB' || OP === 'HPUB') {
        const total = Number(a[a.length - 1]); const hdr = OP === 'HPUB' ? Number(a[a.length - 2]) : 0;
        if (c.buf.length < eol + 2 + total + 2) return;
        const body = c.buf.subarray(eol + 2 + hdr, eol + 2 + total);
        const reply = (OP === 'PUB' ? a.length === 3 : a.length === 4) ? a[1] : '';
        c.buf = c.buf.subarray(eol + 2 + total + 2);
        this.publish(a[0], reply, Buffer.from(body));
        continue;
      }
      c.buf = c.buf.subarray(eol + 2);
      if (OP === 'CONNECT') {
        let user = ''; try { user = JSON.parse(line.slice(8)).user || ''; } catch { /* malformed */ }
        if (!this.authorised(user)) { this.log(`refused a plugin whose key is not a registered integration`); c.socket.end("-ERR 'Authorization Violation'\r\n"); return; }
      } else if (OP === 'PING') c.socket.write('PONG\r\n');
      else if (OP === 'SUB') c.subs.set(a[a.length - 1], a[0]);
      else if (OP === 'UNSUB') c.subs.delete(a[0]);
    }
  }

  publish(subject: string, reply: string, payload: Buffer) {
    for (const [pattern, h] of this.internal) if (matches(pattern, subject)) h(subject, reply, payload);
    for (const c of this.conns) {
      for (const [sid, pattern] of c.subs) {
        if (!matches(pattern, subject)) continue;
        c.socket.write(Buffer.concat([Buffer.from(`MSG ${subject} ${sid}${reply ? ` ${reply}` : ''} ${payload.length}\r\n`), payload, Buffer.from('\r\n')]));
      }
    }
  }

  /** A request as CodeMie makes one: publish with a reply inbox, await the first answer. */
  request(subject: string, payload: Buffer, timeoutMs = 120_000): Promise<Buffer> {
    const inbox = `_INBOX.codemie.${(this.inbox += 1)}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.internal.delete(inbox); reject(new Error(`no answer on ${subject} within ${timeoutMs} ms`)); }, timeoutMs);
      this.internal.set(inbox, (_s, _r, p) => { clearTimeout(t); this.internal.delete(inbox); resolve(p); });
      this.publish(subject, inbox, payload);
    });
  }
}

// ── the API ──
type Integration = { id: string; alias: string; project_name: string; credential_type: string; setting_type: string; key: string };
type Assistant = { id: string; name: string; project: string; system_prompt: string; toolkits: any[]; shared: boolean; llm_model_type?: string };
type Tool = { name: string; subject: string; description: string; args_schema: any };
export type Chat = { n: number; assistant: string; model: string; tools: string[]; toolCalls: { name: string; input: unknown; result: string; error: string }[]; generated: unknown; status: number };

export class MockCodeMie {
  readonly engine: PluginEngine;
  readonly integrations: Integration[] = [];
  readonly assistants: Assistant[] = [];
  readonly chats: Chat[] = [];
  private seq = 0;

  /** `models`: the catalog — what the install's ladder can climb to, so a missing rung is the install's fault. */
  constructor(private agent: MockAgent, private journal: string, private models: string[], readonly user = 'rehearsal@codemie.local') {
    this.engine = new PluginEngine((u) => this.integrations.some((i) => i.key === u), (l) => this.note(l));
    mkdirSync(journal, { recursive: true });
    agent.mount((m, p, raw, res) => this.route(m, p, raw, res));
  }
  async start() { await this.engine.start(); return this; }
  async stop() { await this.engine.stop(); }
  get engineUri() { return this.engine.uri; }

  private note(line: string) { try { writeFileSync(join(this.journal, 'codemie-engine.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' }); } catch { /* journal gone */ } }
  private id() { this.seq += 1; return `cm-${String(this.seq).padStart(6, '0')}`; }
  private send(res: ServerResponse, o: unknown, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }

  private route(method: string, path: string, raw: string, res: ServerResponse): boolean {
    const body = () => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };
    if (method === 'GET' && path === '/v1/user') { this.send(res, { user_id: 'rehearsal', name: 'Rehearsal', username: this.user, email: this.user }); return true; }
    if (method === 'GET' && path === '/v1/llm_models') { this.send(res, this.models.map((m) => ({ base_name: m, deployment_name: m, label: m, enabled: true }))); return true; }
    if (path === '/v1/settings/user') {
      if (method === 'GET') { this.send(res, { data: this.integrations.map(({ key, ...i }) => ({ ...i, credential_values: [{ key: 'plugin_key', value: '**********' }] })) }); return true; }
      if (method === 'POST') {
        const b = body();
        const key = String((b.credential_values || []).find((v: any) => v.key === 'plugin_key')?.value || '');
        if (!key) { this.send(res, { error: { message: 'a Plugin integration needs a plugin_key' } }, 422); return true; }
        this.integrations.push({ id: this.id(), alias: b.alias, project_name: b.project_name, credential_type: b.credential_type, setting_type: b.setting_type, key });
        this.send(res, { message: 'created' }); return true;
      }
    }
    const setting = /^\/v1\/settings\/user\/([^/]+)$/.exec(path);
    if (setting && method === 'PUT') {
      const i = this.integrations.findIndex((x) => x.id === setting[1]);
      if (i < 0) { this.send(res, { error: { message: 'setting not found' } }, 404); return true; }
      const b = body();
      const key = String((b.credential_values || []).find((v: any) => v.key === 'plugin_key')?.value || '');
      this.integrations[i] = { ...this.integrations[i], alias: b.alias ?? this.integrations[i].alias, ...(key ? { key } : {}) };
      this.send(res, { message: 'updated' }); return true;
    }
    if (path === '/v1/assistants') {
      if (method === 'GET') { this.send(res, { data: this.assistants.map((a) => ({ id: a.id, name: a.name, project: a.project, shared: a.shared })) }); return true; }
      if (method === 'POST') { const b = body(); const a = { ...b, id: this.id() } as Assistant; this.assistants.push(a); this.send(res, { message: 'created', assistant_id: a.id }); return true; }
    }
    const upd = /^\/v1\/assistants\/([^/]+)$/.exec(path);
    if (upd && method === 'PUT') {
      const i = this.assistants.findIndex((a) => a.id === upd[1]);
      if (i < 0) { this.send(res, { error: { message: 'assistant not found' } }, 404); return true; }
      this.assistants[i] = { ...this.assistants[i], ...body(), id: upd[1] }; this.send(res, { message: 'updated' }); return true;
    }
    const chat = /^\/v1\/assistants\/([^/]+)\/model$/.exec(path);
    if (chat && method === 'POST') { this.chat(chat[1], body(), res).catch((e) => this.send(res, { error: { message: String(e && e.message || e) } }, 500)); return true; }
    return false;
  }

  /** CodeMie's agent loop: the model with the assistant's tools, each tool call carried out through the plugin. */
  private async chat(assistantId: string, b: any, res: ServerResponse) {
    const a = this.assistants.find((x) => x.id === assistantId);
    if (!a) return this.send(res, { error: { message: `assistant ${assistantId} not found` } }, 404);
    const t0 = Date.now();
    const record: Chat = { n: this.chats.length + 1, assistant: a.name, model: String(b.llm_model || a.llm_model_type || ''), tools: [], toolCalls: [], generated: null, status: 200 };
    this.chats.push(record);
    const done = (code: number, payload: unknown) => { record.status = code; writeFileSync(join(this.journal, `codemie-${String(record.n).padStart(4, '0')}.json`), JSON.stringify({ ...record, request: b }, null, 1)); this.send(res, payload, code); };

    // The assistant's tools: the plugin behind each Plugin toolkit it is bound to, asked for its list.
    let tools: Tool[] = [];
    for (const tk of (a.toolkits || []).filter((t: any) => t && t.toolkit === 'Plugin')) {
      const integ = this.integrations.find((i) => i.id === tk.settings?.id);
      if (!integ) return done(422, { error: { message: `the assistant's Plugin toolkit names integration ${tk.settings?.id}, which does not exist` } });
      try { tools = tools.concat(JSON.parse((await this.engine.request(`${integ.key}.list`, Buffer.alloc(0), 30_000)).toString('utf8'))); } catch (e) {
        return done(200, { generated: '', success: false, agentError: { message: `Plugin '${integ.alias}' is not connected: ${(e as Error).message}` }, toolErrors: [] });
      }
    }
    record.tools = tools.map((t) => t.name);
    const messages: any[] = [{ role: 'system', content: a.system_prompt || '' }, { role: 'user', content: String(b.text || '') }];
    const toolErrors: string[] = [];
    for (let turn = 0; turn < 100; turn += 1) {
      const r = await fetch(`${this.agent.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        model: record.model, stream: false, messages,
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.args_schema || { type: 'object', properties: {} } } })) } : {}),
        ...(b.output_schema ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: b.output_schema } } } : {}),
      }) });
      const text = await r.text();
      if (!r.ok) return done(r.status, { error: { message: `model call failed (${r.status}): ${text.slice(0, 400)}` } });
      const msg = JSON.parse(text).choices?.[0]?.message || {};
      if (!msg.tool_calls?.length) {
        let generated: unknown = msg.content ?? '';
        if (b.output_schema && typeof generated === 'string') { try { generated = JSON.parse(generated); } catch { /* CodeMie hands back what the model said */ } }
        record.generated = generated;
        return done(200, { generated, timeElapsed: (Date.now() - t0) / 1000, tokensUsed: null, success: true, toolErrors });
      }
      messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const tool = tools.find((t) => t.name === call.function?.name);
        let out = { result: '', error: `tool ${call.function?.name} is not offered to this assistant` };
        if (tool) { try { out = toolResponse(await this.engine.request(tool.subject, toolRequest(call.function.arguments || '{}'))); } catch (e) { out = { result: '', error: (e as Error).message }; } }
        let input: unknown = call.function?.arguments; try { input = JSON.parse(String(input)); } catch { /* as sent */ }
        record.toolCalls.push({ name: call.function?.name, input, ...out });
        if (out.error) toolErrors.push(out.error);
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.error || out.result });
      }
    }
    return done(200, { generated: '', success: false, agentError: { message: 'the agent loop reached 100 turns' }, toolErrors });
  }
}
