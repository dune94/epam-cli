/**
 * COMPOSE EXITING 0 IS NOT A RUNNING STACK.
 *
 * THE LIVE FAILURE (2026-09-07, a clean podman install of 2.0.7). Six of eight containers sat in
 * state `created` and never started:
 *
 *   agent-monitor : rootlessport listen tcp 0.0.0.0:8092: bind: address already in use
 *   launch-api    : rootlessport listen tcp 0.0.0.0:8099: bind: address already in use
 *
 * podman-compose still exited 0. So:
 *   - the installer believed the stack was up,
 *   - the port-collision RETRY never fired — it had no failure to retry on, and never stepped to
 *     the next offset, which is the one thing that would have fixed it,
 *   - and the install ended "✓ ready" over two running containers.
 *
 * `up` succeeding must mean the services are RUNNING, not that the command returned. This asks
 * the runtime what state each of the project's containers is actually in, and reports the
 * container's own error text — which already named the cause exactly.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/**
 * Runs the real verification against a stubbed runtime whose `ps` reports the states we choose —
 * the shapes a real podman/docker prints, including the created-with-a-bind-error case.
 */
function verify(rows: string[], errors: Record<string, string> = {}, runtime = 'podman') {
  const bin = tmp('bin-');
  const stub = join(bin, runtime);
  const errCases = Object.entries(errors)
    .map(([n, e]) => `    ${n}) printf '%s' ${JSON.stringify(e)} ;;`).join('\n');
  writeFileSync(stub, `#!/usr/bin/env bash
case "$1" in
  ps)      printf '%s\\n' ${rows.map((r) => JSON.stringify(r)).join(' ')} ;;
  inspect) case "$2" in
${errCases}
    *) printf '' ;;
  esac ;;
esac
exit 0
`);
  chmodSync(stub, 0o755);
  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export EPAM_CONTAINER_RUNTIME=${runtime}`,
    `. ${JSON.stringify(LIB)}`,
    'compose_services_running myproject 2>&1; echo "rc=$?"',
  ].join('\n'));
  try {
    return execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })
      + '';
  } catch (e: any) { return `${e.stdout || ''}${e.stderr || ''}`; }
}

describe('a stack is up only when its containers are running', () => {
  it('THE DEFECT: containers stuck in `created` are not a running stack', () => {
    const out = verify(
      ['obs_postgres_1|running', 'obs_agent-monitor_1|created', 'obs_grafana_1|created'],
      { obs_agent_monitor_1: '' });
    expect(out, 'a stack with two containers never started was reported as up — the install then '
      + 'health-checked ports another install was serving').toMatch(/rc=[1-9]/);
  });

  it('names the container AND its own error, which already said why', () => {
    const out = verify(['obs_agent-monitor_1|created'],
      { 'obs_agent-monitor_1': 'rootlessport listen tcp 0.0.0.0:8092: bind: address already in use' });
    expect(out, 'the failing container is not named').toContain('obs_agent-monitor_1');
    expect(out, "the container's own error text is dropped, so the operator is told nothing")
      .toMatch(/address already in use/);
  });

  it('the error text reaches the caller, so the port-collision RETRY can match on it', () => {
    // install.sh retries only when it can see 'address already in use' / 'port is already
    // allocated'. Silence here is what stopped the retry from ever firing.
    const out = verify(['launch_api_1|created'],
      { launch_api_1: 'rootlessport listen tcp 0.0.0.0:8099: bind: address already in use' });
    expect(out).toMatch(/address already in use/);
  });

  it('an exited container is not running either', () => {
    expect(verify(['obs_langfuse_1|exited'])).toMatch(/rc=[1-9]/);
  });

  it('all running is success', () => {
    expect(verify(['a|running', 'b|running'])).toMatch(/rc=0/);
  });

  it('no containers at all is a failure, not an empty success', () => {
    expect(verify([]), 'a project with nothing in it reported as up').toMatch(/rc=[1-9]/);
  });
});
