/**
 * A LAUNCHER THAT LOADED THE PROJECT AND RESET NOTHING.
 *
 * tier3-run.sh is the generic, project-driven launcher: it loads config.env and refuses to start
 * without the loader, which is why it is the one to use. It never called pre-run-reset. Its own
 * comment block claims the opposite ("one gate, lib/pre-run-reset-gate.sh, for all launchers").
 *
 * Live 2026-08-18 run 20260818T095717Z died of it. The previous run's state was still on disk:
 *
 *   PRD agentRole:  typescript-logic-fixer   (canonical says null)
 *   profiles.json:  the previous run's three minted agents
 *
 * so this run minted a NEW implementer, its two investigators collided by name with the
 * leftovers and were dropped as "unchanged" — "no investigator minted for codeline mocka, it
 * will use the canonical detective" — and the assignment gate then refused the run outright:
 *
 *   [assign] MOCK3-1 was assigned "typescript-logic-fixer", which is not in the roster — it has
 *   no profile entry, so the writer would run with an empty system prompt.
 *
 * THE GATE WAS NEVER THE PROBLEM. pre-run-reset restores the PRD from canonical and the roster
 * from its original, and a guard test already proves it does. Nothing proved a LAUNCHER calls it.
 * That is the same hole as the write perimeter (sealing lived in one launcher of eight) and the
 * pre-flight gates before it (two of eight): a step that works, wired into some entry points.
 *
 * WHAT THIS TEST DOES, STATED HONESTLY. The restore is EXECUTED against a real polluted fixture,
 * so the behaviour is proven rather than assumed. Whether the launcher CALLS it is checked by
 * reading the script, because the only way to execute that path is to start a real run — the
 * launcher's next act is to invoke the orchestrator. The order is asserted too: a reset after the
 * orchestrator starts would restore nothing in time.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LAUNCHER = join(SCRIPTS, 'tier3-run.sh');

describe('a launcher that never reset anything', () => {
  it('RESTORES A POLLUTED PRD FROM CANONICAL — executed, not assumed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-gate-'));
    const proj = join(dir, 'project');
    mkdirSync(proj);

    const canonical = {
      stories: [
        { id: 'X-1', title: 'one', agentRole: null, completed: false },
        { id: 'X-2', title: 'two', agentRole: null, completed: false },
      ],
    };
    // The shape run 17 actually died on: last run's role assignments, and a story marked done.
    const polluted = {
      stories: [
        { id: 'X-1', title: 'one', agentRole: 'last-runs-engineer', completed: true },
        { id: 'X-2', title: 'two', agentRole: 'last-runs-engineer', completed: false },
      ],
    };
    writeFileSync(join(proj, 'prd.canonical.json'), JSON.stringify(canonical, null, 2));
    writeFileSync(join(proj, 'prd.json'), JSON.stringify(polluted, null, 2));

    const r = spawnSync('bash', ['-c',
      `. "${SCRIPTS}/lib/pre-run-reset-gate.sh"\n`
      + `pre_run_reset_or_abort --prd "${join(proj, 'prd.json')}"`,
    ], {
      encoding: 'utf8',
      // The container restart is the only slow step and this test never looks at it.
      env: { ...process.env, EPAM_SKIP_CONTAINER_RESTART: '1', LOG_DIR: join(dir, 'logs'),
             EPAM_PROJECT_CONFIG_DIR: proj },
      timeout: 60000,
    });

    const after = JSON.parse(readFileSync(join(proj, 'prd.json'), 'utf8'));
    const roles = after.stories.map((s: any) => s.agentRole);
    const done = after.stories.map((s: any) => s.completed);

    expect(roles, `last run's assignments survived the reset (${r.stdout}${r.stderr})`)
      .not.toContain('last-runs-engineer');
    expect(done, "a story stayed marked complete, so this run would skip it").not.toContain(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('THE LAUNCHER CALLS THE RESET GATE — not just owns a comment about it', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    expect(src, 'tier3-run.sh loads the project config and resets nothing — last run\'s PRD '
      + 'assignments and roster reach this run').toMatch(/pre_run_reset_or_abort/);
    expect(src, 'the gate library is never sourced, so the call would not resolve')
      .toMatch(/pre-run-reset-gate\.sh/);
  });

  it('AND CALLS IT BEFORE THE ORCHESTRATOR — a late reset restores nothing in time', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    const reset = src.indexOf('pre_run_reset_or_abort');
    const orch = src.indexOf('bash "$SCRIPT_DIR/run-agent-orchestration.sh"');
    expect(reset, 'no reset call to order').toBeGreaterThan(-1);
    expect(orch, 'the orchestrator invocation moved — this ordering check is now blind')
      .toBeGreaterThan(-1);
    expect(reset, 'the reset runs after the orchestrator has already started').toBeLessThan(orch);
  });

  it('still refuses to launch without the project data loader', () => {
    // The property that made this the right launcher in the first place, pinned so a future
    // edit cannot quietly drop it and leave the reset as the only gate.
    const src = readFileSync(LAUNCHER, 'utf8');
    expect(src).toMatch(/load_env_file_safe/);
    expect(src).toMatch(/config\.env/);
  });
});
