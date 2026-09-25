/**
 * THE TWO WIRE FORMATS A RUN SPEAKS — parsed and answered exactly as a vendor would.
 *
 * OpenAI-compatible `/chat/completions` (OpenRouter, MiniMax — the providers `epam run` uses) and
 * Anthropic `/v1/messages` (the `claude` CLI). Both streamed and non-streamed. A turn is either
 * text or tool calls; a tool-call turn ends with the vendor's own stop reason for it, or the client
 * will not execute the calls it was handed.
 */
export type ToolDef = { name: string; params: Record<string, any> };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type Req = {
  api: 'openai' | 'anthropic'; model: string; stream: boolean;
  system: string; messages: { role: string; text: string; toolCalls?: ToolCall[]; toolResult?: { id: string; text: string } }[];
  tools: ToolDef[];
};
export type Turn =
  | { kind: 'text'; text: string; stop?: 'end_turn' | 'max_tokens' }
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'http-error'; status: number; body: string }
  | { kind: 'hang' };

const textOf = (c: any): string => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p && (p.text ?? (typeof p.content === 'string' ? p.content : textOf(p.content))) || '')).join('\n')
    : c && typeof c === 'object' ? String(c.text ?? '') : '');

export function parse(path: string, raw: string): Req | null {
  let b: any; try { b = JSON.parse(raw); } catch { return null; }
  if (/\/messages$/.test(path)) {
    const messages: Req['messages'] = [];
    for (const m of b.messages || []) {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      const calls = parts.filter((p: any) => p.type === 'tool_use').map((p: any) => ({ id: p.id, name: p.name, input: p.input || {} }));
      for (const r of parts.filter((p: any) => p.type === 'tool_result')) messages.push({ role: 'tool', text: textOf(r.content), toolResult: { id: r.tool_use_id, text: textOf(r.content) } });
      const text = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('\n');
      if (text || calls.length) messages.push({ role: m.role, text, toolCalls: calls.length ? calls : undefined });
    }
    return { api: 'anthropic', model: b.model || '', stream: !!b.stream, system: textOf(b.system), messages,
      tools: (b.tools || []).map((t: any) => ({ name: t.name, params: t.input_schema || {} })) };
  }
  if (/chat\/completions$/.test(path)) {
    const messages: Req['messages'] = []; let system = '';
    for (const m of b.messages || []) {
      if (m.role === 'system') { system += textOf(m.content) + '\n'; continue; }
      if (m.role === 'tool') { messages.push({ role: 'tool', text: textOf(m.content), toolResult: { id: m.tool_call_id, text: textOf(m.content) } }); continue; }
      const calls = (m.tool_calls || []).map((c: any) => { let input = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* as sent */ } return { id: c.id, name: c.function?.name, input }; });
      messages.push({ role: m.role, text: textOf(m.content), toolCalls: calls.length ? calls : undefined });
    }
    return { api: 'openai', model: b.model || '', stream: !!b.stream, system, messages,
      tools: (b.tools || []).map((t: any) => ({ name: t.function?.name || t.name, params: t.function?.parameters || {} })) };
  }
  return null;
}

let seq = 0;
const id = (p: string) => `${p}_mock_${(seq += 1)}`;

/** The response body and headers for a turn, in the request's own wire format. */
export function encode(req: Req, turn: Turn, usage = { in: 1000, out: 200 }): { status: number; headers: Record<string, string>; body: string } {
  if (turn.kind === 'http-error') return { status: turn.status, headers: { 'content-type': 'application/json' }, body: turn.body };
  if (turn.kind === 'hang') throw new Error('hang is served by the server, not encoded');
  if (req.api === 'openai') {
    const finish = turn.kind === 'tools' ? 'tool_calls' : turn.stop === 'max_tokens' ? 'length' : 'stop';
    const message: any = turn.kind === 'tools'
      ? { role: 'assistant', content: null, tool_calls: turn.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
      : { role: 'assistant', content: turn.text };
    const u = { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out };
    if (!req.stream) {
      return { status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id('chatcmpl'), object: 'chat.completion', model: req.model, choices: [{ index: 0, message, finish_reason: finish }], usage: u }) };
    }
    const cid = id('chatcmpl'); const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const chunk = (delta: unknown, fr: string | null = null, extra: Record<string, unknown> = {}) => ev({ id: cid, object: 'chat.completion.chunk', model: req.model, choices: [{ index: 0, delta, finish_reason: fr }], ...extra });
    let out = chunk({ role: 'assistant', content: '' });
    if (turn.kind === 'tools') {
      turn.calls.forEach((c, i) => {
        out += chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
        for (const piece of pieces(JSON.stringify(c.input))) out += chunk({ tool_calls: [{ index: i, function: { arguments: piece } }] });
      });
    } else for (const piece of pieces(turn.text)) out += chunk({ content: piece });
    out += chunk({}, finish, { usage: u });
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: `${out}data: [DONE]\n\n` };
  }
  const stop = turn.kind === 'tools' ? 'tool_use' : turn.stop || 'end_turn';
  const content = turn.kind === 'tools' ? turn.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) : [{ type: 'text', text: turn.text }];
  if (!req.stream) {
    return { status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id('msg'), type: 'message', role: 'assistant', model: req.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: usage.in, output_tokens: usage.out } }) };
  }
  const ev = (type: string, o: unknown) => `event: ${type}\ndata: ${JSON.stringify(o)}\n\n`;
  let out = ev('message_start', { type: 'message_start', message: { id: id('msg'), type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.in, output_tokens: 1 } } });
  content.forEach((c: any, i) => {
    if (c.type === 'tool_use') {
      out += ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      for (const piece of pieces(JSON.stringify(c.input))) out += ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: piece } });
    } else {
      out += ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      for (const piece of pieces(c.text)) out += ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } });
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index: i });
  });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.out } });
  out += ev('message_stop', { type: 'message_stop' });
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: out };
}

/** As a vendor streams: many small deltas, never the whole value in one. */
function pieces(s: string): string[] {
  const out: string[] = []; for (let i = 0; i < s.length; i += 40) out.push(s.slice(i, i + 40));
  return out.length ? out : [''];
}

export const newCallId = () => id('call');
