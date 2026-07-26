/**
 * A trace list nobody can read is not observability.
 *
 * Live, 2026-07-26, viewing a real run's session in the Langfuse UI: 35 traces,
 * every single row rendering as
 *
 *     Trace: llm-stream (c126ef9e-a61c-4f91-b2ce-c32c2de482aa)
 *     This trace has no input or output.
 *
 * There is no agent name, no story, no prompt, no response — nothing to scan,
 * search or sort by. To find anything you must open traces at random and expand
 * the generation inside, because the prompt IS captured, just one level down and
 * invisible from the list.
 *
 * The cost of that is not theoretical. A detective failure reported in the log
 * only as `timed out after 360000ms` looked like "the cheap model is too slow".
 * The traces showed seven quick, productive tool calls followed by one
 * forced-answer turn that never returned — a completely different defect with a
 * completely different fix. That evidence was sitting in Langfuse the whole
 * time, unreadable from the list view.
 *
 * So the trace itself must carry: who was running, on what story, what it was
 * asked, and what it said.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../src/observability/TracedProvider.ts'), 'utf8');

/** The two trace() call sites (complete + stream) must both be fixed. */
function traceCalls(): string[] {
  const out: string[] = [];
  const re = /langfuse\?\.trace\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) out.push(SRC.slice(m.index, m.index + 700));
  return out;
}

describe('a trace says who ran, on what, and what happened', () => {
  it('names the trace after the agent, not a fixed string', () => {
    // 'llm-stream' on every row is what makes the list unusable.
    for (const call of traceCalls()) {
      expect(call, 'trace name is still a hardcoded literal — every row looks identical')
        .not.toMatch(/name:\s*'llm-(stream|complete)'\s*,/);
    }
    expect(SRC, 'nothing supplies an agent identity for the trace name')
      .toMatch(/EPAM_AGENT_NAME|agentLabel/);
  });

  it('carries the story id, so a run can be read per ticket', () => {
    expect(SRC).toMatch(/EPAM_STORY_ID|storyId/);
  });

  it('puts the prompt on the TRACE, not only on the generation', () => {
    // The generation already had it; the list view reads the trace.
    for (const call of traceCalls()) {
      expect(call, 'the trace still has no input — the list shows "no input or output"')
        .toMatch(/input:/);
    }
  });

  it('records the response on the trace when the call completes', () => {
    expect(SRC, 'trace output is never set, so a finished call still reads as empty')
      .toMatch(/trace\?\.update\(\{[\s\S]{0,200}output:/);
  });

  it('still groups by run — the sessionId fix must not regress', () => {
    expect(SRC).toMatch(/ORCH_RUN_ID/);
    for (const call of traceCalls()) {
      expect(call).toMatch(/sessionId/);
    }
  });

  it('degrades to something useful when no agent name is set', () => {
    // Standalone `epam run` has no orchestration env. A generic name is fine;
    // a name that pretends to be an agent is not.
    expect(SRC).toMatch(/agentLabel[\s\S]{0,320}(\?\?|\|\|)/);
  });
});

describe('the pipeline supplies the identity', () => {
  const SPEC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('spec-mode-runner passes the agent name it already knows', () => {
    // It already tracks costAgent for cost events; the same label should reach
    // the trace, otherwise every spec-pass trace is anonymous.
    expect(SPEC, 'the orchestrator knows which agent it is invoking but never tells Langfuse')
      .toMatch(/EPAM_AGENT_NAME/);
  });
});
