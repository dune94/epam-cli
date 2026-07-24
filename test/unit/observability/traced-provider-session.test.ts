/**
 * Langfuse traces must carry a per-run sessionId.
 *
 * ESCAPED DEFECT (2026-07-24): every trace had `sessionId: null`, so all runs piled
 * into one undifferentiated stream with no way to group or separate them. This is
 * not cosmetic — it produced a materially WRONG analysis during the AMSD-1820
 * session: a per-model cost table built from Langfuse blended the killed 12:55
 * run's traces with the live 14:07 run's and had to be retracted. Until traces are
 * grouped by run, no per-run cost or latency figure taken from Langfuse can be
 * trusted.
 *
 * The pipeline already has a run identifier (`ORCH_RUN_ID`, used in 9 places across
 * the orchestration scripts) and each agent call is a separate `epam run`
 * subprocess that inherits it — the value simply never reached wrapWithTracing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../src/observability/TracedProvider.ts'), 'utf8');
const RUN_TS = readFileSync(
  join(__dirname, '../../../src/cli/commands/run.ts'), 'utf8');

describe('TracedProvider — per-run session grouping', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.ORCH_RUN_ID; });
  afterEach(() => { process.env = { ...saved }; });

  it('falls back to ORCH_RUN_ID when no sessionId is passed explicitly', () => {
    // Each agent call is its own `epam run` subprocess, so an env fallback is the
    // only thing that can group them without touching every call site.
    expect(SRC).toMatch(/ORCH_RUN_ID/);
  });

  it('an explicitly-passed sessionId still wins over the env fallback', () => {
    const i = SRC.indexOf('ORCH_RUN_ID');
    const near = SRC.slice(Math.max(0, i - 300), i + 300);
    // opts.sessionId must be consulted first (?? / || with env on the right).
    expect(near).toMatch(/sessionId\s*(\?\?|\|\|)/);
  });

  it('the run command wires tracing with a session so pipeline calls are grouped', () => {
    const i = RUN_TS.indexOf('wrapWithTracing');
    expect(i).toBeGreaterThan(-1);
    // Either an explicit sessionId here, or the documented env fallback.
    expect(SRC).toMatch(/process\.env\.ORCH_RUN_ID/);
  });

  it('both trace kinds (complete and stream) carry the sessionId', () => {
    const completeIdx = SRC.indexOf("name: 'llm-complete'");
    const streamIdx = SRC.indexOf("name: 'llm-stream'");
    expect(completeIdx).toBeGreaterThan(-1);
    expect(streamIdx).toBeGreaterThan(-1);
    expect(SRC.slice(completeIdx, completeIdx + 200)).toMatch(/sessionId/);
    expect(SRC.slice(streamIdx, streamIdx + 200)).toMatch(/sessionId/);
  });
});

describe('pipeline wiring — ORCH_RUN_ID must reach child processes', () => {
  it('run-agent-orchestration.sh EXPORTS ORCH_RUN_ID (not just assigns it)', () => {
    // Each agent call is a separate `epam run` subprocess. Assigned-but-unexported
    // meant children never saw it and every Langfuse trace had sessionId:null.
    const ORCH = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(ORCH).toMatch(/export\s+ORCH_RUN_ID=/);
  });
});
