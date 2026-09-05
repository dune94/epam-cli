/**
 * A RECORDING MUST CARRY THE CALL THE MODEL MADE, NOT ONLY WHAT IT SAID.
 *
 * Live 2026-09-04. Langfuse held 113 traces of the paid AMSD-1919 run, and a $0 replay of that run
 * still could not get past the mint. mock-expectations reported eleven of them as:
 *
 *     UNUSABLE — a real capture EXISTS but could not be served
 *       roster-specialiser  (prose — never satisfied its contract)
 *       agent-mint          (ends in prose; this seam is answered by a tool call)
 *       spec-agent          (ends in prose; this seam is answered by a tool call)
 *
 * The recording holds the sentence the model wrote. roster-specialiser DELIVERS by writing
 * roster.json, so serving its sentence leaves no file behind and the contract refuses it — three
 * attempts, then "could not produce an accepted roster", then the mint fails. That is the single
 * thing standing between this project and an end-to-end rehearsal that costs nothing.
 *
 * mock-expectations has ALWAYS been ready to consume the calls — it reads `metadata.toolCalls` for
 * the count and `output.toolCalls` for the calls themselves, and says why in its own comment:
 * "A seam that DELIVERS by tool call cannot be replayed from its text". The reader has been
 * waiting for a writer. Nothing wrote them.
 *
 * WHY THEY WERE MISSING, and it is not that the data does not exist: the runner is invoked with
 * `--print --output-format json`, whose result is `{type:'result', result:'<text>', usage:{…}}`.
 * The tool calls happen INSIDE the runner and never appear there. They ARE recorded, in the
 * runner's own session transcript — measured on the killed run's own directory, 28 tool_use blocks
 * across 7 of 16 transcripts, including the StructuredOutput calls by which seams return structured
 * answers.
 *
 * This file covers the two READ-ONLY halves — reading the transcript, and shaping what is emitted.
 * Correlating an invocation to its transcript by --session-id touches the paid invocation path and
 * is deliberately a separate change.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const READER = join(__dirname, '../../../orchestrations/scripts/lib/transcript-tool-calls.js');
const EMIT = join(__dirname, '../../../orchestrations/scripts/lib/langfuse-emit.js');

/** A transcript in the exact shape the runner writes: one JSON object per line. */
function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'));
  const f = join(dir, 'session.jsonl');
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

const assistantWith = (content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } });

