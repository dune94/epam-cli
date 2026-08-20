// DISCOVERY IGNORED THE SCOPE THE OPERATOR NAMED, AND RAN OUT OF ITERATIONS IT WAS NEVER GIVEN.
//
// Live metrolinx AMSD-2041, 2026-08-18. Launched with EPAM_ONLY_CODELINES=metrolinx. Discovery
// selected gotransit and the run had to be killed before it wrote to the repository holding the
// comparison baseline. Two independent causes:
//
//   1. The iteration budget was CONFIGURED (llm-settings.json modelOverrides: glm-5.2 -> 120) but
//      that config is applied in claude.sh's story-invocation path. Discovery spawns ai-run.sh
//      directly, so it never saw it, and AgentRunner's `?? 20` governed. The call died at 20 with
//      "Agent reached maximum iterations (20) without completing." — 8 candidate repos needing
//      ~3 tool calls each cannot be examined in 20.
//   2. EPAM_ONLY_CODELINES was only ever a LANE filter, applied after discovery had already
//      chosen. The operator named the scope before launch and the producer never saw it.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const registry = require(join(ROOT, 'orchestrations/agents/invocation-profiles.json'));

describe('the discovery seam is given an iteration budget', () => {
  const CANDIDATE_CAP = 8; // scoreRepos(issues, manifest, 8, vocabulary)

  it('declares maxIterations, so it does not inherit the engine default', () => {
    const p = registry.profiles['codeline-discovery'];
    expect(p, 'the codeline-discovery profile is missing entirely').toBeTruthy();
    expect(p.maxIterations, 'unset — the seam silently inherits AgentRunner\'s `?? 20`').not.toBeUndefined();
    expect(p.maxIterations, 'unset — the seam silently inherits AgentRunner\'s `?? 20`').not.toBeNull();
  });

  it('the budget covers examining every candidate it is handed', () => {
    const p = registry.profiles['codeline-discovery'];
    // It is handed CANDIDATE_CAP repos and must look at each: list the tree, read the manifest,
    // and search for the ticket's technology — three calls minimum — then still have a turn left
    // to answer. A budget under that guarantees the exhaustion this test exists for.
    //
    // The floor MUST exclude 20. An earlier version of this test used cap*2+1 = 17, which the
    // live failing value of 20 passed: the test would have ratified the exact defect it was
    // written for. Verified by mutation, not by reading it.
    const FLOOR = CANDIDATE_CAP * 3 + 1;
    expect(FLOOR, 'the floor must reject 20, the value that failed live').toBeGreaterThan(20);
    expect(p.maxIterations).toBeGreaterThanOrEqual(FLOOR);
  });

  it('seamInvocationEnv actually EMITS it — a declaration nothing reads is the recurring defect', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { seamInvocationEnv } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));
    const env = seamInvocationEnv('codeline-discovery');
    expect(env.EPAM_MAX_ITERATIONS, 'declared in the registry but never reaches the agent')
      .toBe(String(registry.profiles['codeline-discovery'].maxIterations));
  });
});

describe('the operator\'s codeline scope constrains DISCOVERY, not just the lanes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const disco = require(join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'));

  // Synthetic repos: the rule must hold for any naming convention, not this client's.
  const manifest = [
    { name: 'next.alpha.com', path: '/repos/next.alpha.com' },
    { name: 'next.beta.com', path: '/repos/next.beta.com' },
    { name: 'azure.alpha.com', path: '/repos/azure.alpha.com' },
    { name: 'gamma-service', path: '/repos/gamma-service' },
  ];

  it('exports the constraint so it can be executed, not just inspected', () => {
    expect(typeof disco.constrainToRequestedCodelines).toBe('function');
  });

  it('unset scope changes nothing — today\'s run stays byte-for-byte today\'s run', () => {
    expect(disco.constrainToRequestedCodelines(manifest, '')).toEqual(manifest);
    expect(disco.constrainToRequestedCodelines(manifest, undefined)).toEqual(manifest);
  });

  it('keeps only repos whose DERIVED codeline name matches, the same name the lane selector uses', () => {
    // 'alpha' is the derived name of BOTH next.alpha.com and azure.alpha.com — decoration is
    // stripped — so naming alpha keeps both and drops the rest.
    const got = disco.constrainToRequestedCodelines(manifest, 'alpha').map((r: any) => r.name).sort();
    expect(got).toEqual(['azure.alpha.com', 'next.alpha.com']);
  });

  it('matches on the derived name, NEVER on the directory string', () => {
    // The preflight reset matched by substring and would have swept every *alpha* directory.
    // 'alph' is a substring of both alpha directories and must match neither.
    expect(disco.constrainToRequestedCodelines(manifest, 'alph')).toEqual([]);
  });

  it('accepts the comma/pipe separated form the launcher already uses', () => {
    const got = disco.constrainToRequestedCodelines(manifest, 'alpha,gammaservice').map((r: any) => r.name);
    expect(got).toContain('gamma-service');
    expect(got).toContain('next.alpha.com');
  });

  it('an unmatched scope yields NOTHING, so the run stops rather than guessing', () => {
    // Failing open here would run every codeline when the operator asked for one — the expensive
    // direction of a typo, and exactly how this incident selected a repo nobody named.
    expect(disco.constrainToRequestedCodelines(manifest, 'nosuchcodeline')).toEqual([]);
  });
});
