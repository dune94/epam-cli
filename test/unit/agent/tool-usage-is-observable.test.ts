/**
 * WHICH TOOL AN AGENT USED, AND WHAT IT COST, MUST BE RECORDABLE.
 *
 * Asked on 2026-08-09 to review agents' use of grep versus the CodeGraph index, I could not
 * answer. Not because the capability is missing — codegraph_query is real, has seven modes, and
 * reaches allow-lists dynamically (verified by executing project_tool_names(), which returns
 * nine plugin tools for the gotransit codeline) — but because nothing records which tool ran.
 *
 * agent-activity.jsonl carries agent, model, phase, provider, story_id, type, detail and
 * timestamp. Not the tool name. So nothing distinguishes an agent that ran one codegraph_query
 * from one that ran forty `search` calls, and per-tool token attribution is impossible.
 *
 * The infrastructure was already there and unconnected:
 *
 *   - AgentActivityLogger DEFINES 'tool_run' and 'tool_result' event types. Neither is ever
 *     emitted anywhere in src/.
 *   - AgentRunner exposes an onToolCall hook. The REPL wires it to the terminal writer; the
 *     `run` command — the one the orchestration writer actually invokes — passes nothing.
 *   - getActivityLogger() has no callers outside its own file.
 *
 * Three unconnected halves of a feature, each looking finished on its own. This is the same
 * shape as the inert gates found earlier the same day: the code exists, reads correctly, and
 * never runs.
 *
 * Cost tracking is the stated first priority and observability the second, so this is the gap
 * that has to close before any token tuning can be more than guesswork — including the obvious
 * experiment of injecting less file content and querying the graph instead.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentActivityLogger } from '../../../src/logging/AgentActivityLogger';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toolobs-'));
  mkdirSync(join(root, 'orchestrations', 'logs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const logPath = () => join(root, 'orchestrations', 'logs', 'agent-activity.jsonl');
const events = () =>
  existsSync(logPath())
    ? readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

describe('the logger can record a tool call at all', () => {
  it('emits tool_run with the tool name', async () => {
    const log = new AgentActivityLogger(root);
    await log.emit('writer', 'tool_run', { tool: 'codegraph_query', mode: 'helpers' });
    const e = events();
    expect(e).toHaveLength(1);
    expect(e[0].type).toBe('tool_run');
    expect(e[0].detail.tool, 'the tool name is what the whole question turns on').toBe('codegraph_query');
  });

  it('emits tool_result with an outcome and a duration', async () => {
    const log = new AgentActivityLogger(root);
    await log.emit('writer', 'tool_result', { tool: 'search', ok: true, ms: 42, bytes: 1200 });
    const d = events()[0].detail;
    expect(d.tool).toBe('search');
    expect(d.ok).toBe(true);
    expect(d.ms).toBe(42);
  });

  it('per-tool totals are derivable from the log — the actual question being asked', async () => {
    const log = new AgentActivityLogger(root);
    for (const t of ['search', 'search', 'search', 'codegraph_query']) {
      await log.emit('writer', 'tool_run', { tool: t });
    }
    const counts = events().reduce<Record<string, number>>((acc, e) => {
      const t = String(e.detail.tool);
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ search: 3, codegraph_query: 1 });
  });
});

describe('THE DEFECT: the run command wires tool events to the log', () => {
  const runSrc = () => readFileSync(join(__dirname, '../../../src/cli/commands/run.ts'), 'utf8');

  it('run.ts passes an onToolCall handler', () => {
    // The REPL wires this to the terminal writer. The `run` command — the one the orchestration
    // writer invokes — passed nothing, so every tool call in every automated run was unrecorded.
    expect(
      runSrc(),
      'the orchestration entry point records no tool usage at all',
    ).toMatch(/onToolCall/);
  });

  it('and an onToolResult handler, so cost and outcome are attributable', () => {
    expect(runSrc()).toMatch(/onToolResult/);
  });

  it('both reach the activity logger rather than only the console', () => {
    const s = runSrc();
    expect(s).toMatch(/getActivityLogger|AgentActivityLogger/);
  });
});

describe('AgentRunner exposes the result hook, not just the call hook', () => {
  const types = () => readFileSync(join(__dirname, '../../../src/agent/types.ts'), 'utf8');
  const runner = () => readFileSync(join(__dirname, '../../../src/agent/AgentRunner.ts'), 'utf8');

  it('onToolResult is part of the options contract', () => {
    expect(types()).toMatch(/onToolResult\??:/);
  });

  it('AgentRunner actually invokes it', () => {
    // A hook declared and never called is the same defect one layer down.
    expect(runner()).toMatch(/onToolResult\?\.\(/);
  });

  it('it reports the tool name, success and duration', () => {
    const s = types();
    const decl = s.slice(s.indexOf('onToolResult'), s.indexOf('onToolResult') + 260);
    expect(decl).toMatch(/toolName/);
    expect(decl).toMatch(/ok|isError/);
    expect(decl).toMatch(/ms|duration/);
  });
});
