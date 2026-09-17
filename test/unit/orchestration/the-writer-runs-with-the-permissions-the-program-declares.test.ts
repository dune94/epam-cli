/**
 * THE WRITER RUNS WITH THE PERMISSIONS THE PROGRAM DECLARES.
 *
 * 771993fc (2026-09-16) removed CLAUDE_PERMISSIONS from claude.sh as "assigned here and never
 * read" — per-file shellcheck reported SC2034. It is read by lib/story-attempt.sh, a module of
 * the same program: implement_story builds `effective_permissions` from it. From that release
 * every writer on the claude set ran without --dangerously-skip-permissions and without the
 * agent constitution; every write was refused ("you haven't granted it yet"), the writer
 * reported the wall, and the story failed after 8 attempts. regintel 20260916T200108Z spent
 * three resumes on it (2026-09-17) before the cause was read off the runner's own refusal.
 *
 * Asserted at the receiver: the reassembled program (main + modules, as engineSource joins it)
 * is executed up to the flag assembly with a stub runner, and the argv it would be given is
 * what is judged. The constitution is whatever the program built — its presence is asserted,
 * its wording is not.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The program's own declaration of the permission flags, and the interactive-mode clearing. */
function declaration(src: string): { decl: string; clears: boolean } {
  const start = src.indexOf('\nCLAUDE_PERMISSIONS=(');
  expect(start, 'CLAUDE_PERMISSIONS is not declared in the program — the writer runs with no permissions').toBeGreaterThan(-1);
  const end = src.indexOf('\n)\n', start);
  return { decl: src.slice(start + 1, end + 2), clears: /if \[ "\$interactive_mode" = true \]; then\n\s+CLAUDE_PERMISSIONS=\(\)/.test(src) };
}

/** The lines of implement_story that turn the declaration into the runner's flags. */
function assembly(src: string): string {
  const start = src.indexOf('    local effective_constitution=');
  expect(start, 'the effective_permissions assembly is not in implement_story').toBeGreaterThan(-1);
  const end = src.indexOf('\n    fi\n', start);
  return src.slice(start, end + 8).replace(/^\s*local /gm, '');
}

describe('the writer runs with the permissions the program declares', () => {
  const src = engineSource(CLAUDE_SH);

  it('the declaration exists, names the skip-permissions flag and appends the constitution, and interactive mode clears it', () => {
    const { decl, clears } = declaration(src);
    expect(decl).toMatch(/--dangerously-skip-permissions/);
    expect(decl).toMatch(/--append-system-prompt/);
    expect(decl).toMatch(/\$AGENT_CONSTITUTION/);
    expect(clears, 'interactive mode no longer clears the flags').toBe(true);
  });

  it('EXECUTED: the flags the writer is handed carry skip-permissions and a non-empty constitution', () => {
    const { decl } = declaration(src);
    const script = [
      'set -uo pipefail', 'log(){ :; }',
      'AGENT_CONSTITUTION="AGENT BEHAVIORAL CONTRACT — built by the program"', 'DYNAMIC_CONSTITUTION=""', 'schema_block=""',
      decl, assembly(src),
      'printf "%s\\n" "${effective_permissions[@]}"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const argv = r.stdout.split('\n').filter(Boolean);
    expect(argv[0]).toBe('--dangerously-skip-permissions');
    expect(argv[1]).toBe('--append-system-prompt');
    expect(argv[2], 'the constitution did not reach the runner').toContain('AGENT BEHAVIORAL CONTRACT');
  });

  it('EXECUTED: with the declaration cleared (interactive mode) the writer is handed no permission flags', () => {
    const script = [
      'set -uo pipefail', 'log(){ :; }', 'AGENT_CONSTITUTION="x"', 'DYNAMIC_CONSTITUTION=""', 'schema_block=""',
      'CLAUDE_PERMISSIONS=()', assembly(src),
      'echo "N=${#effective_permissions[@]}"',
    ].join('\n');
    expect(spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim()).toBe('N=0');
  });
});
