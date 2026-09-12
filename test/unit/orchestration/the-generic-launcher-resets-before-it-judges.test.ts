/**
 * THE GENERIC LAUNCHER RESETS BEFORE IT JUDGES.
 *
 * tier3-run.sh ran pre-flight, then asked the operator, then ran pre-run-reset.sh. Pre-flight's
 * "Self-heal observability" check asks nginx for /logs/healing-events.jsonl — a file
 * pre-run-reset.sh creates, behind a mount pre-run-reset.sh writes into the compose override. On a
 * fresh install nothing has ever run, so nothing is there to serve, and the check refused every
 * first launch with a hint to run the step the launcher had not reached. Found 2026-09-11 on a
 * fresh regintel install at v2.0.24. The proven launcher (tier3-metrolinx-run.sh) confirms, resets,
 * then pre-flights; this one now does the same.
 *
 * The launcher is EXECUTED against a fixture project with the reset, the pre-flight and the
 * orchestrator replaced by stubs that record the order they were called in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A scripts dir identical to the real one, with the three steps replaced by recorders. */
function stubbed(opts: { preflightExit: number; provisionMode?: string | null }) {
  const d = mkdtempSync(join(tmpdir(), 'launch-order-')); dirs.push(d);
  const scripts = join(d, 'orchestrations/scripts'); mkdirSync(scripts, { recursive: true });
  for (const f of readdirSync(SCRIPTS)) {
    if (['preflight-check.sh', 'pre-run-reset.sh', 'run-agent-orchestration.sh'].includes(f)) continue;
    symlinkSync(join(SCRIPTS, f), join(scripts, f));
  }
  // The launcher resolves REPO_ROOT as SCRIPT_DIR/../.. and reads orchestrations/config from it.
  symlinkSync(join(ROOT, 'orchestrations/config'), join(d, 'orchestrations/config'));
  symlinkSync(join(ROOT, 'orchestrations/agents'), join(d, 'orchestrations/agents'));
  mkdirSync(join(d, 'orchestrations/dashboards'));
  const calls = join(d, 'calls.txt');
  const stub = (name: string, exit: number) => {
    writeFileSync(join(scripts, name), `#!/bin/bash\necho "${name}" >> ${JSON.stringify(calls)}\nexit ${exit}\n`);
    chmodSync(join(scripts, name), 0o755);
  };
  stub('preflight-check.sh', opts.preflightExit);
  // The reset gate reads the real script's completion sentinel, not its exit code.
  writeFileSync(join(scripts, 'pre-run-reset.sh'), `#!/bin/bash\necho "pre-run-reset.sh" >> ${JSON.stringify(calls)}\necho PRE_RUN_RESET_STATE_CLEARED\nexit 0\n`);
  chmodSync(join(scripts, 'pre-run-reset.sh'), 0o755);
  stub('run-agent-orchestration.sh', 0);
  // The launcher itself, at the stubbed location, so $SCRIPT_DIR is the stubbed dir.
  writeFileSync(join(scripts, 'tier3-run.sh'), readFileSync(join(SCRIPTS, 'tier3-run.sh'), 'utf8'));
  chmodSync(join(scripts, 'tier3-run.sh'), 0o755);
  const proj = join(d, 'project'); mkdirSync(proj);
  // A project declares how its prompts are provisioned; the launcher refuses one that does not
  // (the mint would, mid-run). null = leave it undeclared, to prove that refusal.
  const mode = opts.provisionMode === undefined ? 'copy' : opts.provisionMode;
  writeFileSync(join(proj, 'config.env'), `EPAM_BROWNFIELD=1\n${mode === null ? '' : `EPAM_PROMPT_PROVISION_MODE=${mode}\n`}`);
  writeFileSync(join(proj, 'prd.json'), JSON.stringify({ stories: [] }));
  return { d, scripts, proj, calls };
}

function launch(s: ReturnType<typeof stubbed>) {
  const r = spawnSync('bash', [join(s.scripts, 'tier3-run.sh'), '--yes'], {
    encoding: 'utf8', timeout: 120_000, cwd: s.d,
    env: {
      ...process.env,
      EPAM_PROJECT_CONFIG_DIR: s.proj, PROJECT_NAME: 'fixture', EPAM_FREE_RUN: '1',
      PRE_RUN_RESET_SCRIPT: join(s.scripts, 'pre-run-reset.sh'),
    },
  });
  const order = existsSync(s.calls) ? readFileSync(s.calls, 'utf8').trim().split('\n') : [];
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), order };
}

describe('the generic launcher resets before it judges', () => {
  it('pre-run-reset runs BEFORE pre-flight, and the orchestrator after both', () => {
    const r = launch(stubbed({ preflightExit: 0 }));
    expect(r.order, `stubs were not all reached:\n${r.out.slice(-1500)}`).toEqual([
      'pre-run-reset.sh', 'preflight-check.sh', 'run-agent-orchestration.sh',
    ]);
    expect(r.status, r.out.slice(-800)).toBe(0);
  });

  it('a project that declares no EPAM_PROMPT_PROVISION_MODE is refused before the reset, the pre-flight and any spend', () => {
    // mint-agents-step.js throws on an unset mode — after the roster has been minted and paid
    // for. Both greenfield projects had declared nothing (2026-09-12).
    const r = launch(stubbed({ preflightExit: 0, provisionMode: null }));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/declares no EPAM_PROMPT_PROVISION_MODE/);
    expect(r.order, 'the launch went on without a provisioning mode').toEqual([]);
  });

  it('a mode the mint does not accept is refused the same way', () => {
    const r = launch(stubbed({ preflightExit: 0, provisionMode: 'improvise' }));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/EPAM_PROMPT_PROVISION_MODE='improvise'/);
    expect(r.order).toEqual([]);
  });

  it('a pre-flight refusal still stops the launch before the orchestrator', () => {
    const r = launch(stubbed({ preflightExit: 1 }));
    expect(r.order).toEqual(['pre-run-reset.sh', 'preflight-check.sh']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/pre-flight failed/);
  });
});
