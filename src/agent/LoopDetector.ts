import { createHash } from 'node:crypto';

export interface LoopDetectorConfig {
  /** Block a tool call once it's been seen this many times (exact same tool + args) within the sliding window. */
  maxIdenticalToolCalls: number;
  /** Nudge the model once an error fingerprint has repeated this many times within the sliding window. */
  maxIdenticalErrorOutcomes: number;
  /** How many recent calls/errors to consider "recent" for repeat detection. */
  slidingWindowSize: number;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  maxIdenticalToolCalls: 2,
  maxIdenticalErrorOutcomes: 2,
  slidingWindowSize: 6,
};

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

  constructor(private config: LoopDetectorConfig = DEFAULT_CONFIG) {}

  /**
   * Call BEFORE executing a tool. If blocked, do not execute the tool —
   * surface interventionMessage to the model as the tool's result instead.
   */
  preToolCheck(toolName: string, toolArgs: Record<string, unknown>): { blocked: boolean; interventionMessage?: string } {
    const signature = `${toolName}:${hashPayload(toolArgs)}`;
    const recentWindow = this.callHistory.slice(-this.config.slidingWindowSize);
    const duplicateCount = recentWindow.filter(s => s === signature).length;

    if (duplicateCount >= this.config.maxIdenticalToolCalls) {
      return {
        blocked: true,
        interventionMessage:
          `LOOP PROTECTION: "${toolName}" was just called with identical parameters ` +
          `${duplicateCount + 1} times in a row. This is not making progress — the call was NOT ` +
          `executed. Do not repeat this exact call again. Re-read the prior output or error, form ` +
          `a different hypothesis, or inspect a different file. If genuinely stuck, say so and stop.`,
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
        feedbackMessage:
          `\n\n[LOOP PROTECTION: this failed the same way as a previous attempt in this conversation. ` +
          `Stop repeating this modification strategy — pivot to a different file/approach, or revert ` +
          `the recent change.]`,
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
