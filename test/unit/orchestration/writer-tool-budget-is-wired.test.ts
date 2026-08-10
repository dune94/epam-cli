/**
 * THE WRITER'S TOOL BUDGET IS SET, AND I REPORTED IT AS UNLIMITED.
 *
 * Asked to state every setting precisely before a run, I said the writer's tool-call budget was
 * unlimited. It was 300. The schema said:
 *
 *     "null = unlimited (current behavior — this cap is not set anywhere today)"
 *
 * and I stopped there instead of reading the project config, where
 * costControls.maxToolCallsPerStory: 300 was live and wired — claude.sh:248 exports it as
 * EPAM_STORY_MAX_TOOL_CALLS, which reaches the writer as EPAM_MAX_TOOL_CALLS.
 *
 * It matters because the killed run recorded 318 tool_run events and an earlier run used 202
 * read_file calls alone, so the writer was reaching that cap mid-attempt on a 12-file brownfield
 * story — a second, independent reason its attempts ended without finishing, alongside the guard
 * feedback that never arrived.
 *
 * Raised to 600. The budget bounds TOOL CALLS, not spend: storyBudgetHardLimitUsd ($15.00) is
 * the actual cost stop and is unchanged, so this cannot run away.
 *
 * The test asserts the WIRING, not the number — a value in a config file that never reaches the
 * invocation is the defect this whole day has been about.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SETTINGS = join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json');
const CLAUDE_SH = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');

describe('the budget is configured', () => {
  const cfg = () => JSON.parse(readFileSync(SETTINGS, 'utf8'));

  it('is a real number, not null', () => {
    expect(typeof cfg().costControls.maxToolCallsPerStory).toBe('number');
  });

  it('clears what the story actually needs', () => {
    // 318 tool_run events in one killed attempt; 202 read_file calls in another. A budget below
    // the observed usage is a cap that stops work rather than one that bounds waste.
    expect(cfg().costControls.maxToolCallsPerStory).toBeGreaterThanOrEqual(400);
  });

  it('the money stop is untouched — this bounds calls, not spend', () => {
    expect(cfg().costControls.storyBudgetHardLimitUsd).toBe(15.0);
  });
});

describe('and it reaches the writer', () => {
  it('claude.sh exports it from the project config', () => {
    expect(CLAUDE_SH).toMatch(/costControls\.maxToolCallsPerStory/);
    expect(CLAUDE_SH).toMatch(/EPAM_STORY_MAX_TOOL_CALLS/);
  });

  it('the writer invocation passes it as EPAM_MAX_TOOL_CALLS', () => {
    expect(CLAUDE_SH).toMatch(/EPAM_MAX_TOOL_CALLS="\$\{EPAM_STORY_MAX_TOOL_CALLS:-\}"/);
  });

  it('the loader really resolves the configured value — executed, not read', () => {
    const out = execFileSync('bash', ['-c',
      `jq -r '.costControls.maxToolCallsPerStory // empty' ${JSON.stringify(SETTINGS)}`,
    ], { encoding: 'utf8' }).trim();
    expect(Number(out)).toBe(JSON.parse(readFileSync(SETTINGS, 'utf8')).costControls.maxToolCallsPerStory);
    expect(Number(out)).toBeGreaterThan(0);
  });
});

describe('the schema no longer misstates reality', () => {
  it('does not claim the cap is unset anywhere', () => {
    // That sentence is what I read and repeated. It was true when written and false since.
    const schema = readFileSync(join(ROOT, 'orchestrations/config/llm-settings.schema.json'), 'utf8');
    expect(schema).not.toMatch(/this cap is not set anywhere today/);
  });
});
