/**
 * B29 — suite-wide guard: no test may rewrite the repo's live docker compose
 * override.
 *
 * pre-run-reset.sh generates docker-compose.observability.override.yml, which
 * mounts the active PRD dir and LOG_DIR into the agent-monitor nginx container.
 * Seven test files invoke that script against mkdtemp() dirs. Because the script
 * wrote a hardcoded repo path, each of them rewrote the git-TRACKED override to
 * point at its own temp dirs — and then deleted those dirs at teardown. The live
 * dashboard was left mounting paths that no longer existed: docker recreated them
 * as empty root-owned dirs, and nginx served 403 (then 404) for /prd.json and
 * /logs/* until someone actually curled it.
 *
 * Fixing this by editing each call site is the fragile version of the fix — most
 * of those tests don't pass an `env` at all, they just inherit, and the eighth
 * test to be written would silently reintroduce it. So the default is inverted
 * here instead: every test process points COMPOSE_OVERRIDE at a throwaway file
 * unless it deliberately opts out.
 *
 * OPT-OUT: a real end-to-end run (mock1/mock2) genuinely wants the live dashboard
 * wired to the run while it executes — observability during a 45-minute run is the
 * whole point. Those tests set COMPOSE_OVERRIDE themselves (to the real repo path)
 * and are responsible for restoring the file afterwards.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.COMPOSE_OVERRIDE) {
  process.env.COMPOSE_OVERRIDE = join(
    mkdtempSync(join(tmpdir(), 'vitest-compose-override-')),
    'docker-compose.observability.override.yml',
  );
}

// Second vector, same bug: pre-run-reset.sh also writes the git-tracked dashboard
// pointer files (.active-prd-path / .active-output-dir). A suite run was still
// leaving those aimed at deleted mkdtemp dirs after the compose override was
// already protected.
if (!process.env.DASHBOARD_STATE_DIR) {
  process.env.DASHBOARD_STATE_DIR = mkdtempSync(join(tmpdir(), 'vitest-dashboard-state-'));
}
