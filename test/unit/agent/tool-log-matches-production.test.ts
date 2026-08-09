/**
 * THREE DEFECTS THE FIRST TOOL-LOGGING TESTS COULD NOT SEE.
 *
 * The logging shipped, ran live, and produced data that was in the wrong place, mis-counted, and
 * mis-attributed. Every one of my tests passed throughout, because each fixture was more
 * convenient than production in exactly the way that hid the defect:
 *
 *   1. WRONG DESTINATION. The logger is constructed from config.projectRoot, which for the
 *      writer is the CLIENT CODELINE. 125 events were written into
 *      next.gotransit.com/orchestrations/logs/. Not committed — engine_paths_filter excludes it
 *      — but it is an engine artefact inside a client checkout, and the data is invisible where
 *      anyone would look for it. My test passed a temp dir and asserted the file appeared in it;
 *      it never asked WHICH root production would pass.
 *
 *   2. MIS-COUNTED. AgentRunner.onToolCall joins a whole batch into one string, so live data
 *      contains "bash, bash" and "bash, read_file, bash" as if they were tool names. Per-tool
 *      counts are wrong whenever the model batches. My fixture only ever produced ONE tool call
 *      per turn, so the batch case never existed in a test.
 *
 *   3. MIS-ATTRIBUTED. Every event was agent "epam-run", the fallback. The orchestration exports
 *      EPAM_AGENT_ROLE; I read EPAM_AGENT_NAME, a variable I invented. My test set
 *      EPAM_AGENT_NAME itself, so it proved the code reads the variable the test set — nothing
 *      more.
 *
 * The pattern is the same each time: a fixture that answers the question the code asks instead of
 * the question production asks.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentActivityLogger } from '../../../src/logging/AgentActivityLogger';
import { AgentRunner } from '../../../src/agent/AgentRunner';
import { createTools } from '../../../src/tools/createTools';
import { resolveAgentLabel, toolLabel } from '../../../src/cli/commands/run';

const ROOT = join(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// ── 1. destination ───────────────────────────────────────────────────────────
describe('DEFECT 1: the log goes to the engine, not the client codeline', () => {
  it('an explicit activity-log directory wins over the project root', () => {
    const client = tmp('client-');
    const engine = tmp('engine-');
    const logDir = join(engine, 'orchestrations', 'logs');
    mkdirSync(logDir, { recursive: true });

    const before = process.env.EPAM_ACTIVITY_LOG_DIR;
    process.env.EPAM_ACTIVITY_LOG_DIR = logDir;
    try {
      const log = new AgentActivityLogger(client);
      return log.emit('a', 'tool_run', { tool: 't' }).then(() => {
        expect(
          existsSync(join(logDir, 'agent-activity.jsonl')),
          'the engine log directory was ignored',
        ).toBe(true);
        expect(
          existsSync(join(client, 'orchestrations', 'logs', 'agent-activity.jsonl')),
          'an engine artefact was written into the client codeline',
        ).toBe(false);
      });
    } finally {
      if (before === undefined) delete process.env.EPAM_ACTIVITY_LOG_DIR;
      else process.env.EPAM_ACTIVITY_LOG_DIR = before;
    }
  });

  it('without the override it still falls back to the project root', async () => {
    const before = process.env.EPAM_ACTIVITY_LOG_DIR;
    delete process.env.EPAM_ACTIVITY_LOG_DIR;
    try {
      const d = tmp('fallback-');
      await new AgentActivityLogger(d).emit('a', 'tool_run', { tool: 't' });
      expect(existsSync(join(d, 'orchestrations', 'logs', 'agent-activity.jsonl'))).toBe(true);
    } finally {
      if (before !== undefined) process.env.EPAM_ACTIVITY_LOG_DIR = before;
    }
  });

  it('the writer invocation passes the engine log directory', () => {
    // The orchestration knows LOG_DIR; the CLI cannot guess it.
    const sh = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(sh, 'claude.sh never tells the CLI where the engine log lives').toMatch(/EPAM_ACTIVITY_LOG_DIR=/);
  });
});

// ── 2. one event per tool ────────────────────────────────────────────────────
describe('DEFECT 2: a batch of tool calls is not one tool named "bash, bash"', () => {
  /** A provider that asks for THREE tools in a single turn — the live shape. */
  function batchProvider() {
    let turn = 0;
    return {
      name: 'stub', defaultModel: 'm',
      async complete() {
        turn++;
        if (turn === 1) {
          return {
            content: [
              { type: 'tool_use', id: 'a', name: 'list_files', input: { path: '.' } },
              { type: 'tool_use', id: 'b', name: 'list_files', input: { path: 'src' } },
              { type: 'tool_use', id: 'c', name: 'read_file', input: { path: 'src/a.ts' } },
            ],
            stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 },
          } as never;
        }
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn',
                 usage: { inputTokens: 1, outputTokens: 1 } } as never;
      },
      async stream() { return this.complete(); },
    };
  }

  it('onToolCall fires once per tool, with a bare tool name', async () => {
    const d = tmp('batch-');
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
    const seen: string[] = [];
    const runner = new AgentRunner({
      userMessage: 'go', systemPrompt: 's', provider: batchProvider() as never, model: 'm',
      tools: createTools().filter((t) => ['list_files', 'read_file'].includes(t.name)),
      maxIterations: 3, dangerousSkipApproval: true,
      onToolCall: (name) => { seen.push(name); },
    } as never);
    await runner.run();

    expect(seen.length, 'the batch collapsed into a single call').toBe(3);
    expect(
      seen.some((n) => n.includes(',')),
      'a comma-joined name reached the log — "bash, bash" is not a tool',
    ).toBe(false);
    expect(seen.filter((n) => n === 'list_files')).toHaveLength(2);
    expect(seen).toContain('read_file');
  });

  it('so per-tool counts are correct when the model batches', async () => {
    const d = tmp('counts-');
    mkdirSync(join(d, 'orchestrations', 'logs'), { recursive: true });
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
    const log = new AgentActivityLogger(d);
    const writes: Promise<unknown>[] = [];
    const runner = new AgentRunner({
      userMessage: 'go', systemPrompt: 's', provider: batchProvider() as never, model: 'm',
      tools: createTools().filter((t) => ['list_files', 'read_file'].includes(t.name)),
      maxIterations: 3, dangerousSkipApproval: true,
      onToolCall: (name) => { writes.push(log.emit('w', 'tool_run', { tool: name })); },
    } as never);
    await runner.run();
    await Promise.all(writes);

    const events = readFileSync(join(d, 'orchestrations', 'logs', 'agent-activity.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const counts = events.reduce<Record<string, number>>((a, e) => {
      a[String(e.detail.tool)] = (a[String(e.detail.tool)] ?? 0) + 1; return a;
    }, {});
    expect(counts).toEqual({ list_files: 2, read_file: 1 });
  });
});

