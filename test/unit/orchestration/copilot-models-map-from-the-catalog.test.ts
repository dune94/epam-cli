/**
 * THE COPILOT LADDER IS THE CLAUDE LADDER, MAPPED THROUGH COPILOT'S OWN CATALOG.
 *
 * Operator, 2026-09-27: "Models same as claude map to those if available." Nothing is typed here: a
 * claude-set model id is normalised the way Copilot names the same model (date suffix dropped,
 * `4-8` → `4.8`) and looked up in the catalog Copilot serves the account; the reasoning effort a
 * rung asks for is passed only when the catalog says the model takes one, at the nearest level it
 * supports. Found by the spike: `--reasoning-effort` on a model without it prints an error and exits
 * 0, so an unsupported effort must never reach the command line.
 *
 * Executed through plugins/providers/copilot/copilot-models.js's command line (what the shell arms call), on the catalog
 * the dune94 account was served on 2026-09-27.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLI = join(ROOT, 'orchestrations/plugins/providers/copilot/copilot-models.js');
const CATALOG = join(ROOT, 'test/fixtures/copilot/models-20260927.json');

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, EPAM_COPILOT_CATALOG: CATALOG } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('a claude-set model maps to the model Copilot serves', () => {
  it.each([
    ['claude-haiku-4-5-20251001', 'claude-haiku-4.5'],
    ['claude-haiku-4-5', 'claude-haiku-4.5'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-opus-4-8', 'claude-opus-4.8'],
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-4.8', 'claude-opus-4.8'],   // already a Copilot id
  ])('%s → %s', (from, to) => {
    const r = run('map', from);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe(to);
  });

  it('a model the catalog does not serve is refused, naming it — never guessed', () => {
    const r = run('map', 'claude-opus-9');
    expect(r.status).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/claude-opus-9.*not in the Copilot catalog/);
  });
});

describe('the reasoning effort a rung asks for reaches only a model that takes one', () => {
  it('a supported level passes unchanged', () => {
    expect(run('effort', 'claude-opus-5', 'xhigh').out).toBe('xhigh');
    expect(run('effort', 'claude-sonnet-5', 'medium').out).toBe('medium');
  });

  it('a model without effort support gets none — the flag is left off', () => {
    const r = run('effort', 'claude-haiku-4.5', 'high');
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  it('a level the model does not list becomes the nearest it does, never a higher one', () => {
    // kimi-k3 lists low, high, max: medium becomes low (the highest listed level not above it).
    expect(run('effort', 'kimi-k3', 'medium').out).toBe('low');
    // gemini-3.7-flash tops out at high: max becomes high.
    expect(run('effort', 'gemini-3.7-flash', 'max').out).toBe('high');
    // below every listed level: the lowest listed one.
    expect(run('effort', 'gpt-5.3-codex', 'none').out).toBe('low');
  });

  it('no effort asked for: none passed', () => {
    expect(run('effort', 'claude-opus-5', '').out).toBe('');
  });
});

describe('without a catalog nothing is guessed', () => {
  it('map refuses when the catalog file is missing', () => {
    const r = spawnSync(process.execPath, [CLI, 'map', 'claude-sonnet-5'], { encoding: 'utf8',
      env: { ...process.env, EPAM_COPILOT_CATALOG: join(ROOT, 'test/fixtures/copilot/does-not-exist.json') } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/catalog/i);
  });
});
