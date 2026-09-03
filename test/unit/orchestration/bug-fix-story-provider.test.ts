/**
 * A BUG-FIX STORY IS ASSIGNED A PROVIDER THE DISPATCH ACCEPTS.
 *
 * This file used to guard a NAME. Auto-generated BUG-* stories must never be assigned
 * aiProvider="openrouter", it said, because that string was not a recognised provider anywhere —
 * provider_to_cli() accepted the old vendor name instead, and "openrouter" hit its error branch so
 * the story failed immediately.
 *
 * The deprecation made the forbidden string the CORRECT one, and the file ended up asserting both
 * halves of a contradiction: "the valid provider list does not include openrouter" and
 * "openrouter IS a recognized provider", about the same function body.
 *
 * A guard written around a name cannot survive the name changing. The property underneath it can:
 * whatever provider a bug-fix story is assigned must be one the dispatch will route. That is read
 * from the dispatch itself, so the next rename moves it automatically and a provider added to the
 * dispatch needs no edit here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const PROVIDERS_JSON = join(ROOT, 'orchestrations/config/providers.json');

const orchSrc = readFileSync(ORCH, 'utf8');
const providers = JSON.parse(readFileSync(PROVIDERS_JSON, 'utf8'));

/** The providers the orchestrator's dispatch will route — the single source of truth. */
function acceptedProviders(): string[] {
  return [...orchSrc.matchAll(/^\s{4,}([a-z][a-z0-9-]*)\)\s+CLAUDE_SH=/gm)].map((m) => m[1]);
}

/**
 * Every provider provider_to_cli() (claude.sh) can run — read from providers.json's
 * `cliBinary`, its single declared source since change-log/SEAM-CONSISTENCY-ANALYSIS.md
 * Section 5 removed the hardcoded `case` statement this used to scrape from source text.
 */
function providerToCliNames(): string[] {
  return Object.keys(providers.cliBinary || {});
}

describe('a bug-fix story is assigned a provider the dispatch accepts', () => {
  it('the dispatch declares providers at all — otherwise nothing below is a check', () => {
    expect(acceptedProviders().length, 'no providers parsed from the dispatch').toBeGreaterThan(2);
    expect(providerToCliNames().length, 'provider_to_cli names nothing').toBeGreaterThan(2);
  });

  it('every aiProvider the orchestrator assigns is one the dispatch routes', () => {
    // The real failure this prevents: a story created with a provider string the dispatch does not
    // know dies at its first call, having already locked a codeline.
    const accepted = new Set(acceptedProviders());
    const assigned = [...orchSrc.matchAll(/aiProvider["']?\s*[:=]\s*["']([a-z][a-z0-9-]*)["']/g)]
      .map((m) => m[1]);
    const unroutable = [...new Set(assigned)].filter((p) => !accepted.has(p));
    expect(unroutable, `these assigned providers the dispatch cannot route: ${unroutable.join(', ')}`)
      .toEqual([]);
  });

  it('and provider_to_cli can run every provider the dispatch routes', () => {
    // The other direction: a provider the dispatch accepts but the runner cannot execute fails
    // later and less visibly.
    const cli = new Set(providerToCliNames());
    const orphans = acceptedProviders().filter((p) => !cli.has(p));
    expect(orphans, `the dispatch routes these, but provider_to_cli cannot run them: ${orphans.join(', ')}`)
      .toEqual([]);
  });
});
