/**
 * A STORY WITH NO ROLE MUST STOP THE PHASE, NOT RUN AS "unknown".
 *
 * synthesize-prd-from-jira.js defers agentRole to null — at synthesis nothing has analysed
 * the codeline, so there is no roster to choose from. assignAgentRoles() fills it after
 * minting. Between those two points a null is correct; past the second it is a defect.
 *
 * Nothing downstream would say so. Fifteen consumers read the field as
 * `.agentRole // "unknown"` or `// ""`, so an unassigned story does not error anywhere —
 * it is handed to the writer with an empty system prompt, does poor work for reasons
 * nobody can see, and the run completes. That is the exact shape of the defect this whole
 * change exists to remove: the pipeline substituting a plausible value for a missing one.
 *
 * This guard is the single place that refuses, rather than 15 patched call sites.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GUARDS = join(__dirname, '../../../orchestrations/scripts/lib/story-guards.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL guard against a PRD fixture. */
function guard(stories: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'role-guard-')); dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: (stories as any[]).map(s => s.id) },
    stories,
  }));
  const res = spawnSync('bash', ['-c',
    `set +e; source ${JSON.stringify(GUARDS)} >/dev/null 2>&1; ` +
    `assert_phase_stories_have_roles ${JSON.stringify(prd)} core; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/RC=(\d+)/);
  return { rc: m ? Number(m[1]) : -1, out };
}

const OK = { id: 'A-1', agentRole: 'some-domain-engineer' };

describe('the harness is real', () => {
  it('a fully assigned phase passes', () => {
    const r = guard([OK, { id: 'A-2', agentRole: 'another-specialist' }]);
    expect(r.rc, `expected pass, got:\n${r.out}`).toBe(0);
  });
});

describe('an unassigned story halts the phase', () => {
  it('a null agentRole fails', () => {
    const r = guard([OK, { id: 'A-2', agentRole: null }]);
    expect(r.rc, 'a story with no role was allowed to run as "unknown"').not.toBe(0);
  });

  it('a missing agentRole key fails', () => {
    const r = guard([OK, { id: 'A-2' }]);
    expect(r.rc).not.toBe(0);
  });

  it('an empty-string agentRole fails', () => {
    const r = guard([OK, { id: 'A-2', agentRole: '' }]);
    expect(r.rc).not.toBe(0);
  });

  it('the literal "unknown" fails — that is the substituted value, not a real role', () => {
    const r = guard([OK, { id: 'A-2', agentRole: 'unknown' }]);
    expect(r.rc).not.toBe(0);
  });

  it('it NAMES the offending story, so the failure is actionable', () => {
    const r = guard([OK, { id: 'A-2', agentRole: null }]);
    expect(r.out).toMatch(/A-2/);
    expect(r.out, 'the assigned story was named as if it were the problem').not.toMatch(/\bA-1\b/);
  });
});

describe('scope', () => {
  it('a story outside the phase does not halt it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-guard-scope-')); dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      implementationOrder: { core: ['A-1'] },
      stories: [OK, { id: 'OTHER', agentRole: null }],
    }));
    const res = spawnSync('bash', ['-c',
      `set +e; source ${JSON.stringify(GUARDS)} >/dev/null 2>&1; ` +
      `assert_phase_stories_have_roles ${JSON.stringify(prd)} core; echo "RC=$?"`,
    ], { encoding: 'utf8' });
    expect(((res.stdout || '') + (res.stderr || '')).match(/RC=(\d+)/)?.[1]).toBe('0');
  });
});
