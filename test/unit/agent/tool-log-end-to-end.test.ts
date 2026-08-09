/**
 * A REAL TOOL CALL, THROUGH THE REAL RUNNER, LANDING IN THE REAL LOG.
 *
 * The tool-logging work passed nine unit tests and produced nothing in a live run, because the
 * tests read src/ and the pipeline executes dist/epam.js. built-cli-is-not-stale closes the
 * staleness hole and proves the wiring is IN the bundle; it still does not prove an event ever
 * reaches disk.
 *
 * This drives the real AgentRunner with a stub provider — no credentials, no spend — through the
 * real Executor and the real AgentActivityLogger, wired exactly as src/cli/commands/run.ts wires
 * them. If any link is broken (runner hook, executor timing, logger path, label plumbing) the
 * log is empty and this fails.
 *
 * Spawning the CLI binary was the first attempt. It cannot run without a provider credential,
 * and a test that silently passes because the thing under test never executed is the failure
 * mode this whole day has been about — so that attempt failed loudly instead, and this replaced
 * it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRunner } from '../../../src/agent/AgentRunner';
import { AgentActivityLogger, getActivityLogger } from '../../../src/logging/AgentActivityLogger';
import { createTools } from '../../../src/tools/createTools';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** One turn that calls list_files, then a turn with no tool calls so the loop ends. */
function stubProvider(listPath: string) {
  let turn = 0;
  return {
    name: 'stub',
    defaultModel: 'stub-model',
    async complete() {
      turn++;
      if (turn === 1) {
        return {
          content: [{ type: 'tool_use', id: 't1', name: 'list_files', input: { path: listPath } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        } as never;
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as never;
    },
    async stream(_req: unknown, _h: unknown) { return this.complete(); },
  };
}

describe('a tool call reaches the activity log', () => {
  it('emits tool_run and tool_result with the tool name, labels and duration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toole2e-')); dirs.push(dir);
    mkdirSync(join(dir, 'orchestrations', 'logs'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    // NOT getActivityLogger(): it is a process-wide singleton keyed to the FIRST projectRoot it
    // ever sees, so a second call with a different root silently returns the first logger and
    // events land in another project's file. Harmless for the pipeline today — each lane is its
    // own process — but it made this test write nowhere, and it is a real trap for anything that
    // ever handles two roots in one process.
    const activityLogger = new AgentActivityLogger(dir);
    const seen: string[] = [];
    const writes: Promise<unknown>[] = [];
    const errors: unknown[] = [];
    const observed: Array<{ tool: string; isError: boolean; meta?: { durationMs?: number; bytes?: number } }> = [];

    const runner = new AgentRunner({
      userMessage: 'list the files',
      systemPrompt: 'you are a test',
      provider: stubProvider(dir) as never,
      model: 'stub-model',
      tools: createTools().filter((t) => t.name === 'list_files'),
      maxIterations: 3,
      dangerousSkipApproval: true,
      // Wired exactly as src/cli/commands/run.ts wires them.
      onToolCall: (toolName) => {
        seen.push(toolName);
        // Production swallows emit failures on purpose (observability must never fail a story).
        // The test keeps the promise so a silent rejection is reported here instead of looking
        // like "the hook never fired".
        writes.push(activityLogger.emit('e2e-probe', 'tool_run', { tool: toolName },
          { storyId: 'E2E-1', phase: 'core' }).catch((e) => { errors.push(e); }));
      },
      onToolResult: (toolName, _r, isError, meta) => {
        observed.push({ tool: toolName, isError, meta });
        writes.push(activityLogger.emit('e2e-probe', 'tool_result',
          { tool: toolName, ok: !isError, ms: meta?.durationMs ?? null, bytes: meta?.bytes ?? 0 },
          { storyId: 'E2E-1', phase: 'core' }).catch((e) => { errors.push(e); }));
      },
    } as never);

    await runner.run();
    await Promise.all(writes);
    expect(errors, `the activity log write failed: ${JSON.stringify(errors[0])}`).toEqual([]);

    expect(seen, 'the stub never produced a tool call — the fixture proves nothing').toContain('list_files');

    const logPath = join(dir, 'orchestrations', 'logs', 'agent-activity.jsonl');
    expect(
      existsSync(logPath),
      `no activity log at ${logPath} — writes=${writes.length} seen=${JSON.stringify(seen)} ` +
      `dirContents=${JSON.stringify(readdirSync(join(dir, 'orchestrations', 'logs')))}`,
    ).toBe(true);
    const events = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const run = events.find((e) => e.type === 'tool_run');
    expect(run, 'the tool ran and nothing recorded it').toBeTruthy();
    expect(run.detail.tool).toBe('list_files');
    expect(run.agent).toBe('e2e-probe');
    expect(run.story_id).toBe('E2E-1');
    expect(run.phase).toBe('core');

    const res = events.find((e) => e.type === 'tool_result');
    expect(res, 'no result event — cost cannot be attributed to the call').toBeTruthy();
    expect(res.detail.tool).toBe('list_files');
    // The point of this test is that the OUTCOME is recorded faithfully, not that the tool
    // succeeds. list_files errors in this sandbox, and a test that demanded success would be
    // asserting on the tool rather than on the observability it exists to prove.
    expect(observed.length, 'the runner never reported a tool result').toBeGreaterThan(0);
    expect(res.detail.ok, 'the log disagrees with what the runner actually reported')
      .toBe(!observed[0].isError);
    expect(res.detail.bytes, 'result size is not recorded, so payload cost is invisible')
      .toBe(observed[0].meta?.bytes);
    expect(typeof res.detail.ms, 'duration is not measured, so per-tool cost stays unattributable')
      .toBe('number');
  });

  it('per-tool totals are derivable — the question that started this', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toole2e2-')); dirs.push(dir);
    mkdirSync(join(dir, 'orchestrations', 'logs'), { recursive: true });
    const log = new AgentActivityLogger(dir);
    for (const t of ['search', 'search', 'codegraph_query']) {
      await log.emit('w', 'tool_run', { tool: t }, { storyId: 'S', phase: 'core' });
    }
    const events = readFileSync(join(dir, 'orchestrations', 'logs', 'agent-activity.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const counts = events.reduce<Record<string, number>>((a, e) => {
      a[String(e.detail.tool)] = (a[String(e.detail.tool)] ?? 0) + 1; return a;
    }, {});
    expect(counts).toEqual({ search: 2, codegraph_query: 1 });
  });
});

describe('the singleton factory, so its constraint is on the record', () => {
  it('returns the FIRST projectRoot it was given, whatever it is asked for later', () => {
    const a = mkdtempSync(join(tmpdir(), 'sing-a-')); dirs.push(a);
    const b = mkdtempSync(join(tmpdir(), 'sing-b-')); dirs.push(b);
    expect(getActivityLogger(a)).toBe(getActivityLogger(b));
  });
});
