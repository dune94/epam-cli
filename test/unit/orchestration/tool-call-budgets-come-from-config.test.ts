/**
 * THE TOOL-CALL BUDGETS ARE CONFIGURATION, NOT LITERALS IN THE ENGINE.
 *
 * `EPAM_MAX_TOOL_CALLS` was `env.SPEC_MODE_MAX_TOOL_CALLS || '8'` in three places. Eight is
 * the single most consequential number in the spec pass: it is how much an agent is allowed to
 * LOOK before it must answer. Live 2026-08-08 an estate survey told to open three repositories
 * ran out of calls, reported "no existing infrastructure — this is greenfield work" about a
 * brownfield estate with 243 matching source files in the first codeline, and a roster was
 * minted on that verdict. Changing that number meant editing a 9,000-line script.
 *
 * It now lives beside the other operator knobs in orchestrations/config, next to the per-story
 * budgets that were extracted from a shell case statement for the same reason.
 *
 * A MISSING VALUE IS AN ERROR, NOT A DEFAULT. Falling back to a literal would put the number
 * back in the engine and, worse, would do it silently on the one run the config failed to
 * load — the same shape as every fail-open gate in this pipeline. Same stance as
 * protectedRoles(), which refuses to merge rather than proceed with an empty list.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const CONFIG = join(__dirname, '../../../orchestrations/config/spec-mode-defaults.json');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

beforeEach(() => {
  delete process.env.SPEC_MODE_MAX_TOOL_CALLS;
  delete process.env.EPAM_SURVEY_TOOL_CALLS_PER_CODELINE;
  delete process.env.EPAM_SPEC_MODE_DEFAULTS_FILE;
});

const codelines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `cl${i}`, path: `/estate/cl${i}` }));

describe('the config file is real and carries the budgets', () => {
  it('it exists and is valid JSON', () => {
    expect(() => JSON.parse(readFileSync(CONFIG, 'utf8'))).not.toThrow();
  });

  it('it declares both budgets as positive numbers', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.toolCalls.perAgent).toBeGreaterThan(0);
    expect(cfg.toolCalls.perCodelineSurvey).toBeGreaterThan(0);
  });
});

describe('THE DEFECT: the number comes from the file, not from the source', () => {
  it('specAgentEnv uses the configured per-agent budget', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(spec.specAgentEnv({}, '/x').EPAM_MAX_TOOL_CALLS).toBe(String(cfg.toolCalls.perAgent));
  });

  it('changing the file changes the budget — nothing is baked in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-cfg-')); dirs.push(dir);
    const f = join(dir, 'spec-mode-defaults.json');
    writeFileSync(f, JSON.stringify({ toolCalls: { perAgent: 33, perCodelineSurvey: 44 },
      tools: { readOnlyBuiltins: ['read_file'] } }));
    process.env.EPAM_SPEC_MODE_DEFAULTS_FILE = f;
    expect(spec.specAgentEnv({}, '/x').EPAM_MAX_TOOL_CALLS).toBe('33');
    expect(spec.surveyToolBudget(codelines(2), {})).toBe('88');   // 44 x 2
  });

  it('the survey budget is the configured rate times the codeline count', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const rate = cfg.toolCalls.perCodelineSurvey;
    expect(spec.surveyToolBudget(codelines(3), {})).toBe(String(rate * 3));
    expect(spec.surveyToolBudget(codelines(1), {})).toBe(String(rate));
  });

  it('an operator env override still wins over the file', () => {
    expect(spec.specAgentEnv({ SPEC_MODE_MAX_TOOL_CALLS: '25' }, '/x').EPAM_MAX_TOOL_CALLS).toBe('25');
    expect(spec.surveyToolBudget(codelines(4), { SPEC_MODE_MAX_TOOL_CALLS: '11' })).toBe('11');
    expect(spec.surveyToolBudget(codelines(2), { EPAM_SURVEY_TOOL_CALLS_PER_CODELINE: '5' })).toBe('10');
  });
});

describe('a missing or unusable value is an ERROR, never a silent default', () => {
  function withConfig(body: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'budget-bad-')); dirs.push(dir);
    const f = join(dir, 'spec-mode-defaults.json');
    writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
    process.env.EPAM_SPEC_MODE_DEFAULTS_FILE = f;
    return f;
  }

  it('an absent file throws rather than inventing a number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-none-')); dirs.push(dir);
    const missing = join(dir, 'does-not-exist.json');
    process.env.EPAM_SPEC_MODE_DEFAULTS_FILE = missing;
    // Either half of the config may notice first; both must refuse rather than assume.
    expect(() => spec.specAgentEnv({}, '/x')).toThrow(/cannot read/i);
    expect(() => spec.surveyToolBudget([{ name: 'a', path: '/a' }], {})).toThrow(/cannot read/i);
  });

  it('unparseable JSON throws', () => {
    withConfig('{ not json');
    expect(() => spec.specAgentEnv({}, '/x')).toThrow();
  });

  it('a missing key throws', () => {
    withConfig({ toolCalls: {}, tools: { readOnlyBuiltins: ['read_file'] } });
    expect(() => spec.specAgentEnv({}, '/x')).toThrow();
  });

  it('a non-numeric or zero value throws', () => {
    withConfig({ toolCalls: { perAgent: 'lots', perCodelineSurvey: 8 }, tools: { readOnlyBuiltins: ['read_file'] } });
    expect(() => spec.specAgentEnv({}, '/x')).toThrow();
    withConfig({ toolCalls: { perAgent: 0, perCodelineSurvey: 8 }, tools: { readOnlyBuiltins: ['read_file'] } });
    expect(() => spec.specAgentEnv({}, '/x')).toThrow();
  });

  it('the error names the file, so an operator knows what to fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-msg-')); dirs.push(dir);
    const missing = join(dir, 'gone.json');
    process.env.EPAM_SPEC_MODE_DEFAULTS_FILE = missing;
    expect(() => spec.specAgentEnv({}, '/x')).toThrow(new RegExp(missing.replace(/[/\\]/g, '.')));
  });
});

describe('the engine source no longer carries the number', () => {
  it('no `|| \'8\'` tool-call literal remains in spec-mode-runner', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const offenders = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /MAX_TOOL_CALLS/.test(l) && /\|\|\s*'\d+'|:\s*\d+\s*;/.test(l));
    expect(
      offenders.map((o) => `${o.n}: ${o.l.trim()}`),
      'a tool-call budget is still written into the engine',
    ).toEqual([]);
  });
});
