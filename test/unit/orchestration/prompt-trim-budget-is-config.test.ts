/**
 * HOW MUCH GUIDANCE AN AGENT KEEPS IS A BUDGET, NOT A LITERAL.
 *
 * Two numbers decided it, both written into a 9,000-line shell script:
 *
 *     _scratchpad_threshold="${EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS:-16000}"
 *     keep_from = heading_idxs[-3] ...
 *
 * Live 2026-08-09, AMSD-2041 on gotransit: "Prompt exceeded 16000 chars (53366 actual) —
 * trimming to most recent guidance (up to 3)". The writer ran with roughly two thirds of its
 * accumulated coordinator guidance discarded, and a WARNING was the only trace.
 *
 * Neither number is arbitrary — the 3 replaced a 1 on 2026-07-11 after a live run repeated an
 * identical mistake five retries after being told not to, because a newer heading had pushed
 * the earlier diagnosis out of a single-heading window. That is precisely the kind of value an
 * operator needs to reach when a run misbehaves, and it should not require editing code.
 *
 * They join the other spec-pass budgets in orchestrations/config/spec-mode-defaults.json. As
 * there, a missing or unusable value is an ERROR rather than a silent fallback: putting the
 * number back in the engine on the one run the config failed to load is the fail-open shape
 * this pipeline keeps producing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CONFIG = join(__dirname, '../../../orchestrations/config/spec-mode-defaults.json');
const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const LIB = join(__dirname, '../../../orchestrations/scripts/lib/prompt-budget.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { delete process.env.EPAM_SPEC_MODE_DEFAULTS_FILE; });

// `VAR=x . file; func` does not keep the assignment for the later call — it applies to the
// sourcing only. Exported so the function sees it, which is how the pipeline sets these.
const sh = (script: string, env = '') =>
  execFileSync('bash', ['-c', `${env ? `export ${env};` : ''} . ${JSON.stringify(LIB)} >/dev/null 2>&1; ${script}`],
    { encoding: 'utf8' }).trim();

describe('the config carries both numbers', () => {
  const cfg = () => JSON.parse(readFileSync(CONFIG, 'utf8'));

  it('a positive character threshold', () => {
    expect(cfg().promptTrim.thresholdChars).toBeGreaterThan(0);
  });

  it('a positive count of guidance sections to keep', () => {
    expect(cfg().promptTrim.keepRecentSections).toBeGreaterThan(0);
  });

  it('each names the environment variable that overrides it, as the tool budgets do', () => {
    const t = cfg().promptTrim;
    expect(String(t.thresholdCharsEnv)).toMatch(/^EPAM_|^SPEC_/);
    expect(String(t.keepRecentSectionsEnv)).toMatch(/^EPAM_|^SPEC_/);
  });
});

describe('THE DEFECT: the numbers come from the file', () => {
  it('the threshold is read from config', () => {
    const want = JSON.parse(readFileSync(CONFIG, 'utf8')).promptTrim.thresholdChars;
    expect(sh('prompt_trim_threshold')).toBe(String(want));
  });

  it('the keep-count is read from config', () => {
    const want = JSON.parse(readFileSync(CONFIG, 'utf8')).promptTrim.keepRecentSections;
    expect(sh('prompt_trim_keep_sections')).toBe(String(want));
  });

  it('changing the file changes both — nothing is baked in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trim-cfg-')); dirs.push(dir);
    const f = join(dir, 'spec-mode-defaults.json');
    writeFileSync(f, JSON.stringify({ promptTrim: { thresholdChars: 4242, keepRecentSections: 9 } }));
    expect(sh('prompt_trim_threshold', `EPAM_SPEC_MODE_DEFAULTS_FILE=${JSON.stringify(f)}`)).toBe('4242');
    expect(sh('prompt_trim_keep_sections', `EPAM_SPEC_MODE_DEFAULTS_FILE=${JSON.stringify(f)}`)).toBe('9');
  });

  it('an operator env override still wins', () => {
    expect(sh('prompt_trim_threshold', 'EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS=1234')).toBe('1234');
    expect(sh('prompt_trim_keep_sections', 'EPAM_PROMPT_TRIM_KEEP_SECTIONS=7')).toBe('7');
  });

  it('0 remains the documented opt-out for trimming', () => {
    expect(sh('prompt_trim_threshold', 'EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS=0')).toBe('0');
  });
});

describe('a missing or unusable value is an ERROR, never a silent default', () => {
  function withConfig(body: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'trim-bad-')); dirs.push(dir);
    const f = join(dir, 'spec-mode-defaults.json');
    writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
    return `EPAM_SPEC_MODE_DEFAULTS_FILE=${JSON.stringify(f)}`;
  }
  const fails = (script: string, env: string) => {
    try { execFileSync('bash', ['-c', `export ${env}; . ${JSON.stringify(LIB)} >/dev/null 2>&1; ${script}`], { encoding: 'utf8' }); return false; }
    catch { return true; }
  };

  it('an absent file fails rather than inventing a number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trim-none-')); dirs.push(dir);
    expect(fails('prompt_trim_threshold', `EPAM_SPEC_MODE_DEFAULTS_FILE=${JSON.stringify(join(dir, 'gone.json'))}`)).toBe(true);
  });

  it('a missing key fails', () => {
    expect(fails('prompt_trim_threshold', withConfig({ promptTrim: {} }))).toBe(true);
  });

  it('a non-numeric value fails', () => {
    expect(fails('prompt_trim_keep_sections', withConfig({ promptTrim: { thresholdChars: 10, keepRecentSections: 'lots' } }))).toBe(true);
  });
});

describe('the engine no longer carries the numbers', () => {
  it('claude.sh has no literal trim budget', () => {
    const src = readFileSync(CLAUDE, 'utf8');
    const offenders = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /SCRATCHPAD_THRESHOLD_CHARS:-\s*\d/.test(l) || /heading_idxs\[-\d\]/.test(l));
    expect(
      offenders.map((o) => `${o.n}: ${o.l.trim()}`),
      'a prompt-trim budget is still written into the engine',
    ).toEqual([]);
  });
});
