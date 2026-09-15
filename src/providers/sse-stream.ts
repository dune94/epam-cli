/**
 * THE WIRE CUTS WHERE IT LIKES; AN EVENT IS WHOLE OR IT IS NOT AN EVENT.
 *
 * A streamed reply reaches us in reads that end wherever the socket ends them — inside an SSE
 * event as often as not, and inside a multi-byte character now and then. Both OpenAI-shaped
 * providers split each read on '\n' and JSON.parsed each `data:` line by itself, with nothing
 * carried to the next read: both halves of a cut event failed to parse and were skipped, a slice
 * of a tool call's arguments was lost, and the final JSON.parse of the arguments failed into
 * `{}` — an empty tool call, handed to the tool as if the model had asked for nothing.
 *
 * Run 20260915T101555Z, REGI-001A, MiniMax-M3: 32 write_file calls arrived empty that way
 * ("The paths[0] argument must be of type string. Received undefined"), six attempts, $4.18,
 * nothing delivered. Small calls fit in one read and survived, which is why it looked like the
 * model "could not write config.py" and not like a parser.
 *
 * This reader carries the unfinished tail of every read into the next, decodes with
 * `stream: true` so a character split across reads is not two replacement characters, and hands
 * back only complete `data:` payloads. Arguments that still do not parse are refused out loud
 * (see toolInput) rather than emptied in silence.
 */

export class SseDataReader {
  private readonly decoder = new TextDecoder();
  private tail = '';

  /** The complete `data:` payloads this read completed. `[DONE]` is passed through. */
  push(bytes: Uint8Array): string[] {
    this.tail += this.decoder.decode(bytes, { stream: true });
    const lines = this.tail.split('\n');
    this.tail = lines.pop() ?? '';
    return SseDataReader.payloads(lines);
  }

  /** Whatever a stream that ended without a final newline still held. */
  flush(): string[] {
    this.tail += this.decoder.decode();
    const lines = this.tail ? this.tail.split('\n') : [];
    this.tail = '';
    return SseDataReader.payloads(lines);
  }

  private static payloads(lines: string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
      const l = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (l.startsWith('data:')) out.push(l.substring(5).trim());
    }
    return out;
  }
}

/** The key a tool_use part carries when its arguments did not parse — read by the agent loop. */
export const TOOL_INPUT_ERROR = '__toolInputError';

/**
 * A tool call's arguments as the tool must receive them: parsed, or refused with the reason and
 * the text that failed, so the runner can answer the model with a failed tool result instead of
 * running the tool on nothing.
 */
export function toolInput(name: string, args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { [TOOL_INPUT_ERROR]: `arguments for ${name} parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object` };
  } catch (e) {
    return {
      [TOOL_INPUT_ERROR]: `arguments for ${name} are not valid JSON (${args.length} chars): ${(e as Error).message}`,
    };
  }
}
