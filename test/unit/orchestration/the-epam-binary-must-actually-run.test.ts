/**
 * THE `epam` BINARY HAS BEEN INERT SINCE 2026-08-28, AND WITH IT EVERY REPLAY.
 *
 * tsup builds `epam: 'src/index.ts'` and package.json binds both `epam` and `epam-cli` to
 * dist/epam.js. Commit b3fc684a replaced src/index.ts with a two-line placeholder —
 * "1 file changed, 2 insertions(+), 30 deletions(-)" — losing the entry that constructs the CLI
 * and parses argv:
 *
 *     import { greeting } from './hello';
 *     console.log(greeting);
 *
 * The built artefact still on disk predates that and ends `exports.createCLI = createCLI;` with no
 * caller, so `node dist/epam.js --version` exits 0 and prints NOTHING. Every arm routed through
 * `epam run` therefore returns nothing: llm-handler dispatches replay to it, gets an empty reply,
 * and reports "provider 'replay' returned NO completion record".
 *
 * That is why rehearsal has never worked, why cassettes could not prove anything, and why the
 * build-staleness guard never fired — dist is NEWER than src, so the check passes while the
 * artefact is broken.
 *
 * These assert the ARTEFACT behaves, not that a string appears in a file.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist/epam.js');
const NODE = process.execPath;

function epam(...args: string[]) {
  const r = spawnSync(NODE, [DIST, ...args], { encoding: 'utf8', timeout: 60_000, input: '' });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

describe('the built epam binary', () => {
  it('exists', () => {
    expect(existsSync(DIST), 'dist/epam.js is missing — nothing routed through `epam run` can work')
      .toBe(true);
  });

  it('ANSWERS --version instead of exiting silently', () => {
    const r = epam('--version');
    expect(r.out.trim(), 'the binary printed nothing at all: its entry never invokes the CLI, so '
      + 'every `epam run` — including replay — returns an empty reply').not.toBe('');
  });

  /**
   * ASKED OF `run` ITSELF, not of the program. The entry injects `chat` when no subcommand is
   * given — deliberate, so `epam --provider x` reaches chat — so a bare `--help` prints CHAT's
   * help and says nothing about `run`. My first version asserted on that and failed against a
   * binary that was working.
   */
  it('registers the `run` command the pipeline dispatches to', () => {
    const r = epam('run', '--help');
    expect(r.out, 'no help output — the CLI is never constructed').not.toBe('');
    expect(r.out, '`run` is not a registered command, so every `epam run` in the pipeline is a '
      + 'no-op').toMatch(/Usage: epam run/);
  });

  it('its source entry actually builds a CLI, rather than printing a greeting', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    expect(src, 'src/index.ts is still the placeholder that replaced the real entry')
      .not.toMatch(/from '\.\/hello'/);
    expect(src, 'the entry never constructs the CLI').toMatch(/createCLI/);
    expect(src, 'the entry never parses argv, so the binary defines everything and exits')
      .toMatch(/parseAsync|\.parse\(/);
  });
});
