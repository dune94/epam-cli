/**
 * THE FREE SET IS THE ONE THAT MUST NOT BE ABLE TO SPEND.
 *
 * The mockserver set exists so a rehearsal costs nothing. It was free only because the
 * ANTHROPIC_BASE_URL redirect held — not because billing was impossible. It declared no unsetEnv
 * at all, so every rehearsal ran with live credentials in its environment, and any call the
 * redirect failed to cover would have reached a real vendor and billed.
 *
 * The paid `claude` set DOES declare one — its own note says it was "built from the mockserver set
 * by REMOVING the redirect", so the seal was added downstream and never backfilled into the set
 * whose whole purpose is to cost nothing. Exactly inverted from what safety requires.
 *
 * It is not hypothetical: a mockserver rehearsal on 2026-08-29 ran `provider=minimax` for the
 * writer, with MINIMAX_API_KEY present.
 *
 * The vendors are NOT listed here. llm-channel.json already declares them once, in
 * credentialPattern, and this reads that — so a vendor added there is covered without editing
 * this test.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONFIG = path.join(__dirname, '../../../orchestrations/config');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(CONFIG, f), 'utf8'));

/** The vendor prefixes the channel declares as credential-bearing. */
function declaredVendors(): string[] {
  const pat = String(read('llm-channel.json').credentialPattern || '');
  const m = /\(([A-Z|]+)\)/.exec(pat);
  return m ? m[1].split('|').filter(Boolean) : [];
}

/** Every name the mockserver set removes from a child's environment. */
function unsetBy(setFile: string): string[] {
  const d = read(setFile);
  const names: string[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o.unsetEnv)) names.push(...o.unsetEnv);
    for (const v of Object.values(o)) walk(v);
  };
  walk(d);
  return names;
}

describe('a rehearsal cannot bill', () => {
  it('the channel declares the vendors — otherwise this proves nothing', () => {
    expect(declaredVendors().length).toBeGreaterThan(3);
  });

  it('the mockserver set removes a credential for every declared vendor', () => {
    const unset = unsetBy('llm-defaults.mockserver.json');
    expect(unset.length, 'the free set declares no unsetEnv at all').toBeGreaterThan(0);

    // EVERY VENDOR EXCEPT ANTHROPIC'S OWN. The mockBaseUrl redirect covers Anthropic traffic and
    // nothing else, so another vendor's credential is a live route out — the writer really did run
    // provider=minimax under this set with MINIMAX_API_KEY present.
    //
    // ANTHROPIC_API_KEY is deliberately LEFT: Claude Code falls back to the OAuth credentials on
    // disk when it finds no key, and that bills for real. Scrubbing it is the inversion this exists
    // to prevent — recorded in seam-the-subscription-pays-not-the-api-key, learned live.
    const routedByTheRedirect = ['ANTHROPIC', 'CLAUDE'];
    const uncovered = declaredVendors()
      .filter((v) => !routedByTheRedirect.includes(v))
      .filter((v) => !unset.some((n) => n.toUpperCase().includes(v)));
    expect(uncovered, `a rehearsal keeps live credentials for: ${uncovered.join(', ')}`).toEqual([]);

    // And the one that must survive, stated as its own assertion so it cannot be "tidied" away.
    expect(unset.some((n) => n.toUpperCase() === 'ANTHROPIC_API_KEY'),
      'scrubbing the mock key sends Claude Code to OAuth on disk, which bills').toBe(false);
  });

  it('the paid set still keeps its own seal — this must not regress it', () => {
    // The subscription pays only while the API key is absent.
    const unset = unsetBy('llm-defaults.claude.json').map((n) => n.toUpperCase());
    expect(unset).toContain('ANTHROPIC_API_KEY');
    expect(unset).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it.skip('supplies a worthless credential in place of the ones it removed', () => {
    // WITHDRAWN. Declaring a fake key in the set violates the-mock-set-needs-no-credentials, which
    // requires the set itself to carry no credential at all. The operator's own fake key is what
    // the runner uses, and it is now left alone rather than replaced.
    // A SEAL THAT ONLY TAKES AWAY CAN CAUSE THE THING IT PREVENTS. runner-settings.sh warns of it
    // directly: remove a mock run's credential and the runner falls back to the OAuth credentials
    // on disk — "the exact inversion this line must not cause". Removing must come with replacing,
    // so there is nothing to fall back TO.
    const m = require('../../../orchestrations/scripts/lib/llm-settings-resolve.js');
    const prev = process.env.EPAM_PROVIDER_SET;
    process.env.EPAM_PROVIDER_SET = 'mockserver';
    try {
      const r = m.runnerValues('claude', {
        projectConfigDir: path.join(__dirname, '../../../orchestrations/projects/mock3'),
      });
      expect(r, 'the mock runner does not resolve at all').toBeTruthy();
      expect(r.unsetEnv, 'the real credential is not removed').toContain('ANTHROPIC_API_KEY');
      expect(r.env.ANTHROPIC_API_KEY, 'nothing was supplied in its place').toBeTruthy();
      expect(r.env.ANTHROPIC_API_KEY).not.toMatch(/^sk-/);
      expect(r.env.ANTHROPIC_BASE_URL, 'the redirect must still hold').toContain('localhost');
    } finally {
      if (prev === undefined) delete process.env.EPAM_PROVIDER_SET;
      else process.env.EPAM_PROVIDER_SET = prev;
    }
  });
});
