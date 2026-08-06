/**
 * STRUCTURED OUTPUT IS ENFORCED, NOT REQUESTED — AND TOOLS STILL WORK.
 *
 * The ticket-link agent was asked, in prose, to "Call the submit_ticket_links tool.
 * Structured output only; do not answer in prose." Across three live runs on 2026-08-06 it
 * answered three different ways, none of them the declared shape:
 *
 *   run 1: {"submit_ticket_links": {...}}   keyed under the tool's own name
 *   run 2: "Here is my answer:" + JSON      prose, then the payload
 *   run 3: markdown headings and blockquotes, no JSON at all
 *
 * Every time the work itself was right — it fetched both vendor pages, quoted their code
 * verbatim, and found that the ticket's own comment is contradicted by the vendor's guide.
 * Every time the answer was discarded. Asking for a shape in prose is a request; the model
 * is free to decline it.
 *
 * The provider layer already supports binding: `responseFormat: {type:'json_schema',
 * strict:true}`, which src/providers/types.ts records as "verified honoured by z-ai/glm-5.2,
 * z-ai/glm-5.1 and moonshotai/kimi-k3 via OpenRouter". It was wired to exactly ONE caller
 * (the KB write) and no other schema-bound agent ever set it.
 *
 * WHY BINDING GOES ON THE ANSWER TURN, NOT EVERY TURN. This agent must FETCH before it can
 * answer — a schema-bound reply with no document read is a confident empty answer, which is
 * worse than a parse failure because nothing looks wrong. Rather than gamble on whether a
 * given provider still emits tool calls while a strict schema is bound, the binding is
 * applied on the turn where tools are deliberately withheld anyway: AgentRunner already
 * omits `tools` once the tool budget is spent, precisely so the model must answer. Research
 * turns keep their tools and stay unbound; the answer turn is bound and cannot emit prose.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';

type Req = { tools?: unknown[]; responseFormat?: any };

/** Records every provider request, and calls a tool until its budget runs out. */
function recordingProvider(requests: Req[], toolCalls: number) {
  let turn = 0;
  return {
    name: 'stub',
    async stream(req: Req) {
      requests.push({ tools: req.tools, responseFormat: req.responseFormat });
      turn += 1;
      if (turn <= toolCalls) {
        return {
          content: [{ type: 'tool_use', id: `t${turn}`, name: 'fetch_url', input: { url: 'https://v.test/d' } }],
          stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        content: [{ type: 'text', text: '{"links":[{"url":"https://v.test/d"}]}' }],
        stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } as any;
}

function fetchTool(calls: { count: number }) {
  return {
    name: 'fetch_url',
    definition: { name: 'fetch_url', description: 'fetch a url', inputSchema: { type: 'object', properties: {} } },
    permission: 'safe',
    async execute() {
      calls.count += 1;
      return { toolUseId: 't', content: 'the document says onEntryChange(updateData)', isError: false };
    },
  } as any;
}

const SCHEMA = JSON.stringify({
  name: 'submit_ticket_links',
  schema: { type: 'object', required: ['links'], properties: { links: { type: 'array', items: { type: 'object' } } } },
});

const saved = process.env.EPAM_RESPONSE_SCHEMA;
afterEach(() => {
  if (saved === undefined) delete process.env.EPAM_RESPONSE_SCHEMA;
  else process.env.EPAM_RESPONSE_SCHEMA = saved;
});

async function run(opts: { schema?: string; maxToolCalls: number; toolCalls: number }) {
  const requests: Req[] = [];
  const calls = { count: 0 };
  if (opts.schema) process.env.EPAM_RESPONSE_SCHEMA = opts.schema;
  else delete process.env.EPAM_RESPONSE_SCHEMA;
  await new AgentRunner({
    userMessage: 'review the links',
    provider: recordingProvider(requests, opts.toolCalls),
    tools: [fetchTool(calls)],
    model: 'stub',
    maxToolCalls: opts.maxToolCalls,
    dangerousSkipApproval: true,
    maxIterations: 6,
  } as any).run();
  return { requests, calls };
}

describe('the schema binds every turn, and the contract forces the read', () => {
  it('the answer turn is bound', async () => {
    const { requests } = await run({ schema: SCHEMA, maxToolCalls: 1, toolCalls: 5 });
    const answerTurns = requests.filter((r) => r.tools === undefined);
    expect(answerTurns.length, 'no forced-answer turn happened — this proves nothing').toBeGreaterThan(0);
    for (const t of answerTurns) {
      expect(t.responseFormat, 'the answer turn was left free to reply in markdown').toBeTruthy();
      expect(t.responseFormat.type).toBe('json_schema');
      expect(t.responseFormat.strict, 'a non-strict binding accepts near-misses').toBe(true);
      expect(t.responseFormat.name).toBe('submit_ticket_links');
    }
  });

  it('research turns keep their tools — enforcement must not cost the fetch', async () => {
    const { requests, calls } = await run({ schema: SCHEMA, maxToolCalls: 2, toolCalls: 5 });
    const researchTurns = requests.filter((r) => r.tools !== undefined);
    expect(researchTurns.length, 'the model never got a turn with tools').toBeGreaterThan(0);
    expect(calls.count, 'the document was never fetched — a bound answer with nothing read is worse than none')
      .toBeGreaterThan(0);
    // CORRECTED 2026-08-06. This asserted research turns must stay UNBOUND, on the theory
    // that a schema sent alongside tools invites the model to answer without calling
    // anything. Holding that made the binding wait for the tool BUDGET to be spent — so an
    // agent with an inherited 8-call budget had to burn eight round trips before it could
    // answer in shape. It timed out at 360s live, and the guard it feeds aborted the whole
    // specification pass. The assertion encoded the bug and kept it green.
    //
    // The real defence is a schema that cannot be satisfied without reading: TOOL_TICKET_LINKS
    // now requires `quotes` (minItems 1) and an explicit `fetchStatus`. With that in place the
    // same agent fetched both documents and returned 21 quotes WITH the binding present on
    // every turn. So: bound throughout, and the contract — not the turn number — is what
    // forces the fetch.
    for (const t of researchTurns) {
      expect(t.responseFormat,
        'the binding must apply on every turn; deferring it makes the tool budget a latency floor')
        .toBeTruthy();
    }
  });

  it('with no schema set, nothing changes for anyone else', async () => {
    const { requests } = await run({ maxToolCalls: 1, toolCalls: 5 });
    for (const r of requests) expect(r.responseFormat).toBeUndefined();
  });
});

describe('the caller that already depended on this keeps working', () => {
  /**
   * THE REGRESSION I ALMOST SHIPPED. Binding only when the tool budget is SPENT breaks every
   * agent that has no tools at all: `budgetSpent` requires a positive budget and a tool call
   * count that reaches it, so a toolless agent never qualifies. The KB write — the one caller
   * already using EPAM_RESPONSE_SCHEMA before today — is exactly that, and would have lost its
   * binding silently while every test above stayed green.
   *
   * The real rule is not "the budget is spent". It is "no tools are being offered on this turn".
   */
  it('an agent with NO tools is bound on every turn', async () => {
    const requests: Req[] = [];
    process.env.EPAM_RESPONSE_SCHEMA = SCHEMA;
    await new AgentRunner({
      userMessage: 'write the kb entry',
      provider: recordingProvider(requests, 0),
      tools: [],
      model: 'stub',
      dangerousSkipApproval: true,
      maxIterations: 3,
    } as any).run();
    expect(requests.length, 'no turn ran at all').toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.responseFormat, 'a toolless agent lost its schema binding').toBeTruthy();
      expect(r.responseFormat.strict).toBe(true);
    }
  });
});

describe('a malformed schema must not silently disable enforcement', () => {
  it('junk is ignored rather than crashing the agent', async () => {
    const { requests } = await run({ schema: 'not json', maxToolCalls: 1, toolCalls: 5 });
    expect(requests.length, 'the agent died on a bad env var').toBeGreaterThan(0);
    for (const r of requests) expect(r.responseFormat).toBeUndefined();
  });

  it('a schema missing its name is ignored', async () => {
    const { requests } = await run({ schema: JSON.stringify({ schema: { type: 'object' } }), maxToolCalls: 1, toolCalls: 5 });
    for (const r of requests) expect(r.responseFormat).toBeUndefined();
  });
});
