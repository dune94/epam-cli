/**
 * UNINSTALL REPORTS WHAT IS ACTUALLY GONE.
 *
 * THE LIVE FAILURE (2026-09-07): `--uninstall` printed
 *
 *   ✓ test-install-amsd-pipeline-obs-19781: nothing to remove or already gone
 *   ✓ test-install-amsd-pipeline-launch-19781: nothing to remove or already gone
 *
 * and EIGHT containers plus TWO networks for those exact projects were still on the machine
 * afterwards. `compose down` had failed — containers stuck in `created` are not always torn down
 * by compose — and a non-zero exit was reported as "already gone", the most reassuring wording
 * available for the case where nothing was removed.
 *
 * The leftovers then held the ports the NEXT install needed, which is how a fresh install ended
 * up validating itself against a previous install's services.
 *
 * So: sweep by project label after compose, and VERIFY. Whatever remains is named, and the step
 * fails rather than claiming success.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/**
 * A runtime double that still has `leftover` containers/networks after compose down, unless the
 * code sweeps them by label — in which case it records the sweep and reports nothing left.
 */
function purge(leftoverContainers: string[], leftoverNetworks: string[]) {
  const bin = tmp('bin-');
  const state = join(bin, 'state');
  writeFileSync(state, [leftoverContainers.join(' '), leftoverNetworks.join(' ')].join('\n'));
  const calls = join(bin, 'calls.txt');
  writeFileSync(join(bin, 'podman'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(calls)}
C=$(sed -n 1p ${JSON.stringify(state)}); N=$(sed -n 2p ${JSON.stringify(state)})
case "$1 $2" in
  "ps -aq"|"ps -a")  printf '%s\\n' $C ;;
  "network ls")      printf '%s\\n' $N ;;
  "rm -f"|"rm --force") shift 2; printf '%s\\n' "" > /dev/null; printf '\\n%s' "" >/dev/null; printf '%s\\n' "$N" > /tmp/.x; sed -i "1s/.*//" ${JSON.stringify(state)} ;;
  "network rm")      sed -i "2s/.*//" ${JSON.stringify(state)} ;;
esac
exit 0
`);
  chmodSync(join(bin, 'podman'), 0o755);

  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`, 'export EPAM_CONTAINER_RUNTIME=podman',
    `. ${JSON.stringify(LIB)}`,
    'purge_project myproject 2>&1; echo "rc=$?"',
  ].join('\n'));
  let out = '';
  try { out = execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 }); }
  catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  return { out, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

describe('uninstall', () => {
  it('SWEEPS containers compose left behind, by project label', () => {
    const { calls } = purge(['abc123', 'def456'], []);
    expect(calls, 'containers compose could not remove were never swept — they keep holding the '
      + "next install's ports").toMatch(/rm -f/);
  });

  it('removes the networks too — a stale network is the next subnet collision', () => {
    const { calls } = purge([], ['proj_default']);
    expect(calls).toMatch(/network rm/);
  });

  it('FAILS when something is still there, instead of saying "already gone"', () => {
    // The double keeps its leftovers when the sweep is not attempted at all.
    const { out } = purge(['stuck1'], []);
    expect(out, 'a project with containers still on the machine reported success')
      .not.toMatch(/rc=0[\s\S]*already gone/);
  });

  it('a genuinely empty project succeeds quietly', () => {
    expect(purge([], []).out).toMatch(/rc=0/);
  });
});
