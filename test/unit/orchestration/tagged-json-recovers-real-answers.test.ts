/**
 * A RUN LOST TO PUNCTUATION.
 *
 * Live 2026-08-06, metrolinx, all three lanes. The ticket-link agent and the
 * guard-vocabulary agent both did their work and both had their answers discarded, because
 * neither answered in the exact `<TAG>{…}</TAG>` shape the parser required. The log:
 *
 *   Failed to parse JSON for tag TICKET_LINKS:     Unexpected token 'B', "Both docum"...
 *   Failed to parse JSON for tag GUARD_VOCABULARY: Unexpected token '<', "<tool_call"...
 *   Failed to parse JSON for tag GUARD_VOCABULARY: Unexpected token 's', "submit_gua"...
 *   openspec run failed: VC guard could not be armed — refusing to proceed
 *   speckit review failed: AC guard could not be armed — refusing to proceed
 *   [ERROR] Step 1: Specification pass FAILED for 'core' — all agent invocations failed.
 *
 * The guards abort when unarmed, which is correct. But nothing was wrong with the models'
 * reasoning — the link agent's own prompt log shows it received both real vendor URLs and
 * the whole twelve-comment thread. What failed was shape recovery.
 *
 * `unwrapToolCallJson` already matched tool calls by SHAPE rather than by tag name, which
 * was the right instinct, and it still missed all three: it requires a BALANCED
 * `<tag>…</tag>`, and none of these had one.
 *
 * These are the three real shapes, kept verbatim.
 */
import { describe, it, expect } from 'vitest';

const { extractTaggedJson } = require('../../../orchestrations/scripts/spec-mode-runner.js');

describe('the shapes that actually cost a run', () => {
  it('a bare tool NAME followed by the payload', () => {
    const out = extractTaggedJson(
      'submit_guard_vocabulary\n{"blacklist":[{"term":"please","reason":"courtesy"}],"whitelist":[]}',
      'GUARD_VOCABULARY');
    expect(out, 'the guard reported "no usable terms" and aborted the spec pass').toBeTruthy();
    expect(out.blacklist[0].term).toBe('please');
  });

  it('an UNCLOSED tool-call tag — the answer was truncated, not absent', () => {
    const out = extractTaggedJson(
      '<tool_call>{"name":"submit_ticket_links","arguments":{"links":[{"url":"https://v.test/d","classification":"vendor_documentation","relevant":true}]}}',
      'TICKET_LINKS');
    expect(out).toBeTruthy();
    expect(out.links[0].url).toBe('https://v.test/d');
  });

  it('prose first, payload after — the model explained itself before answering', () => {
    const out = extractTaggedJson(
      'Both documents describe the same integration. Here is the structured answer:\n' +
      '{"links":[{"url":"https://v.test/a","classification":"vendor_documentation","relevant":true,"quotes":["takes no argument"]}]}',
      'TICKET_LINKS');
    expect(out).toBeTruthy();
    expect(out.links[0].quotes[0]).toBe('takes no argument');
  });
});

describe('recovery cannot invent an answer', () => {
  it('pure prose with no payload still yields null', () => {
    expect(extractTaggedJson('Both links are vendor documentation and both are relevant.', 'TICKET_LINKS')).toBeNull();
  });

  it('an empty answer is still no answer', () => {
    expect(extractTaggedJson('', 'TICKET_LINKS')).toBeNull();
    expect(extractTaggedJson('   \n  ', 'TICKET_LINKS')).toBeNull();
  });

  it('a brace inside a quoted string does not truncate the object', () => {
    // Naive brace counting ends at the `}` inside the reason and produces malformed JSON.
    const out = extractTaggedJson(
      'here:\n{"blacklist":[{"term":"set","reason":"as in {} — an empty set"}],"whitelist":[]}',
      'GUARD_VOCABULARY');
    expect(out, 'brace counting must respect string state').toBeTruthy();
    expect(out.blacklist[0].reason).toContain('{}');
  });

  it('an escaped quote inside a string does not end it', () => {
    const out = extractTaggedJson(
      '{"blacklist":[{"term":"quote","reason":"the \\" character"}],"whitelist":[]}',
      'GUARD_VOCABULARY');
    expect(out).toBeTruthy();
    expect(out.blacklist[0].reason).toContain('"');
  });
});

describe('the shapes that already worked keep working', () => {
  it('the plain tagged block', () => {
    const out = extractTaggedJson('<TICKET_LINKS>{"links":[{"url":"https://a.test"}]}</TICKET_LINKS>', 'TICKET_LINKS');
    expect(out.links[0].url).toBe('https://a.test');
  });

  it('a fenced tagged block', () => {
    const out = extractTaggedJson('<TICKET_LINKS>\n```json\n{"links":[]}\n```\n</TICKET_LINKS>', 'TICKET_LINKS');
    expect(out).toEqual({ links: [] });
  });

  it('the LAST block wins when the prompt template is echoed first', () => {
    const out = extractTaggedJson(
      '<TICKET_LINKS></TICKET_LINKS>\nreal answer:\n<TICKET_LINKS>{"links":[{"url":"https://b.test"}]}</TICKET_LINKS>',
      'TICKET_LINKS');
    expect(out.links[0].url).toBe('https://b.test');
  });

  it('a balanced tool-call wrapper still unwraps', () => {
    const out = extractTaggedJson(
      '<arguments>{"links":[{"url":"https://c.test"}]}</arguments>', 'TICKET_LINKS');
    expect(out.links[0].url).toBe('https://c.test');
  });

  it('bare JSON with no tag at all', () => {
    expect(extractTaggedJson('{"links":[]}', 'TICKET_LINKS')).toEqual({ links: [] });
  });
});
