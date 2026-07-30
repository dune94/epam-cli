/**
 * A requirement the agent can read and ignore is not a requirement.
 *
 * Live AMSD-2041 2026-07-30. The metrolinx lane was rejected on attempts 2, 3
 * and 4 with the byte-identical message:
 *
 *   the prescribed helper `Stack.livePreviewQuery` EXISTS in this repository
 *   but does NOT appear in the change. The agent hand-rolled the logic
 *
 * The corrective was reaching the model — the retry prompt named the helper 21
 * times and explained why re-implementing it fails. It read the advice and
 * declined. $2.29 across three lanes, none delivered.
 *
 * That is the standing rule: self-heal knowledge must reach agents as
 * env/gates/schema enforcement, never as prose a model is free to ignore. The
 * enforcement point is the WRITE, where EPAM_ALLOWED_WRITE_PATHS already proves
 * an env-driven structural guard works: the tool returns isError and the agent
 * must respond to it inside its own loop, rather than discovering the problem
 * one full billed attempt later.
 *
 * THE HARD CONSTRAINT — this guard must never be able to block correct work.
 * A prescribed fix site comes from an LLM detective and has been wrong before
 * (locationHint propagation is non-deterministic, and a run has already failed
 * because a candidate file was declared that the real fix never needed). So:
 *
 *   - it only applies to files the story explicitly prescribes as the helper's
 *     site, never to every write;
 *   - it yields after EPAM_REQUIRED_SYMBOL_MAX_BLOCKS (default 2) blocks on a
 *     file, so a wrong prescription costs two tool results, not a dead story.
 *     The post-hoc verifier and the ladder still catch a genuine miss.
 *
 * A guard that can deadlock a story is worse than the prose it replaces.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WriteFileTool } from '../../../src/tools/builtin/WriteFile';

const dirs: string[] = [];
const ENV_KEYS = [
  'EPAM_REQUIRED_SYMBOLS',
  'EPAM_REQUIRED_SYMBOL_SCOPE',
  'EPAM_REQUIRED_SYMBOL_MAX_BLOCKS',
  'EPAM_ALLOWED_WRITE_PATHS',
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function workspace() {
  const d = mkdtempSync(join(tmpdir(), 'reqsym-'));
  dirs.push(d);
  return d;
}

async function write(file: string, content: string) {
  const tool = new WriteFileTool();
  return tool.execute({ path: file, content } as never);
}

describe('a write to the prescribed fix site must use the prescribed helper', () => {
  it('blocks a write that hand-rolls instead of reusing it — the live case', async () => {
    const d = workspace();
    const site = join(d, 'contentstack.ts');
    process.env.EPAM_REQUIRED_SYMBOLS = 'Stack.livePreviewQuery';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = site;

    const r = await write(site, 'export const q = (s: string) => s.split("-")[0];');
    expect(r.isError, 'the hand-rolled write was accepted; the model only learns ' +
      'it was wrong a full billed attempt later, and last time declined three times')
      .toBe(true);
    expect(r.content).toMatch(/Stack\.livePreviewQuery/);
    expect(existsSync(site), 'the rejected content was written to disk anyway').toBe(false);
  });

  it('allows the write once the helper is used', async () => {
    const d = workspace();
    const site = join(d, 'contentstack.ts');
    process.env.EPAM_REQUIRED_SYMBOLS = 'Stack.livePreviewQuery';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = site;

    const good = 'import { Stack } from "./stack";\nexport const q = Stack.livePreviewQuery();';
    const r = await write(site, good);
    expect(r.isError).toBeFalsy();
    expect(readFileSync(site, 'utf8')).toBe(good);
  });

  it('accepts any ONE of several prescribed symbols', async () => {
    const d = workspace();
    const site = join(d, 'a.ts');
    process.env.EPAM_REQUIRED_SYMBOLS = 'foo.bar:baz.qux';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = site;
    const r = await write(site, 'export const x = baz.qux();');
    expect(r.isError, 'requiring ALL symbols would block a fix that legitimately ' +
      'needs only one of the candidates').toBeFalsy();
  });
});

describe('it cannot block work outside what was prescribed', () => {
  it('ignores files outside the declared scope', async () => {
    const d = workspace();
    process.env.EPAM_REQUIRED_SYMBOLS = 'Stack.livePreviewQuery';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = join(d, 'contentstack.ts');

    const other = join(d, 'unrelated.ts');
    const r = await write(other, 'export const y = 1;');
    expect(r.isError, 'a write unrelated to the prescription was blocked').toBeFalsy();
  });

  it('does nothing when no symbol is prescribed', async () => {
    const d = workspace();
    delete process.env.EPAM_REQUIRED_SYMBOLS;
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = join(d, 'a.ts');
    const r = await write(join(d, 'a.ts'), 'export const y = 1;');
    expect(r.isError).toBeFalsy();
  });

  it('does nothing when no scope is declared', async () => {
    // Symbols without a scope must NOT degrade into "every file must mention
    // it" — that would block every unrelated write in the story.
    const d = workspace();
    process.env.EPAM_REQUIRED_SYMBOLS = 'Stack.livePreviewQuery';
    delete process.env.EPAM_REQUIRED_SYMBOL_SCOPE;
    const r = await write(join(d, 'a.ts'), 'export const y = 1;');
    expect(r.isError).toBeFalsy();
  });
});

describe('it yields rather than deadlocking a story', () => {
  it('stops blocking after the configured number of attempts', async () => {
    // The prescription comes from an LLM detective and has been wrong before.
    // Two tool results is a fair price for a wrong guess; a dead story is not.
    const d = workspace();
    const site = join(d, 'a.ts');
    process.env.EPAM_REQUIRED_SYMBOLS = 'some.helper';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = site;
    process.env.EPAM_REQUIRED_SYMBOL_MAX_BLOCKS = '2';

    const bad = 'export const y = 1;';
    expect((await write(site, bad)).isError, 'first block').toBe(true);
    expect((await write(site, bad)).isError, 'second block').toBe(true);
    const third = await write(site, bad);
    expect(third.isError,
      'the guard blocked a third time — a wrong fix-site prescription can now ' +
      'deadlock the story, which is worse than the prose it replaced')
      .toBeFalsy();
    expect(readFileSync(site, 'utf8'), 'the yielded write did not land').toBe(bad);
  });

  it('the yield is configurable and can be set to zero blocks', async () => {
    const d = workspace();
    const site = join(d, 'a.ts');
    process.env.EPAM_REQUIRED_SYMBOLS = 'some.helper';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = site;
    process.env.EPAM_REQUIRED_SYMBOL_MAX_BLOCKS = '0';
    expect((await write(site, 'export const y = 1;')).isError,
      'the guard could not be disabled').toBeFalsy();
  });

  it('counts blocks per file, not globally', async () => {
    // One badly-prescribed file must not consume another's allowance.
    const d = workspace();
    const a = join(d, 'a.ts');
    const b = join(d, 'b.ts');
    process.env.EPAM_REQUIRED_SYMBOLS = 'some.helper';
    process.env.EPAM_REQUIRED_SYMBOL_SCOPE = `${a}:${b}`;
    process.env.EPAM_REQUIRED_SYMBOL_MAX_BLOCKS = '1';

    expect((await write(a, 'x')).isError, 'a first block').toBe(true);
    expect((await write(b, 'x')).isError, 'b first block — b spent a\'s budget').toBe(true);
  });
});

describe('the pipeline hands the tool what it prescribed', () => {
  // A correct guard nobody feeds is inert. The symbol and its scope must come
  // from the SAME verified fixSiteAnalysis entry the post-hoc verifier reads,
  // or the two disagree about what was prescribed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const CLAUDE = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

  it('exports both variables to the implementation agent', () => {
    expect(CLAUDE, 'EPAM_REQUIRED_SYMBOLS is never passed — the guard can never fire')
      .toMatch(/EPAM_REQUIRED_SYMBOLS="\$\{_req_symbols\}"/);
    expect(CLAUDE, 'scope is never passed, so the guard stays inert by design')
      .toMatch(/EPAM_REQUIRED_SYMBOL_SCOPE="\$\{_req_scope\}"/);
  });

  it('derives them from verified fix sites only', () => {
    // fixVerified === true is the same filter verify_prescribed_helper_used
    // uses. Enforcing on an UNVERIFIED guess would block on a hunch.
    const i = CLAUDE.indexOf('_req_symbols=$(jq');
    expect(i, '_req_symbols is not derived from the PRD').toBeGreaterThan(-1);
    expect(CLAUDE.slice(i, i + 400)).toMatch(/fixVerified == true/);
  });
});
