/**
 * A PREFLIGHT CANNOT DEMAND WHAT THE MINT HAS NOT PRODUCED YET.
 *
 * Rosters are ephemeral by design: a FRESH run clears the generated registries and
 * restores agents/profiles.json from profiles.json.original, and the MINT then produces
 * this run's roles and assigns them. A RESUME keeps the roster it is resuming with.
 *
 * The launcher's preflight checks every story's agentRole against profiles.json — at
 * line 214. The mint runs at line 297. So on a fresh run the check compares the PRD's
 * role, minted by a PREVIOUS run, against the canonical BASE roster that the reset just
 * restored. It cannot match, and the launch is refused for a state the very next step
 * would have fixed.
 *
 * Live, 2026-08-14:
 *
 *     ✗ [preflight] agentRole names a role the roster does not contain:
 *                   AMSD-2041 -> contentstack-live-preview-integration-engineer
 *
 * The mint then produced `contentstack-live-preview-engineer` on the following launch
 * and the run completed. The check was right about the fact and wrong about the moment.
 *
 * The requirement is not "drop the check" — it caught a real class (a resume whose PRD
 * names a role no roster contains, where nothing downstream will ever assign one). It is
 * that the check must know whether the mint is about to run.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/agent-role-preflight.sh');

function check(role: string | null, rosterRoles: string[], mintWillRun: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'role-pre-'));
  try {
    const prd = join(dir, 'prd.json');
    const story: Record<string, unknown> = { id: 'AMSD-2041', title: 't' };
    if (role !== null) story.agentRole = role;
    writeFileSync(prd, JSON.stringify({ stories: [story] }));

    const profiles = join(dir, 'profiles.json');
    writeFileSync(profiles, JSON.stringify(Object.fromEntries(rosterRoles.map((r) => [r, {}]))));

    const res = spawnSync('bash', ['-c',
      `. ${JSON.stringify(LIB)}; agent_roles_resolve ${JSON.stringify(prd)} ${JSON.stringify(profiles)} ${mintWillRun ? '1' : '0'}`,
    ], { encoding: 'utf8' });
    return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent_roles_resolve', () => {
  it('PASSES when the role is in the roster, mint or no mint', () => {
    expect(check('known-role', ['known-role'], false).status).toBe(0);
    expect(check('known-role', ['known-role'], true).status).toBe(0);
  });

  it('PASSES an unknown role when the mint is about to run — it will assign one', () => {
    // The live shape: the PRD carries a role a previous run minted, the reset has
    // restored the base roster, and the mint is the very next step.
    const r = check('a-role-a-previous-run-minted', ['base-role'], true);
    expect(r.status, `refused a launch the mint would have fixed:\n${r.out}`).toBe(0);
    // Silence would be wrong too — the operator should see why it was allowed.
    expect(r.out).toMatch(/mint/i);
  });

  it('FAILS an unknown role when the mint is SKIPPED — nothing will ever assign one', () => {
    // A resume keeps its roster, so an unmatched role stays unmatched and the writer runs
    // as the generic archetype, unbound by the specialist brief.
    const r = check('a-role-nothing-will-mint', ['base-role'], false);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('a-role-nothing-will-mint');
    expect(r.out).toContain('AMSD-2041');
  });

  it('FAILS a story with no agentRole when the mint is skipped', () => {
    const r = check(null, ['base-role'], false);
    expect(r.status).not.toBe(0);
  });

  it('reports UNKNOWN, never a pass, when the roster cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-pre-none-'));
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S1', agentRole: 'x' }] }));
    const res = spawnSync('bash', ['-c',
      `. ${JSON.stringify(LIB)}; agent_roles_resolve ${JSON.stringify(prd)} /nonexistent/profiles.json 0`,
    ], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    expect(res.status).not.toBe(0);
    expect((res.stdout || '') + (res.stderr || '')).toMatch(/cannot|unknown/i);
  });
});

describe('the launcher uses the shared check rather than its own copy', () => {
  it('tier3-metrolinx-run.sh calls agent_roles_resolve', () => {
    // The inline copy compared against profiles.json with no notion of whether the mint
    // was about to run. Two copies of a rule is one defect waiting.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
    expect(src).toMatch(/agent_roles_resolve/);
  });
});
