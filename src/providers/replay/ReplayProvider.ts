/**
 * REPLAYS A RECORDED RUN INSTEAD OF CALLING A MODEL.
 *
 * Every run-killing bug this month was plumbing — an unbound variable, a function used and never
 * imported, an env var handed the wrong directory. None of them needed a model to find, and all
 * of them cost real tokens to find, because the only way to exercise the pipeline end to end was
 * to point it at paid APIs.
 *
 * Langfuse has been recording every turn of every run all along, named by seam and grouped by
 * session. This provider reads one of those recordings and answers with it, so a full rehearsal
 * of the pipeline costs nothing and returns the same thing twice.
 *
 * WHAT IS REPLAYED AND WHAT IS NOT. Only the assistant turns are replayed. The agent loop runs
 * for real: a recorded `bash` call really runs, a recorded write really writes. That is what
 * keeps the rehearsal faithful — the writer's code lands on disk because the writer's own
 * recorded commands put it there, and every gate downstream judges a real artefact rather than a
 * fixture someone hand-wrote to make the gate pass.
 *
 * DIVERGENCE IS THE FINDING. Turns are replayed in order, per seam. If the pipeline asks for a
 * turn this recording does not have, the code now takes a path the recorded run did not — which
 * is exactly what a rehearsal exists to surface. It is reported by name and the call fails.
 * Answering it with a repeat of the last turn, or with silence, would turn the one informative
 * event into a green run.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { agentLabel } from '../../observability/agentLabel.js';
import type {
  ContentPart, LLMProvider, ProviderRequest, ProviderResponse, StreamHandler,
} from '../types.js';

interface RecordedTurn {
  text?: string;
  toolCalls?: Array<{ name?: string; input?: Record<string, unknown> }>;
}

/**
 * A seam name is a file name here, and seam names carry characters a path must not (`·`, `:`).
 * Encoded rather than stripped — stripping maps two seams onto one file, and the collision would
 * silently give one seam the other's answers. Same rule as the exporter's, and it must stay the
 * same rule: see orchestrations/scripts/lib/cassette-store.js.
 */
function seamFile(seam: string): string {
  const encoded = seam.replace(/[^A-Za-z0-9._-]/g,
    (c) => `~${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

  // A NAME LONGER THAN THE FILESYSTEM ALLOWS. Trace names come from the running pipeline — one
  // real session labelled a seam with an entire tool grant — so the length is not this module's
  // to assume. The kept prefix is paired with a digest of the WHOLE name, because truncating
  // alone would collide two long names onto one file and hand one seam another's answers.
  if (Buffer.byteLength(encoded) <= 200) return encoded;
  const digest = createHash('sha256').update(seam).digest('hex').slice(0, 16);
  return `${encoded.slice(0, 180)}--${digest}`;
}

export class ReplayProvider implements LLMProvider {
  readonly name = 'replay';

  readonly defaultModel = 'replay';

  /** How many turns of each seam have been handed out. The recording's order IS the contract. */
  private cursor = new Map<string, number>();

  private turns = new Map<string, RecordedTurn[]>();

  constructor(private readonly cassetteDir: string) {
    if (!cassetteDir) {
      throw new Error(
        "[replay] no cassette directory. Set EPAM_REPLAY_CASSETTE_DIR to a directory produced by "
        + 'orchestrations/scripts/cassette-export.js. There is no default: replaying an '
        + 'unspecified recording would rehearse a run nobody chose.');
    }
  }

  private recordedTurns(seam: string): RecordedTurn[] {
    const cached = this.turns.get(seam);
    if (cached) return cached;

    let raw: string;
    try {
      raw = readFileSync(join(this.cassetteDir, `${seamFile(seam)}.json`), 'utf8');
    } catch {
      throw new Error(
        `[replay] the recording has no turns for '${seam}'. Either this seam did not run in the `
        + `recorded session, or it is new since. Export a session that exercises it — the `
        + 'cassette is not extended by guessing.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`[replay] '${seam}' turns are not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`[replay] '${seam}' is not a list of turns.`);

    this.turns.set(seam, parsed as RecordedTurn[]);
    return parsed as RecordedTurn[];
  }

  private nextTurn(): RecordedTurn {
    const seam = agentLabel();
    const turns = this.recordedTurns(seam);
    const at = this.cursor.get(seam) ?? 0;

    if (at >= turns.length) {
      throw new Error(
        `[replay] '${seam}' has been called ${at + 1} times and the recorded run called it `
        + `${turns.length} turn(s). The pipeline is taking a path the recording does not have, `
        + 'which is what this rehearsal exists to find. Nothing is invented to cover it.');
    }
    this.cursor.set(seam, at + 1);
    return turns[at] ?? {};
  }

  /**
   * A recorded turn, in the provider's own shape.
   *
   * An empty turn is a legitimate answer — a model returning nothing is how several of this
   * month's failures looked — so it is replayed as an empty end_turn rather than being treated as
   * a missing recording.
   */
  private static toResponse(turn: RecordedTurn): ProviderResponse {
    const content: ContentPart[] = [];
    if (turn.text) content.push({ type: 'text', text: turn.text });

    const calls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
    calls.forEach((c, i) => {
      content.push({
        type: 'tool_use',
        // The recording carries no tool_use id — Langfuse stores name and input. The loop only
        // needs ids to pair results back to calls within this turn, so a positional id is
        // sufficient and is derived, never invented from randomness that would make two replays
        // of the same recording differ.
        id: `replay-${i}`,
        name: String(c.name || ''),
        input: (c.input || {}) as Record<string, unknown>,
      });
    });

    if (!content.length) content.push({ type: 'text', text: '' });

    return {
      content,
      stopReason: calls.length ? 'tool_use' : 'end_turn',
      // NOTHING WAS GENERATED, so nothing is reported as spent. A replay that reported the
      // recorded run's token counts would put spend the rehearsal did not incur into the cost
      // ledger, and the ledger is the one place a false number is indistinguishable from a real
      // one.
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async complete(_request: ProviderRequest): Promise<ProviderResponse> {
    return ReplayProvider.toResponse(this.nextTurn());
  }

  /**
   * Streaming is replayed as one delta per part. There is no timing to reproduce: the recording
   * holds what was said, not how slowly, and a rehearsal that slept for the recorded latency
   * would cost hours to prove what it proves in seconds.
   */
  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const res = await this.complete(request);
    for (const part of res.content) {
      if (part.type === 'text' && part.text) handler({ type: 'text_delta', text: part.text });
      if (part.type === 'tool_use') {
        handler({
          type: 'tool_delta',
          id: part.id || '',
          name: part.name || '',
          input: JSON.stringify(part.input || {}),
        });
      }
    }
    handler({ type: 'message_stop', stopReason: res.stopReason });
    return res;
  }
}

export function createReplayProvider(): ReplayProvider {
  return new ReplayProvider(process.env.EPAM_REPLAY_CASSETTE_DIR || '');
}
