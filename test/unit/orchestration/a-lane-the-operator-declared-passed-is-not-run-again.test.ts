/** EPAM_PASSED_LANES: a lane the operator declares already passed in this run is not run again (AMSD-2974, 2026-10-04). */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const LANES = join(__dirname, '../../../orchestrations/scripts/lib/codeline-lanes.sh');
const passed = (decl: string, lane: string) => spawnSync('bash', ['-c', `log(){ :; }; warning(){ :; }; source ${JSON.stringify(LANES)} 2>/dev/null; lane_declared_passed ${lane} && echo SKIP || echo RUN`],
  { encoding: 'utf8', env: { ...process.env, EPAM_PASSED_LANES: decl } }).stdout.trim();
describe('a lane the operator declared passed is not run again', () => {
  it('declared: skipped', () => { expect(passed('cxshared', 'cxshared')).toBe('SKIP'); expect(passed('gotransit, cxshared', 'cxshared')).toBe('SKIP'); });
  it('not declared, or a different name: run', () => { expect(passed('', 'cxshared')).toBe('RUN'); expect(passed('cxshared2', 'cxshared')).toBe('RUN'); expect(passed('cxshared', 'gotransit')).toBe('RUN'); });
});
