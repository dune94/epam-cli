/**
 * A LAUNCH KNOWS ITS BALANCE BEFORE IT SPENDS.
 *
 * regintel 20260919T224649Z resume 6 ran into OpenRouter 402s mid-phase ("can only afford
 * 1741 tokens") and burned attempts against an empty account; on 2026-09-20 the next launch was
 * about to start on a $13.50 balance for a ~$20 run. The provider set already declares a
 * spend probe (usage); it now declares a balance probe too, and pre-flight reports the balance
 * and refuses a launch when the project declares a run budget the balance cannot cover.
 * Declared in provider-sets.json and llm-settings (costControls.runBudgetUsd); nothing here
 * names a provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

describe('the declarations', () => {
  it('the openrouter set declares a balance probe (credits and usage paths)', () => {
    const sets = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).sets;
    expect(sets.openrouter.balanceProbe).toMatchObject({ url: expect.stringMatching(/^https:/), keyEnv: 'OPENROUTER_API_KEY', creditsPath: expect.any(String), usagePath: expect.any(String) });
  });
  it('llm-settings declares costControls.runBudgetUsd', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-settings.schema.json'), 'utf8'));
    expect(schema.properties.costControls.properties.runBudgetUsd).toBeTruthy();
  });
});

describe('balance_probe_read (lib/spend-probe.sh)', () => {
  const LIB = join(ROOT, 'orchestrations/scripts/lib/spend-probe.sh');
  function read(body: string, env: Record<string, string>) {
    // curl stand-in answers with the given body; the probe reads the declared paths.
    const r = spawnSync('bash', ['-c', `curl(){ printf '%s' ${JSON.stringify(body)}; }; export -f curl; source ${JSON.stringify(LIB)}; balance_probe_read`], { encoding: 'utf8', env: { ...process.env, ...env, EPAM_PROVIDER_SET: 'openrouter', OPENROUTER_API_KEY: 'k' } });
    return r.stdout.trim();
  }
  it('answers credits minus usage from the declared paths', () => {
    expect(read('{"data":{"total_credits":700,"total_usage":686.5}}', {})).toBe('13.50');
  });
  it('answers nothing when the body is unreadable — no figure is not a zero', () => {
    expect(read('not json', {})).toBe('');
  });
  it('answers nothing when the set declares no balance probe', () => {
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; balance_probe_read`], { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'mockserver' } });
    expect(r.stdout.trim()).toBe('');
  });
});

describe('pre-flight', () => {
  const src = readFileSync(join(ROOT, 'orchestrations/scripts/preflight-check.sh'), 'utf8');
  it('reports the balance and refuses when it cannot cover the declared run budget', () => {
    expect(src).toMatch(/balance_probe_read/);
    expect(src).toMatch(/runBudgetUsd|EPAM_RUN_BUDGET_USD/);
    const at = src.indexOf('balance_probe_read');
    const block = src.slice(at, at + 1600);
    expect(block).toMatch(/fail "/);
    expect(block).toMatch(/ok "/);
  });
});
