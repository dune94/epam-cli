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

    // eslint-disable-next-line no-new-func
    return new Function('fs', 'path', 'process', 'projectConfigDir', `
      ${body}
      return _skipProvisioning;
    `)(require('node:fs'), require('node:path'),
       { env: { EPAM_RESUME_RUN: opts.resume || '', EPAM_CODELINE_ID: opts.codeline || '' },
         stderr: { write: () => {} } },
       cfg) as boolean;
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

/**
 * THE MINT HALF. The same signal must also stop the mint, or the run still pays for a
 * roster-specialiser call ($1.44 on the 2026-09-05 run) to re-derive agents it already has.
 *
 * Implemented by SETTING EPAM_SKIP_AGENT_MINT rather than adding a branch: that flag already has
 * gates in mint-agents-step.js (decline the mint), run-agent-orchestration.sh (roster-only, which
 * refuses when there is no roster to skip to) and pre-run-reset.sh. One place to set, three
 * already-exercised paths to honour it.
 */
describe('the mint is skipped for a completed codeline', () => {
  function mintFlagAfterGuard(opts: { codeline: string; marker: string | null; prompts: number;
    already?: string; regen?: string }) {
    const root = mkdtempSync(join(tmpdir(), 'mintgate-'));
    try {
      const cfg = join(root, 'metrolinx');
      mkdirSync(join(cfg, 'prompts'), { recursive: true });
      mkdirSync(join(cfg, '.prompt-cache'), { recursive: true });
      for (let i = 0; i < opts.prompts; i++) writeFileSync(join(cfg, 'prompts', `p${i}.json`), '{}');
      if (opts.marker) writeFileSync(join(cfg, '.prompt-cache', `.complete-${opts.marker}`), '');

      const src = readFileSync(join(__dirname,
        '../../../orchestrations/scripts/mint-agents-step.js'), 'utf8');
      const start = src.indexOf('const _clId =');
      const end = src.indexOf('const sameRun =', start);
      if (start < 0 || end < 0) throw new Error('mint guard not found — harness is stale');

      const env: Record<string, string> = {
        EPAM_CODELINE_ID: opts.codeline,
        EPAM_PROJECT_CONFIG_DIR: cfg,
        ...(opts.already ? { EPAM_SKIP_AGENT_MINT: opts.already } : {}),
        ...(opts.regen ? { EPAM_REGENERATE_CODELINE_ASSETS: opts.regen } : {}),
      };
      // eslint-disable-next-line no-new-func
      new Function('fs', 'path', 'process', src.slice(start, end))(
        require('node:fs'), require('node:path'), { env, stderr: { write: () => {} } });
      return env.EPAM_SKIP_AGENT_MINT;
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('marker + prompts on disk -> the mint is skipped', () => {
    expect(mintFlagAfterGuard({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com', prompts: 41 }),
      'the mint still runs, so the run pays a roster-specialiser call to re-derive 49 agents it has')
      .toBe('1');
  });

  it('NO marker -> the mint still runs', () => {
    expect(mintFlagAfterGuard({ codeline: 'next.gotransit.com', marker: null, prompts: 41 }))
      .toBeUndefined();
  });

  it('marker for another codeline -> the mint still runs', () => {
    expect(mintFlagAfterGuard({ codeline: 'next.gotransit.com', marker: 'next.upexpress.com', prompts: 41 }))
      .toBeUndefined();
  });

  it('marker but no prompts on disk -> the mint still runs', () => {
    expect(mintFlagAfterGuard({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com', prompts: 0 }))
      .toBeUndefined();
  });

  it('OVERRIDE forces the mint even with a marker', () => {
    expect(mintFlagAfterGuard({ codeline: 'next.gotransit.com', marker: 'next.gotransit.com',
      prompts: 41, regen: '1' }),
      'EPAM_REGENERATE_CODELINE_ASSETS=1 did not force a re-mint — the cache would be a trap')
      .toBeUndefined();
  });

  it('no codeline declared -> the mint still runs', () => {
    expect(mintFlagAfterGuard({ codeline: '', marker: 'next.gotransit.com', prompts: 41 }))
      .toBeUndefined();
  });
});
