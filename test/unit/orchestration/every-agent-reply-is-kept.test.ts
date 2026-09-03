/**
 * LOGGING IS THE DEFAULT, NOT A FAVOUR THE CALLER REMEMBERS TO DO.
 *
 * metrolinx AMSD-1919 could not be diagnosed because all four capture paths were empty at once:
 * the log excerpts at 2000 chars, the rejection persister needed a logDir nobody passed, the mint
 * has no Langfuse trace, and the agents that ARE traced record in=4ch out=4ch — the string "null".
 *
 * These assert the properties that make the next content-shaped failure diagnosable without paying
 * for a run: it writes without being switched on, it keeps the reply WHOLE, and it never throws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { recordAgentReply, replyLogDir } = require('../../../orchestrations/scripts/lib/agent-reply-log.js');

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replies-'));
  process.env.EPAM_AGENT_REPLY_LOG_DIR = dir;
});
afterEach(() => { process.env = { ...saved }; });

describe('every agent reply is kept', () => {
  it('writes without any opt-in', () => {
    const file = recordAgentReply('PROJECT_AGENTS', '[{"proposedAgents":[]}]');
    expect(file, 'logging must not need switching on').toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps the reply WHOLE — the excerpt cap is what lost the last one', () => {
    const long = 'y'.repeat(3885);
    const file = recordAgentReply('PROJECT_AGENTS', long);
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(3885);
  });

  it('names the file after the seam, so a failure is findable', () => {
    const file = recordAgentReply('PROJECT_AGENTS', 'x');
    expect(path.basename(file)).toMatch(/^project-agents-/);
  });

  it('does not overwrite a reply from the same millisecond', () => {
    // Retries are fast: three attempts of a rejected mint must leave three files, not one.
    const a = recordAgentReply('PROJECT_AGENTS', 'first');
    const b = recordAgentReply('PROJECT_AGENTS', 'second');
    const c = recordAgentReply('PROJECT_AGENTS', 'third');
    expect(new Set([a, b, c]).size).toBe(3);
    expect(fs.readFileSync(a, 'utf8')).toBe('first');
    expect(fs.readFileSync(c, 'utf8')).toBe('third');
  });

  it('defaults to a home neither teardown nor a reboot can delete', () => {
    // NOT OUTPUT_DIR: teardown rm -rf's it and recreates it, so evidence filed there is destroyed
    // by the next run — the one you would compare it against. NOT /tmp: a WSL restart has wiped
    // parked work twice already.
    delete process.env.EPAM_AGENT_REPLY_LOG_DIR;
    process.env.OUTPUT_DIR = dir;
    const home = replyLogDir();
    expect(home).not.toContain(os.tmpdir());
    expect(home.startsWith(dir), 'must not sit under OUTPUT_DIR').toBe(false);
    expect(home).toMatch(/orchestrations[/\\]agent-replies$/);
  });

  it('never throws, and never kills a run, when the directory cannot be written', () => {
    // A REGULAR FILE used as a directory fails fast with ENOTDIR. An unwritable /proc path was the
    // first choice and mkdirSync HANGS on it under this WSL kernel — the test never returned.
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    process.env.EPAM_AGENT_REPLY_LOG_DIR = path.join(blocker, 'inside');
    expect(() => recordAgentReply('PROJECT_AGENTS', 'x')).not.toThrow();
    expect(recordAgentReply('PROJECT_AGENTS', 'x')).toBe('');
  });

  it('keeps nothing when there is genuinely nothing to keep', () => {
    expect(recordAgentReply('PROJECT_AGENTS', '')).toBe('');
  });
});
