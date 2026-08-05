/**
 * PIPELINE FILES CANNOT LEAVE THE PERIMETER.
 *
 * The engine writes its own state — KB, profiles, logs, indexes, telemetry — under
 * well-known directories. None of it is client content. It must never be created inside
 * a client codeline at all: not staged, not committed, not WRITTEN.
 *
 * Live metrolinx 20260804T225443Z: `orchestrations/agents/KB.md` was created inside the
 * upexpress client repo and entered that lane's writer-output manifest. Cause: claude.sh
 * and codemie-claude.sh instruct the writer agent to "append one entry to
 * `orchestrations/agents/KB.md`" — a RELATIVE path — while the agent's cwd is the client
 * codeline.
 *
 * The enforcement point already existed and did not fire:
 *
 *   if (allowedPathsEnv && (resolved.endsWith('.ts') || resolved.endsWith('.tsx')))
 *
 * The scope guard is gated on the file EXTENSION, so a .md write was never evaluated —
 * nor was any .json, .yml or .lock. EPAM_ALLOWED_WRITE_PATHS was set and irrelevant.
 *
 * Two distinct rules are tested here, and they are not the same rule:
 *
 *   1. ENGINE-OWNED PATHS ARE REFUSED UNCONDITIONALLY. Not subject to scope, not subject
 *      to extension, not subject to EPAM_ALLOWED_WRITE_PATHS being set at all. This is
 *      the perimeter. Cleaning it up later at the commit seam is not the perimeter — by
 *      then the file exists in the customer's working tree.
 *   2. THE SCOPE GUARD APPLIES TO EVERY FILE TYPE. An out-of-scope .md or .json is as
 *      out of scope as an out-of-scope .ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteFileTool } from '../../../src/tools/builtin/WriteFile';

/** Engine state directories. Engine self-knowledge — not a stack fact, not a client fact. */
const ENGINE_OWNED = [
  'orchestrations/agents/KB.md',
  'orchestrations/agents/profiles.json',
  'orchestrations/logs/agent-activity.jsonl',
  '.epam/settings.json',
  '.codegraph/index.json',
  '.deepeval/telemetry.txt',
  '.contracts/api.json',
];

let clientRepo: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  clientRepo = mkdtempSync(join(tmpdir(), 'perimeter-'));
  mkdirSync(join(clientRepo, 'src'), { recursive: true });
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(clientRepo, { recursive: true, force: true });
});

const write = async (relPath: string, content = 'x') => {
  const tool = new WriteFileTool();
  return tool.execute(
    { path: join(clientRepo, relPath), content },
    { cwd: clientRepo } as never,
  );
};

describe('engine-owned paths are refused unconditionally', () => {
  it.each(ENGINE_OWNED)('refuses to write %s, and creates no file', async (p) => {
    delete process.env.EPAM_ALLOWED_WRITE_PATHS; // no scope set — must STILL be refused
    const res = await write(p);
    expect(
      res.isError,
      `${p} is engine state. Writing it into a client codeline puts the pipeline's own ` +
        `files inside the customer's repository — the perimeter breach that put ` +
        `orchestrations/agents/KB.md into upexpress on run 20260804T225443Z.`,
    ).toBe(true);
    expect(existsSync(join(clientRepo, p)), `${p} was created on disk despite the refusal`).toBe(
      false,
    );
  });

  it('is not defeated by a scope that would otherwise permit it', async () => {
    process.env.EPAM_ALLOWED_WRITE_PATHS = clientRepo; // scope says "anything here"
    const res = await write('orchestrations/agents/KB.md');
    expect(
      res.isError,
      'the perimeter must not be waivable by widening EPAM_ALLOWED_WRITE_PATHS',
    ).toBe(true);
  });
});

describe('the scope guard covers every file type, not just .ts/.tsx', () => {
  beforeEach(() => {
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(clientRepo, 'src');
  });

  it.each(['notes.md', 'data.json', 'config.yml'])(
    'blocks out-of-scope %s the same as a .ts',
    async (f) => {
      const res = await write(f);
      expect(
        res.isError,
        `the guard was gated on .ts/.tsx, so ${f} was never evaluated — which is exactly ` +
          `how a .md write escaped it`,
      ).toBe(true);
    },
  );

  it('still blocks an out-of-scope .ts (unchanged behaviour)', async () => {
    expect((await write('rogue.ts')).isError).toBe(true);
  });

  it('still ALLOWS in-scope client work — or these tests prove nothing', async () => {
    const res = await write('src/useContent.ts');
    expect(res.isError, `in-scope write was refused: ${res.content}`).toBeFalsy();
    expect(existsSync(join(clientRepo, 'src/useContent.ts'))).toBe(true);
  });

  it('allows an in-scope .md — the rule is scope, not file type', async () => {
    const res = await write('src/README.md');
    expect(res.isError, `in-scope markdown was refused: ${res.content}`).toBeFalsy();
  });
});
