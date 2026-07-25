/**
 * B29 — pre-run-reset.sh must not write into the working repo when a test runs it.
 *
 * Found 2026-07-25 by the pre-launch dashboard checklist, NOT by a live run.
 *
 * pre-run-reset.sh generates docker-compose.observability.override.yml, mounting
 * the active PRD dir and LOG_DIR into the agent-monitor nginx container. The path
 * it writes was hardcoded to $REPO_ROOT/docker-compose.observability.override.yml
 * with no indirection, so `pre-run-reset-without-prd.test.ts` — which invokes the
 * REAL script against mkdtemp() dirs — rewrote the repo's own tracked override to
 * point at throwaway mkdtemp dirs under /tmp. Those dirs are deleted in that
 * suite's afterAll, so the moment the sweep finished, the live dashboard was
 * mounting two paths that no longer existed: docker recreated them as empty
 * root-owned dirs and nginx served 403, then 404, for /prd.json and /logs/*.
 *
 * Two things make this worth an invariant rather than a one-line patch:
 *   1. The file is git-TRACKED, so every full `vitest run` silently dirtied the
 *      working tree and broke observability for whoever looked next.
 *   2. It is exactly the failure the pre-launch checklist exists to catch —
 *      log write -> docker mount -> nginx serve -> dashboard fetch — and it is
 *      invisible unless something actually curls the dashboard. A test that only
 *      asserted "the script ran and exited 0" would pass forever.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const REPO_OVERRIDE = join(REPO_ROOT, 'docker-compose.observability.override.yml');

// The repo override is real live dashboard config. Snapshot and restore it so
// this test cannot itself become the polluter it is guarding against.
const before = existsSync(REPO_OVERRIDE) ? readFileSync(REPO_OVERRIDE, 'utf8') : null;
const dirs: string[] = [];
afterAll(() => {
  if (before !== null) writeFileSync(REPO_OVERRIDE, before);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('B29 — pre-run-reset.sh honours an isolated COMPOSE_OVERRIDE path', () => {
  it('writes the override to COMPOSE_OVERRIDE and leaves the repo file untouched', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'b29-logs-'));
    const prdDir = mkdtempSync(join(tmpdir(), 'b29-prd-'));
    const overrideDir = mkdtempSync(join(tmpdir(), 'b29-ovr-'));
    dirs.push(logDir, prdDir, overrideDir);
    mkdirSync(join(logDir, 'kb-scratchpad'), { recursive: true });
    const prd = join(prdDir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [] }));

    const isolated = join(overrideDir, 'override.yml');
    const repoBefore = existsSync(REPO_OVERRIDE) ? readFileSync(REPO_OVERRIDE, 'utf8') : null;

    execFileSync('bash', [RESET, '--prd', prd, '--log-dir', logDir], {
      encoding: 'utf8',
      env: { ...process.env, COMPOSE_OVERRIDE: isolated },
    });

    expect(existsSync(isolated), 'COMPOSE_OVERRIDE was ignored — nothing written there').toBe(true);
    expect(readFileSync(isolated, 'utf8')).toContain(prdDir);

    const repoAfter = existsSync(REPO_OVERRIDE) ? readFileSync(REPO_OVERRIDE, 'utf8') : null;
    expect(repoAfter,
      'pre-run-reset.sh rewrote the git-tracked repo override during a test — ' +
      'the live dashboard now mounts temp dirs that vanish at teardown').toBe(repoBefore);
  });
});

describe('B29 — the suite-wide default cannot be silently removed', () => {
  // Seven test files invoke pre-run-reset.sh and most pass no `env` at all, so a
  // per-call-site fix would not survive the eighth. The protection is the global
  // default; these two assertions are what stop it being deleted by accident.
  it('vitest.config.ts wires the compose-override guard', () => {
    const cfg = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(cfg, 'setupFiles no longer loads the guard — tests can rewrite the live override again')
      .toMatch(/setupFiles[\s\S]*compose-override-guard/);
  });

  it('the guard points COMPOSE_OVERRIDE somewhere other than the repo file', () => {
    expect(process.env.COMPOSE_OVERRIDE,
      'COMPOSE_OVERRIDE is unset inside the suite — the guard did not run').toBeTruthy();
    expect(process.env.COMPOSE_OVERRIDE).not.toBe(REPO_OVERRIDE);
  });
});
