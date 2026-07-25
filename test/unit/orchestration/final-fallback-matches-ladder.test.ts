/**
 * The final-fallback model must BE the ladder's top rung.
 *
 * There are two escalation mechanisms and they must agree:
 *   - EPAM_MODEL_LADDER_HIGH walks model->model; its terminal entry is the last
 *     model normal escalation ever reaches (`z-ai/glm-5.1=moonshotai/kimi-k3`).
 *   - EPAM_FINAL_FALLBACK_MODEL is a separate escape hatch used at
 *     run-agent-orchestration.sh:1072 when the ladder yields no next model.
 *
 * They had diverged: the ladder ended at kimi-k3 while the final fallback was
 * kimi-k2 — a model Moonshot discontinued upstream on 2026-05-25, which survives on
 * OpenRouter via exactly ONE provider, and which is not a reasoning model. So the
 * escape hatch that fires when everything else has failed pointed at the most
 * fragile option available, contradicting the stated design ("last resort is k3").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONFIGS = [
  'orchestrations/projects/metrolinx/config.env',
  'orchestrations/jira/metrolinx.env',
].map(p => join(__dirname, '../../../', p)).filter(existsSync);

/** Terminal model of a `a=b|b=c` ladder: the value that is never itself a key. */
function ladderTop(ladder: string): string | null {
  const pairs = ladder.split('|').map(s => s.split('=')).filter(p => p.length === 2);
  const keys = new Set(pairs.map(p => p[0].trim()));
  const terminal = pairs.map(p => p[1].trim()).filter(v => !keys.has(v));
  return terminal.length ? terminal[terminal.length - 1] : null;
}

describe('final fallback agrees with the HIGH ladder', () => {
  it('finds the configs', () => expect(CONFIGS.length).toBeGreaterThan(0));

  for (const cfg of CONFIGS) {
    const name = cfg.split('/').slice(-2).join('/');
    it(`${name}: EPAM_FINAL_FALLBACK_MODEL is the HIGH ladder's top rung`, () => {
      const src = readFileSync(cfg, 'utf8');
      const ladder = src.match(/^EPAM_MODEL_LADDER_HIGH="?([^"\n]+)"?$/m);
      const final = src.match(/^EPAM_FINAL_FALLBACK_MODEL=(.+)$/m);
      if (!ladder || !final) return;                    // config does not set both
      expect(final[1].trim()).toBe(ladderTop(ladder[1]));
    });

    it(`${name}: does not route to the discontinued kimi-k2`, () => {
      const src = readFileSync(cfg, 'utf8');
      const final = src.match(/^EPAM_FINAL_FALLBACK_MODEL=(.+)$/m);
      // Moonshot EOL'd the k2 series 2026-05-25; one OpenRouter provider remains.
      expect(final?.[1].trim()).not.toBe('moonshotai/kimi-k2');
    });
  }
});
