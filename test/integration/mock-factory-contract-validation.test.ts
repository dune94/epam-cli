/**
 * Validates whether contract injection (Option A) also fixes SKY-004's
 * recurring root cause: an incomplete vi.mock() factory for SkyscannerClient
 * — diagnosed live, repeatedly:
 *   "vi.mock factory for SkyscannerClient omits `search` method"
 *   "SkyscannerClient mock returns wrong shape; flights.length access fails
 *    on undefined across handlers"
 *
 * Same design as the SKY-003 validation (contract-sharing-validation.test.ts):
 *   (a) baseline — no contract, just the PRD story text (mirrors the
 *       isolated-worktree condition where the agent can't see the real class)
 *   (b) with contract — the exact CONTRACT SCRATCHPAD content the producing
 *       story would have written (constructor signature, full method list,
 *       exact return shape)
 *
 * If (b) reliably produces a complete, correctly-shaped mock and (a) does
 * not, that confirms contract injection generalizes beyond import paths to
 * mock-factory completeness too — no separate mechanism needed. If (b)
 * still produces an incomplete mock, that means testCriteria.mockStrategy
 * (already-built TC writer output, never yet exercised live due to earlier
 * worktree failures) is the real missing piece for this specific failure
 * class, not contract injection.
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
Story: SKY-004 — Build Express REST API with /health, /search, /cheapest endpoints.
Description: Build src/server.ts exposing an Express app. The /search route calls the
Skyscanner API client (implemented in a separate story, SKY-002) to fetch flight results
and returns them as JSON. Write a test file src/server.test.ts that mocks the Skyscanner
client using vi.mock so the route handler tests run without real network calls.
Acceptance criteria:
- GET /search calls client.search(from, to) and returns { flights: FlightResult[] }
- GET /cheapest returns the single cheapest flight from the same search
- Route handlers read flights[].price and flights[].durationMinutes to sort/filter

Write ONLY the vi.mock() factory block for the Skyscanner client (the mock module
declaration and the mocked return value for a search call) — nothing else.
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
  async search(from: string, to: string): Promise<FlightResult[]>;
}
\`\`\`

Ready-to-paste vi.mock() factory:
\`\`\`typescript
vi.mock('./skyscanner/client', () => ({
  SkyscannerClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([
      { airline: 'Test Air', price: 100, durationMinutes: 120 },
    ]),
  })),
}));
\`\`\`
`;

function callModel(prompt: string): string {
  return execFileSync(
    'bash',
    [AI_RUN, '--provider', 'minimax', '--model', 'MiniMax-M3'],
    { input: prompt, encoding: 'utf8', timeout: 60_000 }
  );
}

describe.skipIf(!hasKey)('SKY-004 mock-factory validation (LIVE, real model)', () => {
  it('BASELINE: without a contract, the model may omit the mocked method or return the wrong shape', () => {
    const output = callModel(STORY_TEXT);
    const hasSearchMethod = /search\s*:/.test(output);
    const hasDurationField = /durationMinutes/.test(output);
    const hasPriceField = /price\s*:/.test(output);
    // eslint-disable-next-line no-console
    console.log(`[baseline] search=${hasSearchMethod} price=${hasPriceField} duration=${hasDurationField}\n${output.slice(0, 400)}`);
    expect(typeof hasSearchMethod).toBe('boolean');
  }, 70_000);

  it('WITH CONTRACT: the model produces a complete mock — search method present, full FlightResult shape', () => {
    const output = callModel(
      `${STORY_TEXT}\n\n${CONTRACT}\n\nUse the exact method name, mock pattern, and field names shown in the contract above. Do not omit any field.`
    );
    expect(output).toMatch(/search\s*:/);
    expect(output).toMatch(/price\s*:/);
    expect(output).toMatch(/durationMinutes\s*:/);
    expect(output).toMatch(/airline\s*:/);
  }, 70_000);
});
