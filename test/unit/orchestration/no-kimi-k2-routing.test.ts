/**
 * No pipeline code may route to moonshotai/kimi-k2.
 *
 * Moonshot discontinued the entire k2 series upstream on 2026-05-25. On OpenRouter
 * it survives via exactly ONE provider, so it is both EOL and a single point of
 * failure — and it is not a reasoning model, unlike everything else in the ladder.
 *
 * It was still reachable in several live paths, not just as dead config:
 *   - post-impl-tc-writer.sh defaulted TC_MODEL to it, and TC_WRITER_MODEL is set
 *     NOWHERE — so the TC writer was actually running on it.
 *   - spec-mode-runner.js defaulted openspec/speckit/spec-mode to it.
 *   - run-agent-orchestration.sh reported and used it as the spec-pass default.
 *   - travel-app and skyscanner used it as EPAM_FINAL_FALLBACK_MODEL — the escape
 *     hatch that fires after everything else has already failed.
 *   - profiles.json listed it in the prd-model-coordinator's ALLOWED assignment set,
 *     so the coordinator could assign it to a story outright.
 *
 * Scope note: this guards ROUTING. Pricing tables keep their k2 entry so historical
 * cost data still reconciles, and test fixtures may name it as a past-tense example.
 *
 * kimi-k2.5 is a DIFFERENT, later, actively-maintained model (released
 * 2026-01-27, before this repo's 2026-05-25 k2 discontinuation finding) — its
 * OpenRouter listing shows live pricing/uptime and multiple routing providers
 * (Balanced/Nitro/Exacto), the opposite of the single-provider dead-end this
 * guard exists for. Excluded from the "kimi-k2" match via negative lookahead
 * so it stays reachable while bare kimi-k2/kimi-k2-thinking stay blocked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations');

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (/^(logs|node_modules|\.git)$/.test(e.name)) continue;   // logs are history
      yield* files(join(dir, e.name));
    } else if (/\.(sh|js|json|env)$/.test(e.name)) yield join(dir, e.name);
  }
}

/** Pricing tables legitimately retain k2 so past runs still price correctly. */
const PRICING = /model-pricing\.json$/;

describe('kimi-k2 is not reachable from any routing path', () => {
  it('no orchestration file routes to moonshotai/kimi-k2', () => {
    const hits: string[] = [];
    for (const f of files(ORCH)) {
      if (PRICING.test(f)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!/kimi-k2(?!\.5)/.test(line)) return;
        // A past-tense comment explaining history is fine; a value is not.
        const isComment = /^\s*(#|\/\/|\*)/.test(line);
        if (isComment) return;
        hits.push(`${f.replace(ROOT, '')}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    expect(hits, 'these can still select the discontinued kimi-k2').toEqual([]);
  });

  it('no mock fixture pins it as an escalation model', () => {
    // The mocks drive the REAL launcher, so a k2 pin there is live routing, not a
    // fixture detail — and the orchestration guard above deliberately skips test/.
    const dir = join(__dirname);
    for (const f of readdirSync(dir).filter(n => /^brownfield-mock-e2e.*\.test\.ts$/.test(n))) {
      expect(readFileSync(join(dir, f), 'utf8'),
        `${f} routes an escalation to the discontinued k2`).not.toMatch(/ESCALATION_MODEL[^\n]*kimi-k2/);
    }
  });

  it('the agent profiles do not permit assigning it', () => {
    const p = join(ORCH, 'agents/profiles.json');
    if (!existsSync(p)) return;
    expect(readFileSync(p, 'utf8')).not.toMatch(/kimi-k2/);
  });
});
