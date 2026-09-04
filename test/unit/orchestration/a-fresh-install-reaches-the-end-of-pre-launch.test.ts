/**
 * A FRESH INSTALL, THE OPERATOR'S OWN CREDENTIALS, AND EVERY PRE-LAUNCH GATE — IN ONE TEST.
 *
 * This is the test that would have caught, in one run, every defect that instead took a separate
 * paid launch each to find on 2026-09-04:
 *
 *   #56  pre-run-reset.sh restarted agent-monitor on the compose file's DEFAULT subnet/ports,
 *        not the isolated ones this install actually got — "container is not connected to the
 *        network", dashboard down, every run dead at pre-flight.
 *   #57  a fresh install never created orchestrations/logs at all (tar --exclude), so Docker's
 *        bind-mount created it as ROOT and pre-run-reset.sh could not write its archive dir.
 *   #58  service_url() resolved Langfuse/Grafana to :3100/:3001 (compose defaults) while the
 *        stack ran on the isolated ports — observability preflight aborted the launch.
 *   #58  healing-events.jsonl was only ever TRUNCATED, never created, so on a genuinely fresh
 *        project nginx 404'd it and the reachability check refused the run.
 *   #59  pre-flight validated project.outputDir out of a PRD the run had not written yet.
 *   #60  the runner-host daemon kept the credentials it started with.
 *
 * Every one of those passed its own unit test with docker stubbed. None of them survived contact
 * with a real install. THE JOIN IS WHERE THEY LIVE.
 *
 * WHAT THIS DOES: a real install.sh --dest, the operator's real .env files copied in, then the
 * real launcher run until pre-launch ENDS — and stopped exactly there. Pre-flight passing is the
 * assertion; everything after it costs money and is not this test's business.
 *
 * REQUIRES the operator's own env files (Jira credentials, codeline root). Absent — CI, a
 * colleague's checkout — the test SKIPS loudly rather than passing vacuously: a green run here
 * must mean the whole chain worked, never that it was never exercised.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');

/** Where the operator's filled-in credentials live. An install that has already been configured. */
const ENV_SOURCE = process.env.EPAM_E2E_ENV_SOURCE ?? '/home/bradleyjerome/projects/ai/pipeline-tests-9';
/** The codelines a TEST run may touch. Never the real client checkout. */
const TEST_CODELINE_ROOT = process.env.EPAM_E2E_CODELINE_ROOT ?? '/home/bradleyjerome/projects/tests/codelines';

const ENV_FILES = ['.env', 'launch-dashboard/.env', 'orchestrations/jira/metrolinx.env'];
const haveEnv = ENV_FILES.every((f) => fs.existsSync(path.join(ENV_SOURCE, f)))
  && fs.existsSync(TEST_CODELINE_ROOT);

const cleanups: Array<() => void> = [];
afterAll(() => { while (cleanups.length) cleanups.pop()!(); });

function sh(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
}

