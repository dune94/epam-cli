/**
 * When an external service cannot be reached, say so ONCE and let it propagate.
 *
 * AMSD-2041 asks for live preview of draft content. The three brand sites all
 * integrate Contentstack, which is SaaS — there is no self-hosted image, and the
 * repos carry delivery credentials only: no preview token, no Live Preview SDK.
 * So the integration can be built and wired, and it cannot be verified against
 * the real service.
 *
 * The failure mode this guards against is subtle and has bitten this project
 * before. If only the TEST WRITER is told to mock, but the verification criteria
 * say "a content author sees the draft rendered on the live site", the mocked
 * test cannot satisfy the criterion: the test writer did as instructed and the
 * validator correctly reports the criterion unmet. Two agents in conflict, both
 * behaving correctly, because the constraint arrived downstream of the thing
 * that defines "done".
 *
 * So the flag is consumed where criteria are WRITTEN, first. Everything after
 * inherits the scope without being told.
 *
 * Deliberately NOT prose in a prompt as the only mechanism: this project has
 * logs of a prose instruction being injected, ignored, and the same failure
 * recurring sixteen more times. The flag is a declaration, the hosts are
 * per-project config, and the report states the weaker claim whenever it is on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SPEC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const CONFIG = readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8');
const REPORT = readFileSync(join(ROOT, 'orchestrations/scripts/generate-run-report.py'), 'utf8');

const FLAG = 'EPAM_MOCK_EXTERNAL_CMS_APIS';

describe('the project declares what it cannot reach', () => {
  it('metrolinx sets the flag', () => {
    expect(CONFIG, `${FLAG} is not declared, so nothing downstream can act on it`)
      .toMatch(new RegExp(`^${FLAG}=`, 'm'));
  });

  it('names the hosts in CONFIG, not in engine code', () => {
    // The engine must not learn what Contentstack is. A payments or maps API
    // later should be a config change, never a code change.
    expect(CONFIG, 'the unreachable hosts are not declared per-project')
      .toMatch(/EPAM_MOCK_EXTERNAL_CMS_HOSTS=/m);
    expect(SPEC, 'a vendor name is hardcoded into the engine')
      .not.toMatch(/contentstack/i);
  });
});

describe('the criteria are written to the reachable boundary', () => {
  it('the flag reaches the agent that writes verification criteria', () => {
    // Consumed where "done" is DEFINED. Told only to the test writer, it arrives
    // too late and manufactures a conflict with the validator.
    expect(SPEC, `${FLAG} is never read while generating verification criteria`)
      .toMatch(new RegExp(FLAG));
  });

  it('instructs criteria to stop at the boundary rather than assert live behaviour', () => {
    const i = SPEC.indexOf(FLAG);
    expect(i, 'flag not found').toBeGreaterThan(-1);
    const near = SPEC.slice(Math.max(0, i - 1500), i + 1500);
    expect(near, 'nothing tells the criteria writer what a provable criterion looks like here')
      .toMatch(/mock|stub|boundary/i);
  });

  it('is inert when the flag is unset', () => {
    // A project with reachable services must be unaffected: this narrows what
    // "done" means, and narrowing it by default would weaken every other run.
    const i = SPEC.indexOf(FLAG);
    const near = SPEC.slice(Math.max(0, i - 600), i + 600);
    expect(near, 'the constraint is applied unconditionally rather than when declared')
      .toMatch(/if\s*\(|\?|&&/);
  });
});

describe('it must not become a licence to mock everything', () => {
  it('scopes mocking to the DECLARED hosts only', () => {
    const i = SPEC.indexOf(FLAG);
    const near = SPEC.slice(Math.max(0, i - 1500), i + 1500);
    expect(near,
      'the instruction does not limit itself to the declared hosts, so an agent ' +
      'can read it as licence to stub any inconvenient dependency')
      .toMatch(/only|solely|exclusively/i);
  });

  it('says every OTHER API is still exercised for real', () => {
    // The whole value of the run is coverage. A flag that quietly removes
    // coverage from APIs we can reach would trade a real defect for a green tick.
    const i = SPEC.indexOf(FLAG);
    const near = SPEC.slice(Math.max(0, i - 1500), i + 1500);
    expect(near, 'nothing states that other integrations keep their real coverage')
      .toMatch(/other|remain|still.*(real|normal)|do NOT mock/i);
  });
});

describe('a run under the flag makes a weaker claim, and says so', () => {
  it('the report discloses that integration was not verified', () => {
    // A flag that makes tests easier to pass, set once and never unset, removes
    // integration signal silently. A green run under it is not the same claim as
    // a green run without it, and the report is where that must be visible.
    expect(REPORT, 'the report is silent about running with external services mocked')
      .toMatch(new RegExp(FLAG));
  });
});
