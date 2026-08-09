// ── Agent Activity Logger — unified JSONL event emitter ─────────────────────
// Writes to orchestrations/logs/agent-activity.jsonl
// All agent types (QA, implementation, spec, coordination) emit events here.

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ── Event types ─────────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'story_start'
  | 'story_complete'
  | 'story_fail'
  | 'tool_run'         // external tool invocation (knip, jscpd, semgrep, etc.)
  | 'tool_result'      // tool output summary
  | 'finding'          // issue/pattern discovered
  | 'gate_decision'    // QA gate pass/fail/review
  | 'cost_snapshot'    // token/cost data point
  | 'message_sent'     // inter-agent message
  | 'message_received'
  | 'spec_update'      // acceptance criteria change
  | 'spec_pass_decision' // spec-mode-runner.js writes this directly
  | 'phase_start'
  | 'phase_complete'
  | 'error'
  | 'info';

export type FindingSeverity = 'blocker' | 'error' | 'warning' | 'info' | 'suggestion';

export interface ActivityEvent {
  event_id: string;
  timestamp: string;
  agent: string;
  story_id: string | null;
  phase: string | null;
  type: ActivityEventType;
  detail: Record<string, unknown>;
}

// ── Logger class ────────────────────────────────────────────────────────────

export class AgentActivityLogger {
  private logPath: string;

  constructor(projectRoot: string) {
    // THE ENGINE'S LOG DIRECTORY, WHEN THE ENGINE SAYS WHERE IT IS.
    //
    // projectRoot is the repository the agent is working IN, which for an orchestration writer
    // is the CLIENT codeline. Live 2026-08-09 that put 125 activity events inside
    // next.gotransit.com/orchestrations/logs/ — never committed (engine_paths_filter excludes
    // it) but an engine artefact in a client checkout, and invisible where anyone would look.
    //
    // The orchestration knows its own LOG_DIR and passes it; a direct `epam run` sets nothing
    // and keeps the original project-root behaviour.
    const explicit = process.env.EPAM_ACTIVITY_LOG_DIR;
    this.logPath = explicit
      ? join(explicit, 'agent-activity.jsonl')
      : join(projectRoot, 'orchestrations', 'logs', 'agent-activity.jsonl');
  }

  /**
   * Emit a single activity event.
   */
  async emit(
    agent: string,
    type: ActivityEventType,
    detail: Record<string, unknown> = {},
    opts: { storyId?: string; phase?: string } = {},
  ): Promise<ActivityEvent> {
    const event: ActivityEvent = {
      event_id: `evt-${Date.now()}-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      agent,
      story_id: opts.storyId ?? null,
      phase: opts.phase ?? null,
      type,
      detail,
    };

    await fs.mkdir(join(this.logPath, '..'), { recursive: true });
    await fs.appendFile(this.logPath, JSON.stringify(event) + '\n', 'utf-8');
    return event;
  }

  // ── Convenience methods ─────────────────────────────────────────────────

  async storyStart(agent: string, storyId: string, phase: string, title?: string) {
    return this.emit(agent, 'story_start', { title }, { storyId, phase });
  }

  async storyComplete(agent: string, storyId: string, phase: string, summary?: string) {
    return this.emit(agent, 'story_complete', { summary }, { storyId, phase });
  }

  async storyFail(agent: string, storyId: string, phase: string, error: string) {
    return this.emit(agent, 'story_fail', { error }, { storyId, phase });
  }

  async toolRun(agent: string, tool: string, args: string[], opts?: { storyId?: string; phase?: string }) {
    return this.emit(agent, 'tool_run', { tool, args }, opts);
  }

  async toolResult(agent: string, tool: string, exitCode: number, summary: string, opts?: { storyId?: string; phase?: string }) {
    return this.emit(agent, 'tool_result', { tool, exitCode, summary }, opts);
  }

  async finding(
    agent: string,
    severity: FindingSeverity,
    message: string,
    opts?: { storyId?: string; phase?: string; file?: string; line?: number; rule?: string },
  ) {
    return this.emit(
      agent,
      'finding',
      { severity, message, file: opts?.file, line: opts?.line, rule: opts?.rule },
      opts,
    );
  }

  async gateDecision(agent: string, phase: string, decision: 'pass' | 'fail' | 'review', issues: unknown[]) {
    return this.emit(agent, 'gate_decision', { decision, issueCount: issues.length, issues }, { phase });
  }

  async costSnapshot(agent: string, storyId: string, phase: string, cost: { tokensIn: number; tokensOut: number; costUsd: number }) {
    return this.emit(agent, 'cost_snapshot', cost, { storyId, phase });
  }

  async info(agent: string, message: string, opts?: { storyId?: string; phase?: string }) {
    return this.emit(agent, 'info', { message }, opts);
  }

  async error(agent: string, message: string, opts?: { storyId?: string; phase?: string }) {
    return this.emit(agent, 'error', { message }, opts);
  }
}

// ── Singleton factory ───────────────────────────────────────────────────────

let _instance: AgentActivityLogger | null = null;

export function getActivityLogger(projectRoot: string): AgentActivityLogger {
  if (!_instance) {
    _instance = new AgentActivityLogger(projectRoot);
  }
  return _instance;
}
