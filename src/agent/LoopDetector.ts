import { createHash } from 'node:crypto';
import { renderAgentMessage } from '../tools/messages.js';

export interface LoopDetectorConfig {
  /** Block a tool call once it's been seen this many times (exact same tool + args) within the sliding window. */
  maxIdenticalToolCalls: number;
  /** Nudge the model once an error fingerprint has repeated this many times within the sliding window. */
  maxIdenticalErrorOutcomes: number;
  /** How many recent calls/errors to consider "recent" for repeat detection. */
  slidingWindowSize: number;
  /**
   * Block a tool call once it has targeted the SAME thing this many times within the window,
   * regardless of whether the payload differed.
   *
   * Distinct from maxIdenticalToolCalls, which hashes {tool + args} and therefore cannot see a
   * rewrite loop: live 2026-08-10 one attempt wrote the same file 32 times, each with slightly
   * different content, so all 32 hashed differently and every one passed. The attempt ran to
   * 11.7M input tokens (up from 7.1M) because each rewrite added a turn and every turn re-sends
   * the whole history.
   *
   * Deliberately more permissive than the identical-args threshold: editing one file two or
   * three times is ordinary work, and only persistent re-targeting is a loop.
   */
  maxSameTargetCalls: number;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  maxIdenticalToolCalls: 2,
  maxIdenticalErrorOutcomes: 2,
  slidingWindowSize: 6,
  // Generous next to the identical-args rule, and far below the 32 observed live. The window for
  // this rule is the whole attempt rather than the sliding window: a rewrite loop interleaved
  // with reads would otherwise fall out of a 6-call window and never be counted.
  maxSameTargetCalls: 8,
};

/**
 * The thing a call acts ON, when it names one.
 *
 * Tools spell the argument differently, so a rule that knows one spelling silently covers one
 * tool. Nothing here names a tool, an extension or a directory — a plugin tool that mutates a
 * path is covered the day it is added. A call with no path-like argument has no target and is
 * left entirely to the identical-args rule.
 */
function callTarget(toolArgs: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'file', 'filename', 'target']) {
    const v = toolArgs?.[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function hashPayload(data: unknown): string {
  return createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 12);
}

/**
 * Per-attempt tool-call loop / repeating-error detector.
 *
 * One AgentRunner instance = one story attempt (a fresh `epam run` invocation
 * constructs a new one each time), so holding this as a private instance
 * field gives natural per-attempt isolation with no explicit reset call
 * needed — unlike claude.sh's EPAM_REASONING_EFFORT, which needs an explicit
 * reset because that whole pipeline is one long bash process spanning many
 * stories, not one process per story.
 *
 * Ported from a proposed Python sketch, with two fixes applied before use:
 *
 *  1. Error fingerprinting normalizes away digit runs (line numbers, byte
 *     offsets, addresses) so "error at line 42" and "error at line 43" for
 *     the SAME underlying fault hash identically. The original only
 *     filtered down to error-related LINES; it never normalized WITHIN
 *     them, so the same recurring error at a shifting line number would
 *     have silently evaded detection.
 *
 *  2. Failure detection uses the tool result's own `isError` flag (already
 *     computed by the tool from a real exit code or thrown exception), not
 *     a substring scan for words like "error"/"failed" in the tool's raw
 *     output. A grep whose output legitimately contains the word "error"
 *     (searching a codebase for error-handling code, for instance) would
 *     otherwise trip a false positive on every single call — the same class
 *     of bag-of-words false positive this project has already been burned
 *     by once (checkFixSiteCoverage's coverage heuristic).
 */
export class LoopDetector {
  private callHistory: string[] = [];
  private errorHistory: string[] = [];
  /** Per-attempt count of calls per {tool + target}, for the same-target rule. */
  private targetCounts = new Map<string, number>();

  constructor(private config: LoopDetectorConfig = DEFAULT_CONFIG) {}

  /**
   * Call BEFORE executing a tool. If blocked, do not execute the tool —
   * surface interventionMessage to the model as the tool's result instead.
   */
  preToolCheck(toolName: string, toolArgs: Record<string, unknown>): { blocked: boolean; interventionMessage?: string } {
    const signature = `${toolName}:${hashPayload(toolArgs)}`;
    const recentWindow = this.callHistory.slice(-this.config.slidingWindowSize);
    const duplicateCount = recentWindow.filter(s => s === signature).length;

    // SAME TARGET, DIFFERENT PAYLOAD, FOREVER. Checked before the identical-args rule because a
    // rewrite loop never trips that one — every payload differs. Counted across the whole attempt
    // rather than the sliding window, since a loop interleaved with reads would otherwise keep
    // falling out of the window.
    const target = callTarget(toolArgs);
    if (target !== null) {
      const targetKey = `${toolName}@${target}`;
      const seen = this.targetCounts.get(targetKey) ?? 0;
      if (seen >= this.config.maxSameTargetCalls) {
        return {
          blocked: true,
          interventionMessage: renderAgentMessage('same_target_repeat',
            { tool: toolName, target, count: seen + 1 }),
        };
      }
      this.targetCounts.set(targetKey, seen + 1);
    }

    if (duplicateCount >= this.config.maxIdenticalToolCalls) {
      return {
        blocked: true,
        interventionMessage: renderAgentMessage('identical_call_repeat',
          { tool: toolName, count: duplicateCount + 1 }),
      };
    }

    this.callHistory.push(signature);
    return { blocked: false };
  }

  /**
   * Call AFTER executing a tool, with its real result. Returns feedback to
   * APPEND to the tool result (not replace it) when the error is a repeat —
   * the model still needs the real output, just with an added nudge.
   */
  postToolCheck(result: { content: string; isError: boolean }): { repeating: boolean; feedbackMessage?: string } {
    if (!result.isError) return { repeating: false };

    const fingerprint = this.errorFingerprint(result.content);
    this.errorHistory.push(fingerprint);
    const recentErrors = this.errorHistory.slice(-this.config.slidingWindowSize);
    const repeatCount = recentErrors.filter(e => e === fingerprint).length;

    if (repeatCount >= this.config.maxIdenticalErrorOutcomes) {
      return {
        repeating: true,
        feedbackMessage: `\n\n${renderAgentMessage('repeated_error_outcome', { count: repeatCount + 1 })}`,
      };
    }
    return { repeating: false };
  }

  private errorFingerprint(content: string): string {
    const errorLines = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => /error|exception|failed|conflict|@@/i.test(l))
      // Normalize away digit runs so the same underlying error at a
      // different line/offset/address still fingerprints identically.
      .map(l => l.replace(/\d+/g, '#'));
    return hashPayload(errorLines.length > 0 ? errorLines : content.slice(0, 500));
  }
}
