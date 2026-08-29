/**
 * THE PROMPT HAS TO BE PUT SOMEWHERE THE COST SEAM CAN REACH IT.
 *
 * Traces recorded in=4ch — the string "null" — for every agent, and passing the prompt per-caller
 * cannot fix it: of the emitters, only spec-mode-runner and cpa-inference hold a prompt at all.
 * codeline-discovery, ac-gate and the shell edge never see one. Wiring the single site that did
 * have it moved nothing, which is the evidence that per-caller passing is the wrong shape.
 *
 * So the invoker — the one place that always has the prompt, because it is about to send it —
 * writes it down and names it in the environment. The cost seam reads it there, on both edges,
 * without any caller having to remember.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { recordAgentPrompt, PROMPT_FILE_ENV } = require('../../../orchestrations/scripts/lib/agent-reply-log.js');
const { promptForTrace } = require('../../../orchestrations/scripts/lib/cost-emitter.js');

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  process.env.EPAM_AGENT_REPLY_LOG_DIR = dir;
});
afterEach(() => { process.env = { ...saved }; });

describe('the prompt reaches the trace', () => {
  it('the invoker writes the prompt and names it in the environment', () => {
    const file = recordAgentPrompt('PROJECT_AGENTS', 'Propose the agents this project needs.');
    expect(file, 'the prompt must be written').toBeTruthy();
    expect(process.env[PROMPT_FILE_ENV], 'and named where the cost seam looks').toBe(file);
  });

  it('the cost seam reads it back WHOLE', () => {
    const long = 'p'.repeat(9000);
    recordAgentPrompt('PROJECT_AGENTS', long);
    expect(promptForTrace()).toHaveLength(9000);
  });

  it('an explicitly passed prompt still wins', () => {
    // A caller that already has it should not be second-guessed by a file.
    recordAgentPrompt('PROJECT_AGENTS', 'from the file');
    expect(promptForTrace('from the caller')).toBe('from the caller');
  });

  it('returns empty when no prompt was recorded, rather than inventing one', () => {
    delete process.env[PROMPT_FILE_ENV];
    expect(promptForTrace()).toBe('');
  });

  it('returns empty when the named file is gone', () => {
    const file = recordAgentPrompt('PROJECT_AGENTS', 'x');
    fs.unlinkSync(file);
    expect(promptForTrace()).toBe('');
  });

  it('never throws — observability must not fail the call it observes', () => {
    process.env[PROMPT_FILE_ENV] = path.join(dir, 'no', 'such', 'file');
    expect(() => promptForTrace()).not.toThrow();
  });
});

/**
 * THE HANDOFF THAT ACTUALLY FAILED.
 *
 * The environment was the first channel chosen, and it failed silently: the prompts were written
 * correctly to disk and every trace still read in=4ch, because the emitter runs in a sibling
 * process that never saw the variable. This is the case that reproduces it.
 */
describe('the prompt crosses a process boundary', () => {
  it('is found with no environment variable at all, via the declared tag', () => {
    const { recordAgentPrompt: rec, PROMPT_FILE_ENV: ENV } =
      require('../../../orchestrations/scripts/lib/agent-reply-log.js');
    const { promptForTrace: look } = require('../../../orchestrations/scripts/lib/cost-emitter.js');
    const { declaredContracts } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');

    // Pick a seam that declares a tag, rather than naming one here.
    const entry = Object.entries(declaredContracts() || {})
      .find(([, c]: any) => c && c.tag);
    expect(entry, 'no seam declares a tag; nothing is under test').toBeTruthy();
    const [agent, contract] = entry as [string, any];

    rec(contract.tag, 'the prompt as sent');
    // Exactly what a sibling process sees: the file is on disk, the variable is not set.
    delete process.env[ENV];
    expect(look('', agent)).toBe('the prompt as sent');
  });
});
