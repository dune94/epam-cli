/**
 * A CODELINE WHOSE PROMPTS ARE COMPLETE DOES NOT RE-PROVISION THEM.
 *
 * Operator, 2026-09-06: "mint should not run nor prompt builder", "no regeneration if profiles
 * mint prompts".
 *
 * The skip already exists in mint-agents-step.js and its comment already argues the principle:
 *
 *   "PROMPTS ARE PROVISIONED ONCE, BEFORE PAUSE 1. A RESUME NEVER REBUILDS THEM."
 *   "THE INSTALLED PROMPTS ARE THE SIGNAL ... NOT A CACHE, A SKIP."
 *
 * It was gated on EPAM_RESUME_RUN alone, so a FRESH run against a codeline whose prompts are
 * already complete rebuilt all 39 — which is what the live 2026-09-06 run did.
 *
 * WHY A CACHE CANNOT COVER THIS, from that same comment: the cache key includes mintedRoles, and
 * a run that does not mint passes the literal '(none minted this run)'. Measured on the
 * 2026-09-02 resume: "roles digest 1dad7a5a... at pause 1 against cba40c8d... on the resume, 9
 * entries reused and 30 rebuilt, for prompts already sitting complete on disk." So the answer is
 * to not run the builder at all, not to make the cache cleverer.
 *
 * THE SIGNAL IS THE SAME ONE pre-run-reset ALREADY TRUSTS: .prompt-cache/.complete-<codeline>,
 * written only after every prompt installed, cleared at the start of provisioning, and named for
 * the codeline so one codeline's set cannot serve another.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/mint-agents-step.js'), 'utf8');

/** The real guard, lifted and driven — not a reimplementation of its logic. */
function skipsProvisioning(opts: {
  resume?: string; codeline?: string; installed: number; marker?: string | null;
  /** The run's RESOLVED scope, which is where a live run's codeline actually comes from. */
  prdCodelines?: string[];
}) {
  const root = mkdtempSync(join(tmpdir(), 'reprov-'));
  try {
    const cfg = join(root, 'metrolinx');
    mkdirSync(join(cfg, 'prompts'), { recursive: true });
    mkdirSync(join(cfg, '.prompt-cache'), { recursive: true });
    for (let i = 0; i < opts.installed; i++) writeFileSync(join(cfg, 'prompts', `p${i}.json`), '{}');
    if (opts.marker) writeFileSync(join(cfg, '.prompt-cache', `.complete-${opts.marker}`), '');

    const start = SRC.indexOf('let _skipProvisioning = false;');
    const end = SRC.indexOf('const promptMode =', start);
    if (start < 0 || end < 0) throw new Error('guard block not found — harness is stale');
    const body = SRC.slice(start, end);

    // THE PRD IS WHERE A LIVE RUN'S CODELINE IS. EPAM_CODELINE_ID is set by no launcher, config
    // or env file in this repo, so a guard keyed on it alone could never fire in a live run.
    const prd = join(root, 'prd.json');
    writeFileSync(prd, JSON.stringify(opts.prdCodelines
      ? { project: { outputDirs: opts.prdCodelines.map((c) => ({ path: `/codelines/${c}` })) } }
      : {}));

    // The REAL derivation, not a stand-in: the same function the prompt builder keys its cache
    // with, so this test cannot pass on a copy that has drifted from it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { codelineFromPrd } = require(join(__dirname,
      '../../../orchestrations/scripts/lib/project-prompt-builder.js'));

    // eslint-disable-next-line no-new-func
    return new Function('fs', 'path', 'process', 'projectConfigDir', 'codelineFromPrd', 'PRD_PATH', `
      ${body}
      return _skipProvisioning;
    `)(require('node:fs'), require('node:path'),
       { env: { EPAM_RESUME_RUN: opts.resume || '', EPAM_CODELINE_ID: opts.codeline || '' },
         stderr: { write: () => {} } },
       cfg, codelineFromPrd, prd) as boolean;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('provisioning is skipped when this codeline already completed it', () => {
  it('FRESH run + marker + installed prompts -> SKIPPED', () => {
    expect(skipsProvisioning({ codeline: 'next.gotransit.com', installed: 41, marker: 'next.gotransit.com' }), [
      'a fresh run re-provisioned 41 prompts that were already complete for this codeline.',
      'The cache cannot absorb this: a run that does not mint passes "(none minted this run)"',
      'as mintedRoles, so every roster-dependent entry misses by construction.',
    ].join('\n')).toBe(true);
  });

  it('resume + installed prompts -> still SKIPPED (unchanged behaviour)', () => {
    expect(skipsProvisioning({ resume: '20260905T172837Z', installed: 41 }),
      'the existing resume skip regressed').toBe(true);
  });

  it('NO marker -> provisions, exactly as today', () => {
    expect(skipsProvisioning({ codeline: 'next.gotransit.com', installed: 41, marker: null }),
      'prompts were skipped with nothing declaring them complete').toBe(false);
  });

  it('marker for ANOTHER codeline -> provisions', () => {
    expect(skipsProvisioning({ codeline: 'next.gotransit.com', installed: 41, marker: 'next.upexpress.com' }),
      "another codeline's completion was accepted for this one").toBe(false);
  });

  it('marker but NO prompts on disk -> provisions', () => {
    expect(skipsProvisioning({ codeline: 'next.gotransit.com', installed: 0, marker: 'next.gotransit.com' }),
      'a marker with an empty prompts dir skipped provisioning, leaving the run with none').toBe(false);
  });

  it('no codeline declared -> provisions', () => {
    expect(skipsProvisioning({ codeline: '', installed: 41, marker: 'next.gotransit.com' }),
      'provisioning was skipped without a codeline to match the marker against').toBe(false);
  });
});

describe('the codeline comes from the run, not from a variable nobody sets', () => {
  /**
   * The live-run case, and the reason the reuse machinery never once paid off: with
   * EPAM_CODELINE_ID absent this guard saw no codeline, so all 41 prompts were re-provisioned on
   * every run while .complete-next.gotransit.com sat correct on disk beside them.
   */
  it('SKIPS with no EPAM_CODELINE_ID when the PRD resolves the completed codeline', () => {
    expect(skipsProvisioning({
      codeline: '', marker: 'next.gotransit.com', installed: 41,
      prdCodelines: ['next.gotransit.com'],
    }), 'provisioning ran for a codeline that had already completed it — 41 prompts re-installed '
      + 'and every cache miss paid for again').toBe(true);
  });

  it('PROVISIONS when the PRD resolves a DIFFERENT codeline than the marker names', () => {
    expect(skipsProvisioning({
      codeline: '', marker: 'next.upexpress.com', installed: 41,
      prdCodelines: ['next.gotransit.com'],
    }), 'another codeline\'s completion was accepted as this one\'s').toBe(false);
  });

  it('PROVISIONS when the PRD resolves TWO codelines — neither is attributable', () => {
    expect(skipsProvisioning({
      codeline: '', marker: 'next.gotransit.com', installed: 41,
      prdCodelines: ['next.gotransit.com', 'next.upexpress.com'],
    })).toBe(false);
  });

  it('PROVISIONS when the marker names the codeline but NO prompts are installed', () => {
    expect(skipsProvisioning({
      codeline: '', marker: 'next.gotransit.com', installed: 0,
      prdCodelines: ['next.gotransit.com'],
    }), 'a marker beside an empty prompts directory was trusted').toBe(false);
  });
});
