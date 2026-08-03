/**
 * A model that "answers" by emitting a tool CALL must not cost us the payload.
 *
 * unwrapToolCallJson already recovers three argument containers — <arguments> (glm),
 * <input>, <parameters> — but not a `<tool_call>…</tool_call>` wrapper itself. Live in
 * mock3 (2026-08-03, lane mock-a):
 *
 *     Failed to parse JSON for tag MODEL_REVIEW: Unexpected token '<', "<tool_call"…
 *     [WARNING] [pre-phase-assessment] the agent's decision could not be applied
 *
 * The decision was discarded and the run continued reporting success — a silent
 * degradation, which the standing rule forbids: a mechanism may not no-op quietly.
 * This shape is not new either; the code's own comment records speckit emitting
 * `<tool_call>read_file(...)` on a previous incident, and the retry ladder learned
 * nothing because re-asking reproduces the same wrong shape.
 *
 * Recovering the payload is strictly better than a retry: the answer is already there.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractTaggedJson } = require('../../../orchestrations/scripts/spec-mode-runner.js');

/**
 * THE CLASS, NOT THE INSTANCE. The first version of this fix enumerated `<tool_call>`.
 * A live metrolinx run then failed within minutes on `<function_calls>` — the third
 * wrapper name seen in the wild after `<arguments>` and `<tool_call>`. Enumerating names
 * loses to whatever the next provider emits.
 *
 * So the rule is shape-based: ANY balanced <tag>…</tag> is treated as a candidate scope,
 * and a candidate is only accepted if its body actually parses as JSON. A wrong guess
 * costs nothing; a missing name costs a discarded decision. These cases deliberately
 * include wrapper names nobody has reported yet.
 */
describe('ANY tool-invocation wrapper is unwrapped — shape, not a name list', () => {
  const payload = '{"name":"submit","arguments":{"verdict":"approved"}}';

  it.each([
    ['function_calls', 'the live metrolinx failure, 2026-08-03'],
    ['tool_call', 'the live mock3 failure'],
    ['function_call', 'singular variant'],
    ['invoke', 'another provider spelling'],
    ['tool_use', 'not yet observed — must work anyway'],
  ])('unwraps <%s> (%s)', (tagName) => {
    const out = extractTaggedJson(`<${tagName}>${payload}</${tagName}>`, 'MODEL_REVIEW');
    expect(
      out,
      `a <${tagName}> wrapper discarded the payload — the fix must key on SHAPE, not a name list`,
    ).not.toBeNull();
    expect(out.verdict).toBe('approved');
  });

  it('unwraps a wrapper carrying attributes', () => {
    const out = extractTaggedJson(`<function_calls id="1">${payload}</function_calls>`, 'X');
    expect(out?.verdict).toBe('approved');
  });

  it('unwraps a NESTED wrapper (outer must not hide the inner payload)', () => {
    const out = extractTaggedJson(
      `<function_calls><invoke><arguments>{"verdict":"approved"}</arguments></invoke></function_calls>`, 'X');
    expect(out?.verdict).toBe('approved');
  });
});

describe('tool-call wrapper is unwrapped, not lost', () => {
  it('REPRODUCES the live failure: a <tool_call> wrapper around {name, arguments}', () => {
    const text = `<tool_call>
{"name": "submit_review", "arguments": {"verdict": "approved", "qualityScore": 0.9}}
</tool_call>`;
    const out = extractTaggedJson(text, 'MODEL_REVIEW');
    expect(out, 'the payload was inside the wrapper and must be recovered').not.toBeNull();
    expect(out.verdict).toBe('approved');
    expect(out.qualityScore).toBe(0.9);
  });

  it('recovers a write_file-style call whose real payload is a JSON string in content', () => {
    const inner = JSON.stringify({ verdict: 'changes_requested', issues: [] });
    const text = `<tool_call>{"name":"write_file","arguments":{"path":"/tmp/r.json","content":${JSON.stringify(inner)}}}</tool_call>`;
    const out = extractTaggedJson(text, 'MODEL_REVIEW');
    expect(out).not.toBeNull();
    expect(out.verdict).toBe('changes_requested');
  });

  it('handles a tool_call wrapper carrying an <arguments> container', () => {
    const text = `<tool_call><arguments>{"verdict":"approved"}</arguments></tool_call>`;
    expect(extractTaggedJson(text, 'MODEL_REVIEW')?.verdict).toBe('approved');
  });

  it('still prefers a properly tagged block when one is present — no behaviour change', () => {
    const text = `<tool_call>{"name":"noise","arguments":{"verdict":"WRONG"}}</tool_call>
<MODEL_REVIEW>{"verdict":"approved"}</MODEL_REVIEW>`;
    expect(extractTaggedJson(text, 'MODEL_REVIEW').verdict).toBe('approved');
  });

  it('still returns null for genuinely unrecoverable prose — never invents a payload', () => {
    expect(extractTaggedJson('It seems the task is unclear, could you clarify?', 'MODEL_REVIEW')).toBeNull();
  });

  it('existing containers keep working (regression guard)', () => {
    expect(extractTaggedJson('<arguments>{"verdict":"approved"}</arguments>', 'X')?.verdict).toBe('approved');
    expect(extractTaggedJson('<input>{"verdict":"approved"}</input>', 'X')?.verdict).toBe('approved');
    expect(extractTaggedJson('<parameters>{"verdict":"approved"}</parameters>', 'X')?.verdict).toBe('approved');
  });
});