// ── 3. attribution ───────────────────────────────────────────────────────────
describe('DEFECT 3: events are attributed to the agent the orchestration named', () => {
  const runSrc = () => readFileSync(join(ROOT, 'src/cli/commands/run.ts'), 'utf8');

  it('EPAM_AGENT_ROLE is used — the variable the orchestration actually exports', () => {
    // CALLED, not grepped. The first version asserted run.ts mentioned EPAM_AGENT_ROLE, and a
    // mutation deleting the variable still passed because the comment above it said the name.
    // That is the third time today a comment satisfied a source-text assertion.
    expect(
      resolveAgentLabel({ EPAM_AGENT_ROLE: 'test-engineer' } as NodeJS.ProcessEnv),
      'the CLI reads a variable nothing sets, so every event is attributed to the fallback',
    ).toBe('test-engineer');
  });

  it('an explicit EPAM_AGENT_NAME still wins', () => {
    expect(resolveAgentLabel({
      EPAM_AGENT_NAME: 'explicit', EPAM_AGENT_ROLE: 'role',
    } as NodeJS.ProcessEnv)).toBe('explicit');
  });

  it('claude.sh really does export it at the writer invocation', () => {
    const sh = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(sh).toMatch(/EPAM_AGENT_ROLE="\$\{_story_agent_role\}"/);
  });

  it('the generic fallback remains for a direct epam run', () => {
    expect(resolveAgentLabel({} as NodeJS.ProcessEnv)).toBe('epam-run');
  });
});

/**
 * DEFECT 4: a tool call with no name was logged as no name at all.
 *
 * Live 2026-08-09, 1 event of 193:
 *
 *     {"type":"tool_run","detail":{"tool":"","args":{"path":".../src/services/contentstack.ts"}}}
 *     {"type":"tool_result","detail":{"tool":"","ok":false,"ms":0,"bytes":17}}
 *
 * The provider emitted a tool_use block with real arguments and no name; the executor answered
 * "Tool '' not found" (17 bytes). A genuine event worth recording — but recorded as an empty
 * string it aggregates into nothing, silently under-counting whichever call it was and leaving a
 * hole in exactly the cost attribution this logging exists to provide.
 *
 * Small — 1 in 193 — and the reason to fix it is that every number in the token investigation
 * comes from this data. A measurement that quietly drops rows is worse than one that is missing.
 */
describe('DEFECT 4: an unnamed tool call is labelled, not blank', () => {
  it('a missing name becomes an explicit label', () => {
    expect(toolLabel(undefined)).toBe('(unnamed)');
    expect(toolLabel('')).toBe('(unnamed)');
  });

  it('a real name is untouched', () => {
    expect(toolLabel('read_file')).toBe('read_file');
  });

  it('whitespace is not a name', () => {
    expect(toolLabel('   ')).toBe('(unnamed)');
  });
});
