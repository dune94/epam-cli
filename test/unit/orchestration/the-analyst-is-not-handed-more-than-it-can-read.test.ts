import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A PROMPT THAT CANNOT BE SENT IS NOT A DIAGNOSIS.
 *
 * The FailureAnalyst's prompt embeds VERIFICATION_FAILURE via `--rawfile`, and for a suite failure
 * that is `_new_test_failures` — unbounded. When the baseline could not be built the delta became
 * the WHOLE suite output, and the analyst's request reached
 *
 *     "Prompt is too long · the request is ~1092054 tokens (limit 1000000)"
 *
 * every time. The ladder then escalated claude-sonnet-5 -> claude-opus-4-8 -> claude-opus-5 on
 * three calls that were arithmetically incapable of succeeding: a bigger model cannot fix an
 * oversized input. Live 2026-09-02, AMSD-1919.
 *
 * The window is DECLARED (config/evidence-windows.json: failureExcerptLines), never a literal here.
 * And entries are dropped WHOLE — a failure cut in half tells the analyst something is wrong
 * without telling it what, which is the defect this gate exists to avoid.
 */
describe('the failure text handed to the analyst', () => {
  const handler = path.resolve(__dirname, '../../../orchestrations/scripts/lib/handlers/bound-failures.js');
  const claude = path.resolve(__dirname, '../../../orchestrations/scripts/claude.sh');
  const windows = path.resolve(__dirname, '../../../orchestrations/config/evidence-windows.json');

  const repo = () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
    fs.mkdirSync(path.join(r, '.epam'), { recursive: true });
    fs.writeFileSync(path.join(r, '.epam', 'verification.json'), JSON.stringify({
      typecheck: { command: 'true' },
      test: { command: 'true', failurePattern: '^\\s*FAIL\\s+(\\S+)', failureIdentity: '{1}' },
    }));
    return r;
  };

  // 40 failing suites, 12 lines each = 480 lines, well past any sane window
  const huge = Array.from({ length: 40 }, (_, i) =>
    [`  FAIL src/area${i}/thing${i}.spec.tsx`,
      ...Array.from({ length: 11 }, (_, j) => `      detail line ${j} for suite ${i}`)].join('\n'),
  ).join('\n');

  const run = (text: string, section = 'test') => {
    const r = spawnSync(process.execPath, [handler, repo(), section], {
      input: text, encoding: 'utf8', timeout: 60_000,
    });
    return `${r.stdout ?? ''}`;
  };

  it('bounds the text to the declared window', () => {
    const limit = JSON.parse(fs.readFileSync(windows, 'utf8')).windows.failureExcerptLines.value;
    const out = run(huge);
    expect(out.length, 'handler produced nothing — vacuous pass').toBeGreaterThan(0);
    expect(out.split('\n').length).toBeLessThanOrEqual(Number(limit) + 5); // + the dropped-note
  });

  it('drops whole entries — never cuts one in half', () => {
    const out = run(huge);
    const kept = out.split('\n').filter((l) => /FAIL\s+\S+/.test(l)).length;
    expect(kept, 'no entries survived').toBeGreaterThan(0);
    // every kept entry must still carry its last detail line
    for (let i = 0; i < kept; i += 1) {
      expect(out, `entry ${i} was cut mid-way`).toContain(`detail line 10 for suite ${i}`);
    }
  });

  it('says how many entries it dropped, so nothing goes missing silently', () => {
    const out = run(huge);
    expect(out).toMatch(/\d+\s+(further|more).*(entr|failure|suite)/i);
  });

  it('passes a small failure through untouched', () => {
    const small = '  FAIL src/a/b.spec.tsx\n      expected 1 to be 2\n';
    expect(run(small).trim()).toBe(small.trim());
  });

  it('claude.sh actually calls it — a bound nothing invokes is not a bound', () => {
    expect(fs.readFileSync(claude, 'utf8')).toContain('bound-failures.js');
  });
});