describe('a fresh install reaches the end of pre-launch with the operator\'s own credentials', () => {
  it.skipIf(!haveEnv)('installs, takes the operator\'s envs, and passes every pre-launch gate', async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prelaunch-'));

    // ── Install for real. node_modules is SYMLINKED (minutes of npm install buys no signal here);
    //    everything else — packaging, docker, dashboards, both daemons — runs exactly as a
    //    colleague's `npx amsd-pipeline` would.
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dest, 'node_modules'), 'dir');

    // THE CREDENTIALS GO IN BEFORE THE INSTALL, NOT AFTER. install.sh starts the runner-host
    // daemon during the install; a daemon started against a blank .env holds blank credentials
    // (that is #60, and re-running the installer to repair it is a broken sequence, not a step).
    fs.mkdirSync(path.join(dest, 'launch-dashboard'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'orchestrations/jira'), { recursive: true });
    for (const f of ENV_FILES) {
      fs.copyFileSync(path.join(ENV_SOURCE, f), path.join(dest, f));
    }

    cleanups.push(() => {
      sh('bash', [path.join(REPO, 'orchestrations-installer/install.sh'), '--uninstall', '--dest', dest]);
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    const install = sh('bash', [path.join(REPO, 'orchestrations-installer/install.sh'),
      '--dest', dest, '--ref', 'HEAD', '--docker'], {
      cwd: REPO,
      env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(dest, 'bin-shim') },
    });
    expect(install.status, `install failed:\n${install.stdout}\n${install.stderr}`).toBe(0);

    // The project must point at the TEST codelines. An install ships the committed default; an
    // operator repoints it. Doing it here is what makes this test safe to run at all.
    const cfg = path.join(dest, 'orchestrations/projects/metrolinx/config.env');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
      .replace(/^JIRA_CODELINE_ROOT=.*$/m, `JIRA_CODELINE_ROOT=${TEST_CODELINE_ROOT}`));
    expect(fs.readFileSync(cfg, 'utf8'), 'the run would target the REAL client checkout')
      .toContain(`JIRA_CODELINE_ROOT=${TEST_CODELINE_ROOT}`);

    // ── Run the REAL launcher, and stop it the moment pre-launch ends ──────────────────────────
    // There is no preflight-only flag, so the verdict line IS the stopping point. Everything after
    // it (ingest, the mint, the writer) spends real money and is not what this test is about.
    const log: string[] = [];
    const child = spawn('bash', [path.join(dest, 'orchestrations/scripts/tier3-metrolinx-run.sh'), '--yes'], {
      // detached: its own process GROUP, so the kill below reaches every node/claude child the
      // launcher spawns. Without it a killed parent leaves a live model call behind.
      cwd: dest, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const killTree = () => {
      // The launcher spawns node/claude children that outlive a plain kill of the parent — the
      // process GROUP is what must die, or a model call keeps running after the test is over.
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    cleanups.push(killTree);

    const verdict = await new Promise<string>((resolve) => {
      const done = (v: string) => { killTree(); resolve(v); };
      const absorb = (buf: Buffer) => {
        const text = String(buf);
        log.push(text);
        // The pre-flight verdict, either way — a test that only watches for success is silent on
        // a crash, which is indistinguishable from "still running".
        if (/check\(s\) FAILED/.test(text)) return done('FAILED');
        if (/checks passed — safe to run/.test(text)) return done('PASSED');
        // Anything that gets PAST pre-launch means the stop failed and real money is being spent.
        if (/\[ingest\]|\[jira\]/.test(text)) return done('OVERRAN');
      };
      child.stdout.on('data', absorb);
      child.stderr.on('data', absorb);
      child.on('close', () => resolve('EXITED'));
      setTimeout(() => done('TIMEOUT'), 540_000);
    });

    const out = log.join('');
    expect(verdict, `pre-launch did not end in a verdict (${verdict}). Tail:\n${out.slice(-4000)}`)
      .toBe('PASSED');

    // NOT JUST THE VERDICT — the specific gates that each cost a paid run to find.
    expect(out, '#57: orchestrations/logs was root-owned again').not.toMatch(/Permission denied/);
    expect(out, '#56: agent-monitor restart hit the subnet mismatch again').not.toMatch(/is not connected to the network/);
    expect(out, '#56: pre-run-reset did not finish its state clearing').toContain('PRE_RUN_RESET_STATE_CLEARED');
    // #58: either the gate ran and passed (a stack whose runner emits traces), or it correctly
    // stood down for one that never will — both are right, and demanding only the first made this
    // fail on the very stack it exists to protect.
    expect(out, '#58: the observability gate neither passed nor stood down — it aborted again')
      .toMatch(/Observability preflight passed|Observability preflight: skipped/);
    expect(out, '#58: nginx could not serve healing-events.jsonl again').toMatch(/nginx serves \/logs\/healing-events\.jsonl/);
    // #59: pre-flight must not validate a PRD the run has not written yet — whether that is the
    // whole file (a fresh install has none at all) or just its outputDir (a PRD is present but the
    // scope is still resolved during the run). Either deferral is the correct outcome; asserting
    // only the narrower one made this fail on the very install it exists to prove.
    expect(out, '#59: pre-flight validated a PRD the run had not written yet')
      .toMatch(/outputDir check deferred|file checks deferred|integrity check deferred/);
    expect(out, '#59: pre-flight reported a PRD field out of a file the run replaces')
      .not.toMatch(/PRD project\.outputDir = /);
    // The run must have been stopped BEFORE it could spend anything.
    expect(out, 'the run got past pre-launch and started spending').not.toMatch(/\[ingest\] Pulling tickets/);
  }, 600_000);
});
