/**
 * THE PROJECT WINS PER MODEL, NOT PER FILE.
 *
 * Model overrides live in the active STACK (config/llm-defaults.<set>.json) and a project may
 * override for its own reasons. The precedence was applied to the FILE: if the project declared any
 * modelOverrides at all, the stack's were never consulted.
 *
 * mock3 declares overrides for the models of the openrouter stack it was written against. Run on
 * claude, none of them match, and because the project "declares overrides" the stack's own claude
 * entries — autoCompressAt 150000 — were skipped entirely. The value fell through to
 * defaultAutoCompressAt: 80000, and the installed CLI rejects that outright:
 *
 *   error: option '--autocompact <auto|tokens>' argument '80000' is invalid.
 *          It must be 'auto', or between 100k and 1M
 *
 * Twelve attempts died on argument validation before a single token was sent, on 2026-08-28, at
 * GBP 0 and a whole writer leg. A project's silence about THIS model is not an instruction to
 * ignore the stack's answer for it.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project file that overrides other models, and a stack file that covers this one. */
function files() {
  const d = mkdtempSync(join(tmpdir(), 'override-')); dirs.push(d);
  const project = join(d, 'llm-settings.json');
  const stack = join(d, 'llm-defaults.claude.json');
  writeFileSync(project, JSON.stringify({
    modelOverrides: {
      '$note': 'a comment beside the overrides, not an override',
      'minimax-m3': { matchOn: 'model', matchSubstring: 'MiniMax-M3', autoCompressAt: 180000 },
    },
  }));
  writeFileSync(stack, JSON.stringify({
    modelOverrides: {
      'claude-haiku-4-5': { matchOn: 'model', matchSubstring: 'claude-haiku-4-5', autoCompressAt: 150000 },
    },
  }));
  return { project, stack };
}

/** Ask the real function, sourced from the real script. */
function resolve(model: string, provider: string, order: string[]): string {
  const r = spawnSync('bash', ['-c',
    `set -o pipefail
     # source only the function under test — claude.sh is a whole runner
     eval "$(sed -n '/^resolve_model_override() {/,/^}/p' ${JSON.stringify(CLAUDE_SH)})"
     resolve_model_override ${JSON.stringify(model)} ${JSON.stringify(provider)} ${order.map((o) => JSON.stringify(o)).join(' ')}`,
  ], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').trim();
}

describe('A MODEL OVERRIDE IS FOUND WHEREVER IT IS DECLARED', () => {
  it('takes the stack\'s answer for a model the project says nothing about', () => {
    const { project, stack } = files();
    const got = resolve('claude-haiku-4-5-20251001', 'claude', [project, stack]);
    expect(got, 'the project declared overrides for OTHER models, so the stack was never consulted '
      + 'and this model fell through to a default the CLI rejects').toBeTruthy();
    expect(JSON.parse(got).autoCompressAt).toBe(150000);
  });

  it('still lets the project override a model it does declare', () => {
    const { project, stack } = files();
    const got = resolve('MiniMax-M3', 'minimax', [project, stack]);
    expect(JSON.parse(got).autoCompressAt,
      'the project must keep the last word on models it declares').toBe(180000);
  });

  it('returns nothing when neither declares the model', () => {
    const { project, stack } = files();
    expect(resolve('some-unknown-model', 'nobody', [project, stack])).toBe('');
  });

  it('ignores a "$"-prefixed documentation key rather than aborting on it', () => {
    // Indexing .value.matchOn on a string aborts the whole jq query, and the 2>/dev/null that
    // follows turns that into "no overrides at all" — every override lost because someone wrote
    // a comment beside them.
    const { project, stack } = files();
    expect(JSON.parse(resolve('MiniMax-M3', 'minimax', [project, stack])).autoCompressAt).toBe(180000);
  });
});
