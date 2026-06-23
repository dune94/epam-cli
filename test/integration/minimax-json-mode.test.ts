/**
 * Live integration test: MiniMax JSON mode + tool-use structured output
 *
 * Part 1: response_format: json_object — CONFIRMED BROKEN (M3 ignores it)
 * Part 2: tool-use structured output — tests whether M3 reliably calls a
 *   defined tool with valid JSON arguments (API-enforced schema)
 *
 * Original: MiniMax JSON mode (response_format: json_object)
 *
 * Confirms that EPAM_MINIMAX_JSON_MODE=1 causes MiniMax M3 to return
 * syntactically valid JSON — eliminating the unescaped-char / truncation
 * failures that were causing spec-mode-runner parse errors.
 *
 * This test CONSUMES TOKENS. It is skipped automatically when
 * MINIMAX_API_KEY / EPAM_API_KEY_MINIMAX is not set.
 *
 * Run explicitly: npx vitest run test/integration/minimax-json-mode.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MINIMAX_BASE_URL } from '../../src/providers/minimax/MiniMaxProvider.js';

const API_KEY = process.env.MINIMAX_API_KEY ?? process.env.EPAM_API_KEY_MINIMAX ?? '';
const SKIP = !API_KEY;
const MODEL = 'MiniMax-M3';

async function callMiniMax(prompt: string, jsonMode: boolean): Promise<{ raw: string; parsed: unknown | null; valid: boolean }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0.2,
  };
  if (jsonMode) {
    body['response_format'] = { type: 'json_object' };
  }

  const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`MiniMax API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as Record<string, any>;
  const raw: string = data['choices']?.[0]?.message?.content ?? '';

  let parsed: unknown = null;
  let valid = false;
  try {
    parsed = JSON.parse(raw);
    valid = true;
  } catch {
    valid = false;
  }
  return { raw, parsed, valid };
}

const SPEC_PROMPT = `You are a spec-mode agent. Analyze the following story and output a JSON object with these exact fields:
- storyId (string)
- refinedTitle (string)
- acceptanceCriteria (array of strings, 2-3 items)
- verdict (string, one of: pass, warn, fail)

Story: SKY-003b-1-3 — Implement renderTable function in src/table.ts that formats flight search results as a padded ASCII table with columns: Route, Price, Airline, Duration.

Respond with raw JSON only. No markdown, no preamble.`;

describe('MiniMax JSON mode — live API', () => {
  beforeAll(() => {
    if (SKIP) console.warn('Skipping MiniMax live tests — no API key set (MINIMAX_API_KEY or EPAM_API_KEY_MINIMAX)');
  });

  it.skipIf(SKIP)('JSON mode ON: M3 returns syntactically valid JSON', async () => {
    const result = await callMiniMax(SPEC_PROMPT, true);
    console.log('JSON mode ON — raw output:', result.raw.slice(0, 200));
    expect(result.valid).toBe(true);
    expect(result.parsed).toBeTruthy();
    const obj = result.parsed as Record<string, unknown>;
    expect(typeof obj['storyId']).toBe('string');
    expect(Array.isArray(obj['acceptanceCriteria'])).toBe(true);
  }, 30_000);

  it.skipIf(SKIP)('JSON mode OFF: M3 output may contain parse errors (documents the problem)', async () => {
    const result = await callMiniMax(SPEC_PROMPT, false);
    console.log('JSON mode OFF — raw output:', result.raw.slice(0, 200));
    console.log('JSON mode OFF — valid JSON:', result.valid);
    // This test documents but does not assert failure — M3 sometimes produces valid JSON
    // even without json_object mode. The important test is the one above.
    // We log the result so you can see whether json_object mode makes a difference.
    expect(typeof result.raw).toBe('string');
    expect(result.raw.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(SKIP)('JSON mode ON: storyId field is present and matches expected value', async () => {
    const result = await callMiniMax(SPEC_PROMPT, true);
    expect(result.valid).toBe(true);
    const obj = result.parsed as Record<string, unknown>;
    expect(obj['storyId']).toContain('SKY-003b-1-3');
  }, 30_000);

  it.skipIf(SKIP)('JSON mode ON with complex nested schema (simulates speckit output)', async () => {
    const complexPrompt = `Output a JSON object with this schema:
{
  "storyId": "SKY-001-A",
  "splits": [
    { "id": "SKY-001-A-1", "title": "...", "acceptanceCriteria": ["...", "..."], "effort": "low" }
  ],
  "refinements": { "titleUpdated": false, "acCount": 3, "splitRequired": true },
  "verdict": "pass"
}

Analyze story SKY-001-A: Scaffold TypeScript/Express project. It has 8 ACs — split into 2 stories.
Respond with raw JSON only.`;

    const result = await callMiniMax(complexPrompt, true);
    console.log('Complex schema — valid JSON:', result.valid);
    console.log('Complex schema — raw (first 300 chars):', result.raw.slice(0, 300));
    expect(result.valid).toBe(true);
    const obj = result.parsed as Record<string, unknown>;
    expect(obj['storyId']).toBeTruthy();
    expect(Array.isArray(obj['splits'])).toBe(true);
  }, 30_000);
});

// ─── Tool-use structured output ───────────────────────────────────────────────

async function callMiniMaxWithTool(prompt: string): Promise<{
  calledTool: boolean;
  toolName: string | null;
  args: unknown | null;
  argsValid: boolean;
  rawText: string;
}> {
  const tool = {
    type: 'function',
    function: {
      name: 'submit_spec_result',
      description: 'Submit the spec analysis result as structured data.',
      parameters: {
        type: 'object',
        required: ['storyId', 'refinedTitle', 'acceptanceCriteria', 'verdict'],
        properties: {
          storyId: { type: 'string', description: 'The story identifier' },
          refinedTitle: { type: 'string', description: 'Refined story title' },
          acceptanceCriteria: {
            type: 'array',
            items: { type: 'string' },
            description: '2-3 acceptance criteria',
          },
          verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
        },
      },
    },
  };

  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0.2,
    tools: [tool],
    tool_choice: { type: 'function', function: { name: 'submit_spec_result' } },
  };

  const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`MiniMax API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as Record<string, any>;
  const choice = data['choices']?.[0];
  const rawText: string = choice?.message?.content ?? '';
  const toolCalls = choice?.message?.tool_calls ?? [];

  if (toolCalls.length === 0) {
    return { calledTool: false, toolName: null, args: null, argsValid: false, rawText };
  }

  const tc = toolCalls[0];
  const toolName: string = tc?.function?.name ?? null;
  let args: unknown = null;
  let argsValid = false;
  try {
    args = JSON.parse(tc?.function?.arguments ?? '{}');
    argsValid = true;
  } catch {
    argsValid = false;
  }

  return { calledTool: true, toolName, args, argsValid, rawText };
}

const TOOL_PROMPT = `Analyze the following story and call the submit_spec_result tool with your analysis.

Story: SKY-003b-1-3 — Implement renderTable function in src/table.ts that formats flight search results as a padded ASCII table with columns: Route, Price, Airline, Duration.

Call the tool now.`;

describe('MiniMax tool-use structured output — live API', () => {
  beforeAll(() => {
    if (SKIP) console.warn('Skipping MiniMax live tests — no API key set');
  });

  it.skipIf(SKIP)('M3 calls the tool (not just outputs text)', async () => {
    const result = await callMiniMaxWithTool(TOOL_PROMPT);
    console.log('tool_use — calledTool:', result.calledTool);
    console.log('tool_use — toolName:', result.toolName);
    console.log('tool_use — argsValid:', result.argsValid);
    console.log('tool_use — args:', JSON.stringify(result.args)?.slice(0, 300));
    console.log('tool_use — rawText (if any):', result.rawText.slice(0, 200));
    expect(result.calledTool).toBe(true);
  }, 30_000);

  it.skipIf(SKIP)('M3 tool arguments are valid JSON', async () => {
    const result = await callMiniMaxWithTool(TOOL_PROMPT);
    expect(result.calledTool).toBe(true);
    expect(result.argsValid).toBe(true);
  }, 30_000);

  it.skipIf(SKIP)('M3 tool arguments conform to the schema (required fields present)', async () => {
    const result = await callMiniMaxWithTool(TOOL_PROMPT);
    expect(result.calledTool).toBe(true);
    expect(result.argsValid).toBe(true);
    const args = result.args as Record<string, unknown>;
    expect(typeof args['storyId']).toBe('string');
    expect(typeof args['refinedTitle']).toBe('string');
    expect(Array.isArray(args['acceptanceCriteria'])).toBe(true);
    expect(['pass', 'warn', 'fail']).toContain(args['verdict']);
  }, 30_000);

  it.skipIf(SKIP)('M3 tool-use works for complex nested schema (simulates speckit splits)', async () => {
    const complexTool = {
      type: 'function',
      function: {
        name: 'submit_spec_result',
        description: 'Submit spec analysis with optional story splits.',
        parameters: {
          type: 'object',
          required: ['storyId', 'acceptanceCriteria', 'verdict'],
          properties: {
            storyId: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            splits: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'title', 'acceptanceCriteria'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  acceptanceCriteria: { type: 'array', items: { type: 'string' } },
                  effort: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
              },
            },
            verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
          },
        },
      },
    };

    const complexBody = {
      model: MODEL,
      messages: [{
        role: 'user',
        content: `Story SKY-001-A has 8 acceptance criteria — split it into 2 child stories. Call submit_spec_result with storyId="SKY-001-A", 2 splits, and verdict="pass".`,
      }],
      max_tokens: 1024,
      temperature: 0.2,
      tools: [complexTool],
      tool_choice: { type: 'function', function: { name: 'submit_spec_result' } },
    };

    const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify(complexBody),
    });
    const data = await res.json() as Record<string, any>;
    const tc = data['choices']?.[0]?.message?.tool_calls?.[0];
    const argsRaw = tc?.function?.arguments ?? '';
    console.log('complex tool_use — args raw (first 400):', argsRaw.slice(0, 400));

    let args: Record<string, unknown> = {};
    let valid = false;
    try { args = JSON.parse(argsRaw); valid = true; } catch { valid = false; }

    console.log('complex tool_use — valid JSON:', valid);
    console.log('complex tool_use — splits count:', Array.isArray(args['splits']) ? args['splits'].length : 'n/a');
    expect(valid).toBe(true);
    expect(args['storyId']).toBeTruthy();
    expect(Array.isArray(args['splits'])).toBe(true);
  }, 30_000);
});
