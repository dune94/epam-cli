/**
 * Cycle-time investigation, 2026-07-31 (same finding class as
 * spec-coordinator-review-brownfield.test.ts): storyRequiresSplit() already
 * returns {required:false} for brownfield (spec-mode-runner.js:3197), so the
 * openspec/speckit prompt's `splitWarning` was already correctly suppressed
 * there — but the SPLIT RULES block and the `splitStories` schema field in
 * runSpecAgent's own prompt template were never given the same treatment,
 * even though the EPAM_BROWNFIELD guard in the Step-2 caller (spec-mode-
 * runner.js ~line 1125) unconditionally deletes any splitStories payload
 * from every agent, openspec included ("brownfield stories are tickets and
 * are never split"). Asking the model to reason through 6 split-decision
 * rules and emit an array that gets silently discarded is pure waste.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
  'utf8',
);

function extractRunSpecAgentBody(): string {
  const start = SRC.indexOf('async function runSpecAgent(');
  const end = SRC.indexOf('\n// ─', start);
  expect(start, 'runSpecAgent() not found').toBeGreaterThan(-1);
  expect(end, 'end marker after runSpecAgent() not found').toBeGreaterThan(-1);
  return SRC.slice(start, end);
}

describe('runSpecAgent() prompt — brownfield drops split rules/schema (cycle-time fix)', () => {
  const body = extractRunSpecAgentBody();

  it('branches split-related prompt pieces on EPAM_BROWNFIELD, mirroring storyRequiresSplit', () => {
    expect(body).toMatch(/isBrownfieldSpec\s*=\s*process\.env\.EPAM_BROWNFIELD\s*===\s*'1'/);
  });

  it('omits the splitStories schema field in brownfield', () => {
    const idx = body.indexOf('const splitSchemaField = isBrownfieldSpec');
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 300);
    expect(block).toMatch(/\?\s*''/);
    expect(block).toMatch(/"splitStories":/);
  });

  it('omits the SPLIT RULES block in brownfield', () => {
    const idx = body.indexOf('const splitRulesBlock = isBrownfieldSpec');
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 200);
    expect(block).toMatch(/\?\s*''/);
    expect(body).toMatch(/SPLIT RULES \(mandatory, not optional/);
  });

  it('the generate-instruction line drops "split stories where required" in brownfield', () => {
    const idx = body.indexOf('const generateInstruction = isBrownfieldSpec');
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 500);
    expect(block).not.toMatch(/isBrownfieldSpec[\s\S]{0,80}split stories where required/);
    expect(body).toMatch(/Generate refined acceptance criteria and optionally updated title\/description\./);
    expect(body).toMatch(/Generate refined acceptance criteria, optionally updated title\/description, and split stories where required\./);
  });

  it('strips the dangling trailing comma left by locationHintSchemaLine when splitStories is also dropped', () => {
    expect(body).toMatch(/locationHintSchemaLineTrimmed/);
    expect(body).toMatch(/replace\(\/,\(\\s\*\)\$\/, '\$1'\)/);
  });

  it('the prompt interpolates the trimmed schema line and the (possibly empty) split fields', () => {
    expect(body).toMatch(/\$\{locationHintSchemaLineTrimmed\}\$\{splitSchemaField\}/);
    expect(body).toMatch(/Use existing text when no change is needed\.\$\{splitRulesBlock\}/);
  });

  it('greenfield (EPAM_BROWNFIELD unset) keeps every original split instruction verbatim', () => {
    // Simulate the greenfield branch by checking the literal else-string exists intact.
    expect(body).toMatch(/1\. AC count > 12 → you MUST propose a split\./);
    expect(body).toMatch(/6\. Story covers multiple independent runtime roles/);
    expect(body).toMatch(/"splitStories":\[\{"id":"optional"/);
  });
});
