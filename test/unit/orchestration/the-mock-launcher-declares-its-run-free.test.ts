/**
 * THE FREE REHEARSAL SAYS SO — AND NOTHING ELSE EVER DID.
 *
 * free-run-guard.sh makes a run INCAPABLE of billing: it substitutes a placeholder for every
 * key-shaped variable, then re-checks in a child process and refuses to launch if a real vendor key
 * is still reachable. The registry states the requirement plainly: "A free rehearsal that can reach
 * a paid vendor is not a free rehearsal."
 *
 * It is armed by one declaration, EPAM_FREE_RUN, set by whoever launches a free run. A sweep of the
 * whole tree found NOTHING that sets it — no launcher, no project env file, no config. The only
 * matches were inside the guard's own unit test. So the seal has never fired in a real invocation:
 * every mock run to date executed with live vendor credentials reachable, protected by nothing but
 * the mock base URL being pointed elsewhere. Pointed elsewhere is exactly what the guard's own
 * comment says is not good enough.
 *
 * Same class as the write perimeter that only one launcher of eight armed, except the count here
 * was zero. A capability that no caller invokes is indistinguishable from one that was never built.
 *
 * WHERE IT GOES: above the coverage gate at the top of the file, because the gate now asks whether
 * the run spends before deciding whether to halt. A declaration made after the thing that reads it
 * is not a declaration.
 *
 * THE NEGATIVE HALF IS THE IMPORTANT ONE. If a PAID launcher picked this up, it would disarm both
 * the credential seal and the coverage gate on a run that spends real money.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const MOCK_LAUNCHER = join(SCRIPTS, 'tier3-mock-run.sh');
const GUARD = join(SCRIPTS, 'lib/free-run-guard.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

/**
 * The launcher's own preamble — every line before it re-execs under setsid — executed for real,
 * then asked the question the guard asks. This runs the file's actual text, not a paraphrase.
 */
function preambleDeclaresFreeRun(): string {
  const src = readFileSync(MOCK_LAUNCHER, 'utf8');
  const cut = src.indexOf('exec setsid');
  const preamble = src.slice(0, cut > 0 ? src.lastIndexOf('if [', cut) : src.length);
  const r = spawnSync('bash', ['-c',
    `set +e
     ${preamble}
     . ${JSON.stringify(GUARD)}
     free_run_requested && echo FREE_RUN || echo SPENDS`],
    {
      // CWD IS THE SCRIPTS DIRECTORY, DELIBERATELY. The preamble resolves its library relative to
      // ${BASH_SOURCE[0]}, which is empty under `bash -c`, so dirname yields "." — anywhere else
      // and the gate line finds no library, takes its `|| exit 1` branch and the preamble dies
      // before reaching anything this test is about. That failure looks identical to the defect.
      encoding: 'utf8', timeout: 120000, cwd: SCRIPTS,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_BIN: NODE20 } as any,
    });
  return ((r.stdout || '').trim().split('\n').pop() || '').trim();
}

describe('the mock launcher declares its run free', () => {
  it('the preamble extraction is real — it contains the coverage gate line it must precede', () => {
    // Vacuity guard: if the slice were empty, the bash below would run nothing and any
    // declaration would appear to be missing (or present) for the wrong reason.
    const src = readFileSync(MOCK_LAUNCHER, 'utf8');
    const cut = src.indexOf('exec setsid');
    expect(cut, 'the setsid re-exec is gone; this extraction no longer describes the file')
      .toBeGreaterThan(0);
    expect(src.slice(0, cut), 'the coverage gate is not in the preamble at all')
      .toContain('require_all_stage_coverage');
  });

  it('THE DEFECT: executing the launcher preamble arms the free-run seal', () => {
    expect(preambleDeclaresFreeRun(),
      'the mock launcher runs with live vendor credentials reachable — the seal is never armed')
      .toBe('FREE_RUN');
  }, 130_000);

  it('and it is declared BEFORE the coverage gate that reads it', () => {
    const src = readFileSync(MOCK_LAUNCHER, 'utf8');
    const declared = src.indexOf('EPAM_FREE_RUN');
    const gate = src.indexOf('require_all_stage_coverage');
    expect(declared, 'the launcher does not declare a free run at all').toBeGreaterThan(-1);
    expect(declared, 'the declaration comes after the gate that reads it, so the gate cannot see it')
      .toBeLessThan(gate);
  });

  it('NO PAID LAUNCHER DECLARES ITSELF FREE — that would disarm a run that spends real money', () => {
    const paid = readdirSync(SCRIPTS)
      .filter((f) => /^tier3-.*-run\.sh$/.test(f) && f !== 'tier3-mock-run.sh')
      .concat(['run-agent-orchestration.sh']);
    expect(paid.length, 'no paid launcher was found to check, so this proves nothing')
      .toBeGreaterThan(0);
    for (const f of paid) {
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      const setsIt = src.split('\n').filter((l) =>
        /(^|\s|;)(export\s+)?EPAM_FREE_RUN\s*=/.test(l) && !/^\s*#/.test(l));
      expect(setsIt, `${f} declares a free run; it spends real money`).toEqual([]);
    }
  });
});
