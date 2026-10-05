/**
 * A FAILURE'S IDENTITY IS ITS OWN LINE — never the lines printed before it.
 *
 * Real-estate rehearsal, 2026-10-05 (a copy of next.gotransit.com): its declared type-check pattern is
 * ^([^(]+)\((\d+),(\d+)\): error ([A-Z0-9]+). `[^(]+` crosses newlines, so the FIRST error's identity
 * swallowed npm's banner ("> @metrolinx/gotransit@1.0.0 check-types ..."). A type error added before
 * the pre-existing ones became the first: the delta found it, but its banner-prefixed identity matched
 * no single line when the report was assembled, the report came out empty — and empty means "nothing
 * new". A real new type error passed Steps 19/20's baseline-judged check.
 *
 * EXECUTED: the real parseFailures and newFailures, on output shaped exactly as `npm run check-types`
 * prints it, with the project's own declared pattern and identity.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../../orchestrations/plugins/verification-plugin.js');
const root = mkdtempSync(join(tmpdir(), 'identity-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, '.epam'));
writeFileSync(join(root, '.epam', 'verification.json'), JSON.stringify({
  typecheck: { command: 'npm run check-types', failurePattern: '^([^(]+)\\((\\d+),(\\d+)\\): error ([A-Z0-9]+)', failureIdentity: '{1}:{2}:{4}' },
}));

const banner = '\n> @metrolinx/gotransit@1.0.0 check-types\n> tsc --noEmit --incremental\n\n';
const old1 = "src/components/AuthOnlineChat/AuthOnlineChat.tsx(4,10): error TS2305: Module has no exported member 'X'.";
const old2 = "src/components/pages/TripSearchResults/TripResults.tsx(86,15): error TS2322: Type is not assignable.";
const added = "src/__tests__/defaultStation.mock.ts(53,14): error TS2322: Type 'string' is not assignable to type 'number'.";

describe('parseFailures', () => {
  it('no identity carries the banner or any other line', () => {
    const ids = plugin.parseFailures(root, `${banner}${old1}\n${old2}\n`, 'typecheck');
    expect(ids).toEqual(['src/components/AuthOnlineChat/AuthOnlineChat.tsx:4:TS2305', 'src/components/pages/TripSearchResults/TripResults.tsx:86:TS2322']);
  });

  it('an error that becomes the first one is still recognised as new, and the old ones as old', () => {
    const base = plugin.parseFailures(root, `${banner}${old1}\n${old2}\n`, 'typecheck');
    const now = plugin.parseFailures(root, `${banner}${added}\n${old1}\n${old2}\n`, 'typecheck');
    expect(plugin.newFailures(now, base)).toEqual(['src/__tests__/defaultStation.mock.ts:53:TS2322']);
    // and the report step's per-line re-parse finds the same identity on the error's own line
    expect(plugin.parseFailures(root, added, 'typecheck')).toEqual(['src/__tests__/defaultStation.mock.ts:53:TS2322']);
  });
});
