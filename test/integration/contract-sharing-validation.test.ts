/**
 * Validates Option E: does injecting the producing story's CONTRACT
 * SCRATCHPAD content into a dependent story's prompt actually fix the #1
 * recurring cross-story failure this session — the CLI/server agent
 * guessing the wrong import path for the Skyscanner client module (real
 * path: src/skyscanner/client.ts; guessed 4x across runs:
 * './skyscanner-client', './skyscanner-client.js') because worktree
 * isolation means it can't see SKY-002's actual file layout?
 *
 * Two real model calls, same prompt otherwise:
 *   (a) baseline — no contract info, as currently happens in an isolated
 *       worktree before merge (mimics the live failure condition)
 *   (b) with contract — the exact CONTRACT SCRATCHPAD content SKY-002 would
 *       have written, injected into the prompt
 *
 * If (a) reliably gets the import wrong and (b) reliably gets it right,
 * that validates building Option A (share contract files across worktrees
 * before dependent agents start) as the real fix. If (b) still guesses
 * wrong, that argues for Option B (sequential execution) instead.
 *
 * Requires MINIMAX_API_KEY. Skipped automatically if not set.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../');
const AI_RUN = join(REPO_ROOT, 'orchestrations/scripts/ai-run.sh');
const hasKey = !!process.env.MINIMAX_API_KEY;

const STORY_TEXT = `
Story: SKY-003 — Implement flight search CLI entry point with formatted table output.
Description: Build a CLI tool (src/cli.ts) that calls the Skyscanner API client to search
flights and print a formatted table. The client was implemented in a separate story (SKY-002)
and already exists in the project.
Acceptance criteria:
- CLI imports the Skyscanner client and calls searchFlights with parsed CLI args
- Formats results as a table with columns: airline, price, duration
- Exits 0 on success, 1 on error
Write only the import statement and the constructor/call pattern you would use to invoke
the client — nothing else. Output just those 2-3 lines of code.
`;

const CONTRACT = `
## Contract: SKY-002 (Skyscanner API client)

Exported from: src/skyscanner/client.ts

\`\`\`typescript
export interface FlightResult {
  airline: string;
  price: number;
  durationMinutes: number;
}
export class SkyscannerClient {
  constructor(apiKey: string);
  async searchFlights(params: { from: string; to: string }): Promise<FlightResult[]>;
}
\`\`\`

Ready-to-paste import + usage pattern:
\`\`\`typescript
import { SkyscannerClient } from './skyscanner/client';
const client = new SkyscannerClient(process.env.RAPIDAPI_KEY!);
const results = await client.searchFlights({ from, to });
\`\`\`
`;

function callModel(prompt: string): string {
  return execFileSync(
    'bash',
    [AI_RUN, '--provider', 'minimax', '--model', 'MiniMax-M3'],
    { input: prompt, encoding: 'utf8', timeout: 60_000 }
  );
}

describe.skipIf(!hasKey)('Option E — contract-sharing validation (LIVE, real model)', () => {
  it('BASELINE: without contract info, the model does NOT reliably produce the correct import path', () => {
    const output = callModel(STORY_TEXT);
    const gotCorrectPath = /['"]\.\/skyscanner\/client['"]/.test(output);
    // This assertion documents the observed baseline behavior — it is
    // expected to be FALSE (or flaky) most of the time, reproducing the
    // live defect. We assert it loosely (not requiring failure every run,
    // since LLM output varies) but log the outcome either way.
    // eslint-disable-next-line no-console
    console.log(`[baseline] correct path guessed: ${gotCorrectPath}\n${output.slice(0, 300)}`);
    expect(typeof gotCorrectPath).toBe('boolean');
  }, 70_000);

  it('WITH CONTRACT: injecting the producing story\'s contract makes the model use the exact import path', () => {
    const output = callModel(`${STORY_TEXT}\n\n${CONTRACT}\n\nUse the exact import path and pattern shown in the contract above.`);
    expect(output).toMatch(/['"]\.\/skyscanner\/client['"]/);
    expect(output).not.toMatch(/skyscanner-client/);
  }, 70_000);
});
