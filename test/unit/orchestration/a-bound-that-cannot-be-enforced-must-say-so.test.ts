import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * run-bounded.sh exists so nothing this repo launches can take the machine. On
 * 2026-09-02 an unbounded stack plus a live run exhausted a 14GB WSL box and forced
 * a restart mid-run — with run-bounded.sh sitting right there, unused and, as this
 * proves, unusable.
 *
 * It gates on `command -v systemd-run` — the BINARY. The binary is always present.
 * What is absent after a WSL restart is the user systemd BUS, and that is only
 * discovered inside the exec, at which point the script has already printed a
 * confident "MemoryHigh=... MemoryMax=..." line and can no longer reach its own
 * honest fallback. The result is the worst of both: no bound, no command, and a
 * message that reads like success.
 *
 * Either outcome is acceptable. Silence is not.
 */
describe('run-bounded.sh, when the cgroup bound cannot be enforced', () => {
  const script = path.resolve(__dirname, '../../../orchestrations/scripts/run-bounded.sh');

  const runWithNoBus = () =>
    spawnSync('bash', [script, '--share', '10', '--', 'bash', '-c', 'echo CHILD_RAN'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/epam-no-such-bus',
        XDG_RUNTIME_DIR: '/nonexistent/epam-no-such-runtime',
      },
    });

  it('either runs the command or says it cannot bound it — never neither', () => {
    const r = runWithNoBus();
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    // Guard against a vacuous pass: the script must have produced something.
    expect(out.length).toBeGreaterThan(0);

    const ranTheCommand = (r.stdout ?? '').includes('CHILD_RAN');
    const declaredItCannot = /cannot bound/i.test(out);

    expect(
      ranTheCommand || declaredItCannot,
      `neither outcome happened. exit=${r.status}\n--- output ---\n${out}`,
    ).toBe(true);
  });

  it('does not announce a ceiling it did not apply', () => {
    const r = runWithNoBus();
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length).toBeGreaterThan(0);

    const announced = /MemoryMax=\d+M/.test(out);
    const enforced = (r.stdout ?? '').includes('CHILD_RAN');

    // Announcing a ceiling is only honest if the bounded command actually ran under it.
    expect(
      !announced || enforced,
      `announced a ceiling but the command never ran. exit=${r.status}\n--- output ---\n${out}`,
    ).toBe(true);
  });
});
