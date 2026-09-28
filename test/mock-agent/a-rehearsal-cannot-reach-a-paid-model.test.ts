/**
 * A £0 REHEARSAL CANNOT REACH A PAID MODEL.
 *
 * 2026-09-27: a mock-agent rehearsal on the `claude` provider set ran for 60 minutes against the REAL
 * service — 106 calls, ~303k output tokens, ~$8.78 notional on the operator's subscription — because the
 * harness redirects a vendor only through a `<VENDOR>_API_KEY` credential and that set authenticates with
 * an OAuth session. "£0" was a label, not a guarantee. Now a set the harness would redirect NOTHING for
 * is refused before launch. (A proxy barrier on all outbound traffic was tried and withdrawn the same
 * day: it also blocked the package installs a greenfield £0 run legitimately makes.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vendorEdge, type ProjectRun } from './harness';
import { ROOT } from '../integration/lib/fixture-install';

const SETS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).sets;
const run = (set: string) => ({ install: ROOT, config: { EPAM_PROVIDER_SET: set }, agent: { url: 'http://127.0.0.1:1' } }) as unknown as ProjectRun;

describe('a set the harness cannot redirect is refused before launch', () => {
  it('the claude set (an OAuth session, nothing to redirect) is refused, naming why', () => {
    expect(() => vendorEdge(run('claude'))).toThrow(/claude.*cannot be rehearsed|would reach a real model/i);
  });

  it('every set that is refused is one that redirects nothing; every other set is accepted', () => {
    for (const set of Object.keys(SETS)) {
      const d = SETS[set];
      const redirectsSomething = (d.credentials || []).some((c: { from: string }) => /_API_KEY$/.test(c.from)) || !!d.redirect;
      let refused = false;
      try { vendorEdge(run(set)); } catch { refused = true; }
      if (set === 'mockserver') { expect(refused, 'mockserver redirects through its runner env').toBe(false); continue; }
      expect(refused, `${set}`).toBe(!redirectsSomething);
    }
  });
});
