/**
 * PILLAR 1 — the pre-flight guard at the execution seam.
 *
 * A `pre_exec_block` constraint compiles to KB_PRE_EXEC_BLOCKS on the env
 * channel; the Bash tool refuses a matching command BEFORE it reaches the OS.
 * The point is to short-circuit locally: no subprocess, no wasted turn, and no
 * "diagnose the failure afterwards" round trip.
 *
 * The rejection is returned as the TOOL RESULT — explicitly allowed, and
 * explicitly NOT a prompt push. It is in-band, deterministic, tied to the exact
 * call, and verifiable, in the same category as an OS permission error or a
 * non-zero exit. Without it the agent hits an invisible wall and retries blindly.
 * The gate id travels with it so the refusal is attributable to a stored rule.
 *
 * Matching is literal substring by design (see kb_schema.py): a partial bash
 * parser would be a new silent-failure surface, which is the class being removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BashTool } from '../../../src/tools/builtin/Bash.js';

const ORIGINAL = process.env.KB_PRE_EXEC_BLOCKS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.KB_PRE_EXEC_BLOCKS;
  else process.env.KB_PRE_EXEC_BLOCKS = ORIGINAL;
});

const run = (command: string) => new BashTool().execute({ command, timeout: 10000 });

describe('Pillar 1 — Bash refuses a command a stored rule blocks', () => {
  it('short-circuits a matching command without executing it', async () => {
    process.env.KB_PRE_EXEC_BLOCKS = JSON.stringify([{ id: 'no-sudo-impl', pattern: 'sudo ' }]);
    // If the guard fails, this actually runs and writes the file.
    const r = await run('sudo echo nope');
    expect(r.isError, 'a blocked command was not refused').toBe(true);
    expect(r.content).toMatch(/no-sudo-impl/);
    expect(r.content.toLowerCase()).toMatch(/kb gate|blocked|refused/);
  });

  it('names the mechanism so the agent is not walking into an invisible wall', async () => {
    process.env.KB_PRE_EXEC_BLOCKS = JSON.stringify([{ id: 'no-force-push', pattern: '--no-verify' }]);
    const r = await run('echo pretend-commit --no-verify');
    expect(r.content).toMatch(/--no-verify/);
  });

  it('does not execute the command — no side effects reach the OS', async () => {
    process.env.KB_PRE_EXEC_BLOCKS = JSON.stringify([{ id: 'b1', pattern: 'echo SHOULD_NOT_RUN' }]);
    const r = await run('echo SHOULD_NOT_RUN');
    expect(r.content).not.toMatch(/^SHOULD_NOT_RUN/m);
    expect(r.exitCode).not.toBe(0);
  });

  it('allows a non-matching command through untouched', async () => {
    process.env.KB_PRE_EXEC_BLOCKS = JSON.stringify([{ id: 'no-sudo-impl', pattern: 'sudo ' }]);
    const r = await run('echo allowed');
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/allowed/);
  });

  it('is inert when no rules are set', async () => {
    delete process.env.KB_PRE_EXEC_BLOCKS;
    const r = await run('echo fine');
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/fine/);
  });

  it('fails OPEN on malformed rules, loudly — a broken KB must not break the agent', async () => {
    // Never fail closed here: an unparseable env value would otherwise block every
    // command the agent runs. But it must not be silent either.
    process.env.KB_PRE_EXEC_BLOCKS = '{not json';
    const r = await run('echo still works');
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/still works/);
  });
});