describe('reading the calls out of a runner transcript', () => {
  it('the reader exists', () => {
    expect(() => require(READER), 'lib/transcript-tool-calls.js does not exist').not.toThrow();
  });

  const { toolCallsInTranscript } = require(READER);

  it('extracts a tool_use block with its name and input', () => {
    const f = transcript([
      assistantWith([{ type: 'text', text: 'I will write the roster.' }]),
      assistantWith([{ type: 'tool_use', id: 't1', name: 'Bash',
        input: { command: 'cat > roster.json <<EOF\n{"agents":{}}\nEOF' } }]),
    ]);
    const calls = toolCallsInTranscript(f);
    expect(calls.length, 'the call the model made was not recovered').toBe(1);
    expect(calls[0].name).toBe('Bash');
    expect(calls[0].input.command, 'the call was recorded without what it actually did')
      .toMatch(/roster\.json/);
  });

  it('recovers StructuredOutput — how a seam returns a structured answer', () => {
    const f = transcript([
      assistantWith([{ type: 'tool_use', id: 't2', name: 'StructuredOutput',
        input: { verdict: 'approved', findings: [] } }]),
    ]);
    const calls = toolCallsInTranscript(f);
    expect(calls.map((c: any) => c.name)).toContain('StructuredOutput');
    expect(calls[0].input.verdict).toBe('approved');
  });

  it('keeps every call, in order — a seam may make several', () => {
    const f = transcript([
      assistantWith([{ type: 'tool_use', id: 'a', name: 'Read', input: { path: 'x' } }]),
      assistantWith([{ type: 'text', text: 'thinking' }]),
      assistantWith([{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }]),
    ]);
    expect(toolCallsInTranscript(f).map((c: any) => c.name)).toEqual(['Read', 'Bash']);
  });

  it('a transcript with no calls yields none — never a fabricated one', () => {
    const f = transcript([assistantWith([{ type: 'text', text: 'just prose' }])]);
    expect(toolCallsInTranscript(f)).toEqual([]);
  });

  it('a missing or unreadable transcript yields none and never throws', () => {
    // Observability must never fail the call it observes.
    expect(() => toolCallsInTranscript('/no/such/file.jsonl')).not.toThrow();
    expect(toolCallsInTranscript('/no/such/file.jsonl')).toEqual([]);
  });

  it('a half-written line is skipped, not fatal — the file is appended to live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-partial-'));
    const f = join(dir, 's.jsonl');
    writeFileSync(f, JSON.stringify(assistantWith([{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]))
      + '\n{"type":"assist');
    try {
      expect(toolCallsInTranscript(f).length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('what gets emitted to Langfuse', () => {
  const { buildIngestionBody } = require(EMIT);

  const calls = [{ name: 'Bash', input: { command: 'cat > roster.json' } }];

  /** Every observation in the ingestion body, whatever the envelope shape. */
  const observations = (body: any) =>
    (body.batch || []).map((e: any) => e.body).filter(Boolean);

  it('the calls travel in the output, where mock-expectations reads them', () => {
    const body = buildIngestionBody(
      { agent: 'roster-specialiser', model: 'm', provider: 'p', output: 'I wrote it.', toolCalls: calls },
      { traceId: 't', obsId: 'o' });
    const withOutput = observations(body).filter((o: any) => o.output);
    expect(withOutput.length, 'nothing carried an output at all').toBeGreaterThan(0);

    const carries = withOutput.some((o: any) => {
      const out = typeof o.output === 'string' ? (() => { try { return JSON.parse(o.output); } catch { return null; } })() : o.output;
      return out && Array.isArray(out.toolCalls) && out.toolCalls.length === 1;
    });
    expect(carries, [
      'the trace records what the model SAID and not the call it MADE. roster-specialiser delivers',
      'by writing roster.json, so replaying its sentence leaves no file behind — which is exactly',
      'why an $0 rehearsal cannot get past the mint.',
    ].join('\n')).toBe(true);
  });

  it('the reply text survives alongside them — the reader still needs it', () => {
    const body = buildIngestionBody(
      { agent: 'a', model: 'm', provider: 'p', output: 'I wrote it.', toolCalls: calls },
      { traceId: 't', obsId: 'o' });
    const texts = observations(body).map((o: any) => {
      const out = typeof o.output === 'string' ? (() => { try { return JSON.parse(o.output); } catch { return o.output; } })() : o.output;
      return out && (typeof out === 'string' ? out : out.text);
    }).filter(Boolean);
    expect(texts.join(' '), 'the reply text was lost when the calls were added').toContain('I wrote it.');
  });

  it('the COUNT is on the metadata, which is what the reader ranks candidates by', () => {
    const body = buildIngestionBody(
      { agent: 'a', model: 'm', provider: 'p', output: 'x', toolCalls: calls },
      { traceId: 't', obsId: 'o' });
    const counted = observations(body).some(
      (o: any) => Number((o.metadata || {}).toolCalls || 0) === 1);
    expect(counted, 'metadata.toolCalls is what mock-expectations reads to prefer a real capture')
      .toBe(true);
  });

  it('WITHOUT calls, nothing changes — a text-only seam emits exactly as before', () => {
    // The whole existing corpus is text-only. This must not reshape it.
    const body = buildIngestionBody(
      { agent: 'a', model: 'm', provider: 'p', output: 'just prose' },
      { traceId: 't', obsId: 'o' });
    const outs = observations(body).map((o: any) => o.output).filter(Boolean);
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) {
      expect(typeof o, 'a text-only reply was wrapped in an object, changing every existing trace')
        .toBe('string');
      expect(o).toBe('just prose');
    }
  });

  it('an empty call list is treated as no calls, not as an empty wrapper', () => {
    const body = buildIngestionBody(
      { agent: 'a', model: 'm', provider: 'p', output: 'prose', toolCalls: [] },
      { traceId: 't', obsId: 'o' });
    for (const o of observations(body).filter((x: any) => x.output)) {
      expect(typeof o.output).toBe('string');
    }
  });
});
