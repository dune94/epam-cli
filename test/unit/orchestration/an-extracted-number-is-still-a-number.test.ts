/**
 * A heredoc interpolates a shell value into the program's own source, so `math.ceil($base * $mult)`
 * reached Python as two numeric LITERALS. Extracting the program turns both into arguments — which
 * arrive as strings — and `str * str` is a TypeError. Under the caller's
 * `2>/dev/null || echo "$timeout_secs"` that failed silently to the unscaled value, so neither the
 * role multiplier nor the watchdog retry multiplier did anything at all.
 *
 * These tests hold the class shut: a handler given a number must compute with it, and no handler
 * may do arithmetic on a raw argv reference.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const HANDLERS = join(__dirname, '../../../orchestrations/scripts/lib/handlers');
const SCALED = join(HANDLERS, 'scaled-timeout-secs.py');

const run = (args: string[]) => spawnSync('python3', [SCALED, ...args], { encoding: 'utf8' });

describe('an extracted number is still a number', () => {
  it('scales the timeout rather than failing to the unscaled one', () => {
    const r = run(['1.5', '600']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim(), 'the multiplier did nothing').toBe('900');
  });

  it('rounds up, so a fractional result never shortens the timeout', () => {
    expect(run(['1.5', '601']).stdout.trim()).toBe('902');   // 901.5 -> 902
  });

  it('takes an integer multiplier too', () => {
    expect(run(['2', '600']).stdout.trim()).toBe('1200');
  });

  it('fails loudly on a non-numeric argument instead of printing something usable', () => {
    const r = run(['not-a-number', '600']);
    expect(r.status, 'a bad multiplier produced a usable answer').not.toBe(0);
    expect(r.stdout.trim(), 'stdout carried a value the caller would have used').toBe('');
  });

  it('no handler does arithmetic directly on an argv reference', () => {
    // The shape of the original defect: an argv reference used where a literal used to be.
    const offenders: string[] = [];
    for (const f of readdirSync(HANDLERS).filter((n) => /\.(py|js)$/.test(n))) {
      const src = readFileSync(join(HANDLERS, f), 'utf8');
      const body = src.split('\n')
        .filter((l) => !/^\s*(#|\*|\/\/)/.test(l))          // comments explain the bug; they are not it
        .join('\n');
      // argv on either side of a *, / or - is arithmetic on text.
      if (/(?:sys|process)\.argv\[\d\]\s*[*/-]|[*/-]\s*(?:sys|process)\.argv\[\d\]/.test(body)) {
        offenders.push(f);
      }
    }
    expect(offenders, `these compute with a raw argument: ${offenders.join(', ')}`).toEqual([]);
  });
});
