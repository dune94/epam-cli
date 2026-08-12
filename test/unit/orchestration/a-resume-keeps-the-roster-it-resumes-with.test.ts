/**
 * A RESUME KEEPS THE ROSTER IT IS RESUMING WITH — ALL OF IT, NOT MOST OF IT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * pre-run-reset.sh resets the roster in TWO places, and only ONE of them knows about resumes:
 *
 *   1. the generated-roster clearing (project-roles / project-investigators / agent-profiles),
 *      which IS exempted:
 *          if [ -n "${EPAM_RESUME_RUN:-}" ]; then _PROJECT_CFG_DIR=""
 *          info "  Resuming ... — keeping the roster this run already minted and reviewed"
 *
 *   2. the canonical restore of agents/profiles.json, which is NOT:
 *          cp "$_AGENTS_DIR/profiles.json.original" "$_AGENTS_DIR/profiles.json"
 *          info "  Roster restored from canonical original — generated agents ... are gone"
 *
 * Live 2026-08-12, both lines printed seconds apart in the same reset, in this order:
 *
 *     Resuming 20260809T045158Z — keeping the roster this run already minted and reviewed
 *     Roster restored from canonical original — generated agents from prior runs are gone
 *
 * The run then died at assignment: "Agent mint/assignment failed — refusing to run stories with
 * no assigned agent." The mint had correctly skipped itself ("resumed roster — reviewed in the
 * run being resumed, not re-reviewed here") against a roster that no longer existed.
 *
 * This is the single-point-of-maintenance defect exactly: ONE rule ("a resume keeps its
 * roster"), TWO places that implement roster resetting, and only one of them was taught it.
 * The pause exists so a human can approve a roster; a resume that discards it makes the pause
 * ceremonial — which is the same conclusion 879c705 reached for the OTHER block, and it was
 * fixed there only.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');

const MINTED = '{"profiles":[{"role":"a-minted-role-the-operator-reviewed"}]}\n';
const CANONICAL = '{"profiles":[]}\n';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL reset against a throwaway agents dir. Returns profiles.json afterwards. */
function reset(env: Record<string, string>): { profiles: string; out: string } {
  const d = mkdtempSync(join(tmpdir(), 'resume-roster-')); dirs.push(d);
  const agents = join(d, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'profiles.json'), MINTED);
  writeFileSync(join(agents, 'profiles.json.original'), CANONICAL);

  const logDir = join(d, 'logs');
  mkdirSync(logDir, { recursive: true });

  const r = spawnSync('bash', [RESET, '--prd', join(d, 'no-such-prd.json'), '--log-dir', logDir], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      EPAM_AGENTS_DIR: agents,
      // Keep the reset off the repo's own git-tracked dashboard state.
      COMPOSE_OVERRIDE: join(d, 'compose-override.yml'),
      DASHBOARD_STATE_DIR: d,
      ...env,
    },
  });
  return { profiles: readFileSync(join(agents, 'profiles.json'), 'utf8'), out: (r.stdout || '') + (r.stderr || '') };
}

describe('the harness is real — a fresh run STILL resets the roster', () => {
  it('without EPAM_RESUME_RUN the canonical restore happens, exactly as before', () => {
    // If this ever goes green-by-accident the test below proves nothing: it would be asserting
    // that a restore which never runs did not run.
    const { profiles } = reset({});
    expect(profiles, 'the ephemeral-roster rule is broken — a fresh run must start from canonical')
      .toBe(CANONICAL);
  });
});

describe('THE DEFECT: A RESUME LOST THE ROSTER IT SAID IT WAS KEEPING', () => {
  it('EPAM_RESUME_RUN preserves the minted roster', () => {
    const { profiles } = reset({ EPAM_RESUME_RUN: '20260809T045158Z' });
    expect(profiles, 'the reviewed roster was overwritten from canonical during a resume')
      .toBe(MINTED);
  });

  it('and it does not claim to have restored one', () => {
    // The two contradictory log lines are how this stayed invisible: the operator was told the
    // roster was kept AND that it was replaced, in the same reset, and only the second was true.
    const { out } = reset({ EPAM_RESUME_RUN: '20260809T045158Z' });
    expect(out, 'the reset still announces a canonical restore during a resume')
      .not.toMatch(/Roster restored from canonical original/);
  });

  it('the resume decision is made ONCE, not re-derived per block', () => {
    // Single point of maintenance. Two blocks each testing EPAM_RESUME_RUN independently is the
    // same shape that produced this defect; the next roster reset added would miss it again.
    const src = readFileSync(RESET, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const tests = code.match(/\[ -n "\$\{EPAM_RESUME_RUN:-\}" \]/g) || [];
    expect(tests.length, 'EPAM_RESUME_RUN is tested in several places instead of once')
      .toBeLessThanOrEqual(1);
  });
});
