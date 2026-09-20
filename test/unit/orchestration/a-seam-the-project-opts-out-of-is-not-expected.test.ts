/**
 * A SEAM THE PROJECT OPTS OUT OF IS NOT EXPECTED TO RUN.
 *
 * regintel's config.env declares EPAM_TOPOLOGY_ROUTER=0 and SKIP_BROWSER_E2E_ROUTING=true — the
 * operator's own choices — and the £0 rehearsal (#20, 2026-09-20) counted topology-router and
 * qa-gate:e2e as "NOT EXECUTED" against a run that executed everything else, both phases GO.
 * The registry now lets a seam declare the project setting that switches it off (optOut), and
 * the expectation honours it with the reason; nothing is hardcoded in the harness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const se = require(join(ROOT, 'orchestrations/scripts/lib/seams-expected.js'));
const profiles = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles;

describe('the registry declares the opt-out', () => {
  it('topology-router and qa-gate:e2e name the project setting that switches them off', () => {
    expect(profiles['topology-router'].optOut).toMatchObject({ env: 'EPAM_TOPOLOGY_ROUTER', value: '0' });
    expect(profiles['qa-gate:e2e'].optOut).toMatchObject({ env: 'SKIP_BROWSER_E2E_ROUTING', value: 'true' });
  });
});

describe('the expectation honours it', () => {
  const modes = new Set(['greenfield', 'multi-story']);
  it('a project that opts out is not expected to run the seam, with the reason', () => {
    const r = se.expectedSeams(profiles, modes, 'EPAM_TOPOLOGY_ROUTER=0\nSKIP_BROWSER_E2E_ROUTING=true\n');
    expect(r.expected).not.toContain('topology-router');
    expect(r.expected).not.toContain('qa-gate:e2e');
    expect(r.excluded['topology-router']).toMatch(/EPAM_TOPOLOGY_ROUTER=0/);
  });
  it('a project that does not opt out still expects them', () => {
    const r = se.expectedSeams(profiles, modes, 'SKIP_BROWSER_E2E_ROUTING=false\n');
    expect(r.expected).toContain('topology-router');
    expect(r.expected).toContain('qa-gate:e2e');
  });
  it('the CLI passes the project config through', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/seams-expected.js'), 'utf8');
    expect(src).toMatch(/expectedSeams\(profiles, modes, configText\)/);
  });
});
