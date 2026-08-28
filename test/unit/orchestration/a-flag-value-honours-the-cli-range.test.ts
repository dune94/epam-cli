/**
 * THE BINARY DECLARES WHAT IT ACCEPTS. READ IT BEFORE SPENDING.
 *
 * mock3 declares compaction.defaultAutoCompressAt = 80000 — written against a stack whose CLI
 * accepted it. The installed claude CLI does not:
 *
 *   --autocompact <auto|tokens>   Auto-compact window size (auto, or 100k–1M tokens)
 *
 * so every writer attempt died on argument validation before a token was sent. The project's value
 * is not wrong — it is wrong FOR THIS RUNNER, and no layer compared the two. This is the same
 * lesson as `claude --print` having no turn cap: the runner's own --help is the contract, and
 * checking it costs nothing next to a wasted leg.
 *
 * Clamped rather than refused: a window smaller than the CLI's floor is a preference the binary
 * cannot honour, and the nearest legal value keeps the run moving. Said out loud, never silently.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/runner-settings.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A stub binary whose --help declares a range, exactly as the real one does. */
function cliDeclaring(helpLine: string) {
  const d = mkdtempSync(join(tmpdir(), 'cli-')); dirs.push(d);
  const bin = join(d, 'faux-cli');
  writeFileSync(bin, `#!/usr/bin/env bash\ncat <<'EOF'\n${helpLine}\nEOF\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function clamp(bin: string, flag: string, value: string) {
  const r = spawnSync('bash', ['-c',
    `warning(){ echo "WARN $*"; }; log(){ :; }
     # source the library as a run does: clamp_flag_to_cli_range calls _expand_magnitude, and
     # lifting one function out of a pair proves only that the lift worked
     source ${JSON.stringify(LIB)}
     clamp_flag_to_cli_range ${JSON.stringify(bin)} ${JSON.stringify(flag)} ${JSON.stringify(value)}`,
  ], { encoding: 'utf8', timeout: 60000 });
  const lines = (r.stdout || '').trim().split('\n');
  return { value: lines[lines.length - 1], warned: (r.stdout || '').includes('WARN') };
}

const HELP = '  --autocompact <auto|tokens>           Auto-compact window size (auto, or 100k–1M tokens)';

describe('A FLAG VALUE IS CHECKED AGAINST THE BINARY\'S OWN DECLARATION', () => {
  it('raises a value below the declared floor', () => {
    const got = clamp(cliDeclaring(HELP), '--autocompact', '80000');
    expect(got.value, 'the CLI refuses 80000 and every attempt dies on argument validation')
      .toBe('100000');
    expect(got.warned, 'a value was changed without saying so').toBe(true);
  });

  it('lowers a value above the declared ceiling', () => {
    expect(clamp(cliDeclaring(HELP), '--autocompact', '2000000').value).toBe('1000000');
  });

  it('leaves a value inside the range exactly as declared', () => {
    const got = clamp(cliDeclaring(HELP), '--autocompact', '150000');
    expect(got.value).toBe('150000');
    expect(got.warned, 'a value the CLI accepts was reported as changed').toBe(false);
  });

  it('passes a non-numeric value through — "auto" is legal here', () => {
    expect(clamp(cliDeclaring(HELP), '--autocompact', 'auto').value).toBe('auto');
  });

  it('changes nothing when the help declares no range for the flag', () => {
    const help = '  --autocompact <auto|tokens>           Auto-compact window size';
    expect(clamp(cliDeclaring(help), '--autocompact', '80000').value).toBe('80000');
  });

  it('changes nothing when the binary cannot be asked', () => {
    // A CLI that does not answer --help must never cause a flag to be rewritten on a guess.
    expect(clamp('/nonexistent/cli', '--autocompact', '80000').value).toBe('80000');
  });
});

describe('AGAINST THE REAL INSTALLED CLI', () => {
  it('the value mock3 declared is corrected to one claude accepts', () => {
    const probe = spawnSync('bash', ['-c', 'command -v claude || true'], { encoding: 'utf8' });
    if (!(probe.stdout || '').trim()) return;            // not installed here; the stub tests stand
    const got = clamp('claude', '--autocompact', '80000');
    expect(Number(got.value), 'the real CLI declares a floor this value is under')
      .toBeGreaterThanOrEqual(100000);
  });
});
