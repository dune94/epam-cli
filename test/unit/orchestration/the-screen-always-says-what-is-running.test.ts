/**
 * THE OPERATOR MUST BE ABLE TO SEE WHAT THE PIPELINE IS DOING, AT EVERY STAGE.
 *
 * Live 2026-09-04, pipeline-tests-19. The dashboard showed:
 *
 *     AMSD-1919   running — no update in 10m
 *
 * while the run was perfectly healthy: the pipeline log had advanced 14 seconds earlier, a model
 * call was in flight, and 12 prompts had been generated. The operator asked the only question the
 * dashboard exists to answer — "is it stuck?" — and the dashboard could not answer it.
 *
 * agent-status.json held TEN events for the whole run, all of them `preflight` or `self_heal`.
 * Nothing from the mint, the roster specialiser, or prompt-builder — the longest and most
 * expensive stages of the run, ~45 minutes of it, entirely invisible.
 *
 * WHY: monitor events are emitted from HAND-PLACED CALL SITES — a handful of
 * `update-monitor.sh event ...` lines in claude.sh and run-agent-orchestration.sh. A stage nobody
 * remembered to add a line to is silent, and silence is indistinguishable from a hang.
 *
 * THE FIX IS THE ONE THAT ALREADY FIXED TRACING: ride the COST SEAM. Every model call, on every
 * arm, already reaches lib/cost-emitter.js with its agent, phase, story, model and timing
 * resolved — that is why phase-cost.jsonl has a record for every call while agent-status.json has
 * ten. Emitting from there covers every stage without naming one, and a stage added tomorrow is
 * visible tomorrow rather than whenever someone remembers this file.
 *
 * NOTHING IS HARDCODED: the event is built from the fields the seam already carries. No stage
 * list, no agent list, no per-stage call site.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** Drive the REAL cost seam the way the pipeline drives it, and read what the monitor was told. */
function emitThrough(fields: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-seam-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });

  // A stub update-monitor.sh that records its argv. The real one is a jq pipeline over a JSON
  // file; what matters here is whether the seam CALLS it, and with what.
  const log = join(dir, 'monitor-calls.log');
  writeFileSync(join(bin, 'update-monitor.sh'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  execFileSync('chmod', ['+x', join(bin, 'update-monitor.sh')]);

  const result = join(dir, 'result.json');
  writeFileSync(result, JSON.stringify({
    total_cost_usd: 0.01, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    result: 'the reply text',
  }));

  execFileSync(process.execPath, ['-e', `
    const { emitCostSnapshot } = require(${JSON.stringify(join(REPO, 'orchestrations/scripts/lib/cost-emitter.js'))});
    emitCostSnapshot({
      resultFile: ${JSON.stringify(result)},
      activityFile: ${JSON.stringify(join(dir, 'activity.jsonl'))},
      ledgerFile: ${JSON.stringify(join(dir, 'ledger.jsonl'))},
      logDir: ${JSON.stringify(dir)},
      startedAt: new Date(Date.now() - 4000).toISOString(),
      ...${JSON.stringify(fields)},
    });
  `], {
    cwd: dir, timeout: 30_000,
    env: {
      ...process.env,
      // The seam must find the monitor script the same way the pipeline does.
      EPAM_MONITOR_SCRIPT: join(bin, 'update-monitor.sh'),
      PATH: `${bin}:${process.env.PATH}`,
      MONITOR_FILE: join(dir, 'agent-status.json'),
      LOG_DIR: dir,
    },
  });

  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe('every model call tells the screen what is running', () => {
  it('the cost seam emits a monitor event — the stage no longer has to remember to', () => {
    const calls = emitThrough({
      agent: 'prompt-builder', storyId: null, phase: 'core',
      model: 'claude-sonnet-5', provider: 'claude', turns: 1,
    });
    expect(calls.length,
      'a model call completed and the dashboard was told nothing — this is "no update in 10m" on a healthy run')
      .toBeGreaterThan(0);
  });

  it('the event names the AGENT, so the screen can say what is running rather than that something is', () => {
    const calls = emitThrough({
      agent: 'roster-specialiser', storyId: null, phase: 'core',
      model: 'claude-opus-4-8', provider: 'claude', turns: 1,
    });
    expect(calls.join(' '),
      'the operator is told a call happened but not which stage — the same as not being told')
      .toContain('roster-specialiser');
  });

  it('and the MODEL, because an unexpected rung is the thing an operator most needs to see', () => {
    // roster-specialiser silently escalating to opus-4-8 cost $3.63 in one call. That should be
    // visible while it happens, not discoverable afterwards in the cost ledger.
    const calls = emitThrough({
      agent: 'roster-specialiser', storyId: null, phase: 'core',
      model: 'claude-opus-4-8', provider: 'claude', turns: 1,
    });
    expect(calls.join(' ')).toContain('claude-opus-4-8');
  });

  it('a stage with no story still reports — the mint has no story and is 45 minutes of the run', () => {
    const calls = emitThrough({
      agent: 'agent-mint', storyId: null, phase: null,
      model: 'claude-sonnet-5', provider: 'claude', turns: 1,
    });
    expect(calls.length,
      'the stages without a story id are exactly the ones that went dark')
      .toBeGreaterThan(0);
  });

  it('a monitor that fails NEVER breaks the call it reports on', () => {
    // Same contract as the Langfuse emit beside it: observability is not allowed to fail a run.
    const dir = mkdtempSync(join(tmpdir(), 'monitor-seam-fail-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const result = join(dir, 'result.json');
    writeFileSync(result, JSON.stringify({ total_cost_usd: 0.01, num_turns: 1, usage: {}, result: 'x' }));
    expect(() => execFileSync(process.execPath, ['-e', `
      const { emitCostSnapshot } = require(${JSON.stringify(join(REPO, 'orchestrations/scripts/lib/cost-emitter.js'))});
      const r = emitCostSnapshot({
        resultFile: ${JSON.stringify(result)},
        activityFile: ${JSON.stringify(join(dir, 'activity.jsonl'))},
        ledgerFile: ${JSON.stringify(join(dir, 'ledger.jsonl'))},
        logDir: ${JSON.stringify(dir)},
        agent: 'x', model: 'm', provider: 'p', turns: 1,
        startedAt: new Date().toISOString(),
      });
      if (!r) { process.stderr.write('the cost record was lost'); process.exit(3); }
    `], {
      cwd: dir, timeout: 30_000,
      // Points at a script that does not exist: the emit must swallow it.
      env: { ...process.env, EPAM_MONITOR_SCRIPT: join(dir, 'no-such-update-monitor.sh') },
    })).not.toThrow();
  });
});
