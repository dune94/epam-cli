/**
 * Live defect (found 2026-07-13, tier3-travel-app run): after scaffold phase
 * completed cleanly (GO decision), the pipeline's transition into 'core'
 * hard-failed at "Pre-phase PRD remediation" with 3 findings and aborted
 * with "Fix prd.json manually" — no fix attempt, despite this session
 * having built self-heal infrastructure for exactly this kind of gate
 * elsewhere already. Two distinct root causes, both fixed here:
 *
 * 1. preflight-prd-integrity.sh's checks #9 (.test.ts stories must use
 *    qwen not minimax), #10 (clean pending state), and #17 (testCriteria
 *    field present) all scanned `active_ids` — the union of EVERY phase's
 *    implementationOrder, not just the phase actually being validated. Once
 *    scaffold's SKY-001 legitimately became status=completed, check #10
 *    flagged it FOREVER on every subsequent phase's remediation call — no
 *    pipeline could ever complete a second phase. Fix: an optional --phase
 *    flag scopes those three checks to just that phase's own
 *    implementationOrder.
 *
 * 2. _prd_remediate_impl.py had no repair step for provider/model
 *    misalignment (stale aiProvider=minimax survived multiple `git
 *    checkout` restores tonight, since checkout only restores to whatever
 *    was last COMMITTED, itself already contaminated from an earlier,
 *    pre-tonight run) or for a missing testCriteria schema stub — both
 *    conditions preflight-prd-integrity.sh already detected but nothing
 *    ever fixed. Fix: two new idempotent steps that repair provider/model
 *    from the canonical PRD (config-driven — canonical decides the correct
 *    value, the engine has no hardcoded opinion) and stub testCriteria.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PREFLIGHT_SH = join(REPO_ROOT, 'orchestrations/scripts/preflight-prd-integrity.sh');
const IMPL_PY = join(REPO_ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');
const REMEDIATE_SH = join(REPO_ROOT, 'orchestrations/scripts/prd-remediate.sh');

// Mirrors the exact live shape: scaffold's SKY-001 already completed, core's
// own SKY-002/003/004 still pending but carrying stale minimax provider data
// and no testCriteria — exactly what survived multiple git-checkout restores.
function liveFixture() {
  return {
    project: { outputDir: '/tmp/skyscanner-fixture-app' },
    implementationOrder: {
      scaffold: ['SKY-001'],
      core: ['SKY-002', 'SKY-003', 'SKY-004'],
    },
    stories: [
      {
        id: 'SKY-001',
        status: 'completed',
        completed: true,
        effort: 'medium',
        aiProvider: 'qwen',
        model: 'moonshotai/kimi-k2',
        acceptanceCriteria: ['a'],
        technicalNotes: { files: ['/tmp/skyscanner-fixture-app/src/index.ts'] },
      },
      {
        id: 'SKY-002',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'minimax',
        model: 'MiniMax-M3',
        acceptanceCriteria: ['a'],
        specification: { createdFrom: 'SKY-002' },
        technicalNotes: { files: ['/tmp/skyscanner-fixture-app/src/client.test.ts'] },
      },
      {
        id: 'SKY-003',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'minimax',
        model: 'MiniMax-M3',
        acceptanceCriteria: ['a'],
        technicalNotes: { files: ['/tmp/skyscanner-fixture-app/src/cli.test.ts'] },
      },
      {
        id: 'SKY-004',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'minimax',
        model: 'MiniMax-M3',
        acceptanceCriteria: ['a'],
        technicalNotes: { files: ['/tmp/skyscanner-fixture-app/src/server.test.ts'] },
      },
    ],
  };
}

function canonicalCounterpart() {
  return {
    stories: [
      { id: 'SKY-002', aiProvider: 'qwen', model: 'moonshotai/kimi-k2' },
      { id: 'SKY-003', aiProvider: 'qwen', model: 'moonshotai/kimi-k2' },
      { id: 'SKY-004', aiProvider: 'qwen', model: 'moonshotai/kimi-k2' },
    ],
  };
}

describe('preflight-prd-integrity.sh --phase — scopes checks #9/#10/#17 to one phase', () => {
  function run(prd: object, phase?: string): { code: number; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-phase-scope-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(prd));
    try {
      const args = [PREFLIGHT_SH, '--prd', prdPath];
      if (phase) args.push('--phase', phase);
      const stdout = execFileSync('bash', args, { encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (e: any) {
      return { code: e.status ?? 1, stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the live failure: without --phase, a completed prior-phase story (SKY-001) fails check #10 forever', () => {
    const result = run(liveFixture());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Active stories not in clean pending state.*SKY-001/);
  });

  it('FIX: with --phase core, SKY-001 (scaffold, completed) no longer fails check #10', () => {
    const result = run(liveFixture(), 'core');
    expect(result.stdout).not.toMatch(/SKY-001\(status=completed/);
  });

  it('with --phase core, check #9/#17 still correctly flag core\'s OWN genuinely-bad stories (minimax .test.ts, missing testCriteria)', () => {
    const result = run(liveFixture(), 'core');
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/\.test\.ts active stories using minimax/);
    expect(result.stdout).toMatch(/Test stories missing testCriteria field/);
    for (const id of ['SKY-002', 'SKY-003', 'SKY-004']) {
      expect(result.stdout).toContain(id);
    }
  });

  it('with --phase scaffold, core\'s own bad stories are NOT flagged (out of scope for this phase)', () => {
    const result = run(liveFixture(), 'scaffold');
    expect(result.stdout).not.toMatch(/using minimax/);
    expect(result.stdout).not.toMatch(/missing testCriteria field/);
  });

  it('without --phase (default), behavior is unchanged from before this fix — still checks the full union', () => {
    const result = run(liveFixture());
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/using minimax/);
  });
});

describe('_prd_remediate_impl.py — repairs provider/model from canonical (REAL execution)', () => {
  function run(prd: object, canonical: object | null, phase?: string): { prd: any; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-repair-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(prd));
    if (canonical) {
      writeFileSync(join(dir, 'prd.canonical.json'), JSON.stringify(canonical));
    }
    try {
      const args = phase ? [IMPL_PY, prdPath, phase] : [IMPL_PY, prdPath];
      const stdout = execFileSync('python3', args, { encoding: 'utf8' });
      return { prd: JSON.parse(readFileSync(prdPath, 'utf8')), stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES + FIXES: a .test.ts story on minimax is repaired to canonical\'s provider/model', () => {
    const { prd, stdout } = run(liveFixture(), canonicalCounterpart(), 'core');
    const byId = Object.fromEntries(prd.stories.map((s: any) => [s.id, s]));
    expect(byId['SKY-002'].aiProvider).toBe('qwen');
    expect(byId['SKY-002'].model).toBe('moonshotai/kimi-k2');
    expect(byId['SKY-003'].aiProvider).toBe('qwen');
    expect(byId['SKY-004'].aiProvider).toBe('qwen');
    expect(stdout).toMatch(/repaired provider\/model misalignment from canonical/);
  });

  it('does NOT touch a prior-phase story (SKY-001) even though canonical also has it', () => {
    const { prd } = run(liveFixture(), canonicalCounterpart(), 'core');
    const sky001 = prd.stories.find((s: any) => s.id === 'SKY-001');
    expect(sky001.aiProvider).toBe('qwen'); // was already correct/untouched
    expect(sky001.status).toBe('completed'); // untouched by step 6's reset too
  });

  it('adds a testCriteria stub to .test.ts stories missing the field', () => {
    const { prd, stdout } = run(liveFixture(), canonicalCounterpart(), 'core');
    const byId = Object.fromEntries(prd.stories.map((s: any) => [s.id, s]));
    for (const id of ['SKY-002', 'SKY-003', 'SKY-004']) {
      expect(byId[id].testCriteria).toEqual({
        facts: [],
        sourceFiles: [],
        mockStrategy: '',
        bannedPatterns: [],
        implStory: null,
      });
    }
    expect(stdout).toMatch(/added testCriteria stub to 3 stor\(y\/ies\)/);
  });

  it('after remediation, preflight-prd-integrity.sh --phase core now passes clean (end-to-end self-heal)', () => {
    const { prd } = run(liveFixture(), canonicalCounterpart(), 'core');
    const dir = mkdtempSync(join(tmpdir(), 'preflight-post-remediate-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(prd));
    try {
      const stdout = execFileSync('bash', [PREFLIGHT_SH, '--prd', prdPath, '--phase', 'core'], { encoding: 'utf8' });
      expect(stdout).toMatch(/PRD integrity OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT silently repair a story that is NOT in canonical at all (no safe value to copy from — leave for a human)', () => {
    const prd = liveFixture();
    prd.stories.push({
      id: 'SKY-999',
      status: 'pending',
      completed: false,
      effort: 'medium',
      aiProvider: 'minimax',
      model: 'MiniMax-M3',
      acceptanceCriteria: ['a'],
      technicalNotes: { files: ['/tmp/skyscanner-fixture-app/src/other.test.ts'] },
    } as any);
    (prd.implementationOrder.core as string[]).push('SKY-999');
    const { prd: after } = run(prd, canonicalCounterpart(), 'core');
    const extra = after.stories.find((s: any) => s.id === 'SKY-999');
    expect(extra.aiProvider).toBe('minimax'); // left alone, not guessed at
  });

  it('is a no-op (no crash, no changes) when no canonical file exists alongside the PRD', () => {
    const { prd, stdout } = run(liveFixture(), null, 'core');
    const byId = Object.fromEntries(prd.stories.map((s: any) => [s.id, s]));
    expect(byId['SKY-002'].aiProvider).toBe('minimax'); // unrepaired, no canonical to copy from
    expect(stdout).not.toMatch(/repaired provider\/model/);
  });

  it('is idempotent: running twice produces no further changes the second time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-idempotent-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify(liveFixture()));
    writeFileSync(join(dir, 'prd.canonical.json'), JSON.stringify(canonicalCounterpart()));
    try {
      execFileSync('python3', [IMPL_PY, prdPath, 'core'], { encoding: 'utf8' });
      const secondRun = execFileSync('python3', [IMPL_PY, prdPath, 'core'], { encoding: 'utf8' });
      expect(secondRun).toMatch(/no changes needed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prd-remediate.sh — forwards --phase to preflight-prd-integrity.sh', () => {
  const src = readFileSync(REMEDIATE_SH, 'utf8');

  it('the preflight call includes --phase when $PHASE is set', () => {
    expect(src).toMatch(/preflight-prd-integrity\.sh"\s+--prd\s+"\$PRD_FILE"\s+\$\{PHASE:\+--phase\s+"\$PHASE"\}/);
  });
});
