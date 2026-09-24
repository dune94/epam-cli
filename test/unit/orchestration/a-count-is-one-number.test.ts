/**
 * A COUNT IS ONE NUMBER.
 *
 * The baseline build logged "parsed 0\n0 failure id(s)" (£0 escalation-chain run 5, 2026-09-24):
 * `grep -c` prints 0 AND exits 1 on no match, so `|| echo 0` appended a second zero. The same value
 * set BASELINE_KNOWN_FAILURES, which external-verification reads in a numeric test with errors
 * silenced — "0\n0" made that test fail, and the "a suite that never ran is not a pass" guard with it.
 * Driven through the real _bg_count_ids, and through the real consumer's own numeric test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const GATE = join(__dirname, '../../../orchestrations/scripts/lib/tsc-baseline-gate.sh');
const d = mkdtempSync(join(tmpdir(), 'count-')); afterAll(() => rmSync(d, { recursive: true, force: true }));
const count = (content: string | null) => {
  const f = join(d, `c${Math.random()}`); if (content !== null) writeFileSync(f, content);
  const r = spawnSync('bash', ['-c', `${shellFunction(GATE, '_bg_count_ids')}\n_bg_count_ids ${JSON.stringify(f)}`], { encoding: 'utf8' });
  return r.stdout;
};

describe('a count is one number', () => {
  it('an empty cache is 0 — once', () => expect(count('')).toBe('0'));
  it('a whitespace-only cache is 0 — once', () => expect(count('  \n\n \t\n')).toBe('0'));
  it('a missing cache is 0', () => expect(count(null)).toBe('0'));
  it('five ids are 5', () => expect(count('a::x\nb::y\n\nc::z\nd\ne\n')).toBe('5'));
  it('the consumer\'s numeric test works on it — the guard that failed open', () => {
    const r = spawnSync('bash', ['-c', `${shellFunction(GATE, '_bg_count_ids')}\nf=$(mktemp); printf '  \\n' > "$f"; B="$(_bg_count_ids "$f")"; [ "\${B:-0}" -eq 0 ] 2>/dev/null && echo ZERO || echo BROKEN; rm -f "$f"`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('ZERO');
  });
});
