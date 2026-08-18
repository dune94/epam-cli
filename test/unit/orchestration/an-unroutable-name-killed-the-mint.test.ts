/**
 * AN UNROUTABLE NAME KILLED THE MINT INSTEAD OF BEING SENT BACK TO IT.
 *
 * mint-agents-step.js resolves every minted agent to a seam AFTER the model has answered, and
 * resolveSeam throws when nothing matches. So a single badly-suffixed name ended the run — with
 * a correct roster sitting in the log — rather than being corrected.
 *
 * The mint already has the mechanism. mergeProjectAgents collects proposals that parse but fail
 * the contract into `rejected`, each with a reason, and the correction loop re-mints against
 * those reasons. It does this for a rationale that says nothing and for a brief naming paths
 * that do not exist. A name the pipeline cannot route is the same kind of failure and belongs in
 * the same loop.
 *
 * THE REASON MUST BE ACTIONABLE. "resolves to no seam" tells the model nothing it can fix, so
 * the rejection names the shapes permitted FOR THE KIND IT DECLARED — derived from the registry,
 * like the prompt's rule, so a reason can never offer a shape the resolver would then refuse.
 *
 * KIND AND SUFFIX MUST AGREE. `-investigator` routes to the detective seam and `-engineer` to
 * the writer, so a proposal calling itself an implementer while wearing an investigator's suffix
 * would be routed to a seam that does different work than the kind promises.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeProjectAgents } = require(join(ROOT, 'orchestrations/scripts/lib/agent-roster.js'));

let dir: string;
let profilesPath: string;

const proposal = (over: Record<string, unknown> = {}) => ({
  name: 'payments-engineer',
  kind: 'implementer',
  codeline: '*',
  systemPrompt: 'A long enough briefing about this project, its conventions and the files it owns.',
  rationale: 'This project has a payments domain that needs a role able to author changes in it.',
  ...over,
});

const merge = (proposals: unknown[]) =>
  mergeProjectAgents({ profilesPath, proposals, codelines: [{ name: 'shop' }] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-route-'));
  profilesPath = join(dir, 'profiles.json');
  writeFileSync(profilesPath, '{}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('an unroutable name killed the mint', () => {
  it('MINTS A CONFORMING PROPOSAL — so the rejections below are not vacuous', () => {
    const r = merge([proposal()]);
    expect(r.rejected, `a valid proposal was rejected: ${JSON.stringify(r.rejected)}`).toEqual([]);
    expect(r.minted.length, 'nothing was minted, so nothing here proves anything').toBe(1);
  });

  it('REJECTS AN UNROUTABLE NAME RATHER THAN THROWING — the run continues', () => {
    let r: any;
    expect(() => { r = merge([proposal({ name: 'auth-security-specialist' })]); },
      'an unroutable name still ends the mint instead of being sent back to it').not.toThrow();
    expect(r.minted, 'an unroutable agent was minted anyway').toEqual([]);
    expect(r.rejected.length, 'the proposal was neither minted nor rejected').toBe(1);
    expect(r.rejected[0].name).toBe('auth-security-specialist');
  });

  it('THE REASON NAMES SHAPES THE MODEL CAN ACTUALLY USE', () => {
    const r = merge([proposal({ name: 'auth-security-specialist' })]);
    const reason = String(r.rejected[0].reason);
    // Whatever shapes it offers must themselves resolve — a reason that suggests an unroutable
    // suffix would send the correction loop straight back into the same rejection.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveSeam } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    const offered = [...reason.matchAll(/"-([a-z][a-z0-9]*)"/g)].map((m) => m[1]);
    expect(offered.length, `the reason offers no usable shape: ${reason}`).toBeGreaterThan(0);
    for (const sx of offered) {
      expect(() => resolveSeam(`some-domain-${sx}`),
        `the rejection suggests "-${sx}", which resolves to nothing`).not.toThrow();
    }
  });

  it('REJECTS A SUFFIX THAT SERVES A DIFFERENT KIND THAN DECLARED', () => {
    // -investigator routes to the detective seam; calling it an implementer would put a
    // story-owning role on a seam that never writes.
    const r = merge([proposal({ name: 'shop-investigator', kind: 'implementer', codeline: '*' })]);
    expect(r.minted, 'a role was minted onto a seam that does different work than its kind')
      .toEqual([]);
    expect(r.rejected.length).toBe(1);
    expect(String(r.rejected[0].reason)).toMatch(/kind|implementer|investigator/i);
  });

  it('a correctly-suffixed investigator still mints', () => {
    const r = merge([proposal({ name: 'shop-investigator', kind: 'investigator', codeline: 'shop' })]);
    expect(r.rejected, `a valid investigator was rejected: ${JSON.stringify(r.rejected)}`).toEqual([]);
    expect(r.minted.length).toBe(1);
  });
});
