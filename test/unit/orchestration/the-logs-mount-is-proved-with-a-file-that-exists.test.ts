/**
 * THE /logs MOUNT IS PROVED WITH A FILE THAT EXISTS.
 *
 * pipeline-health.sh asked nginx for /logs/agent-status.json. On a fresh install nothing has
 * written that file, so the answer is 404 — and because the base compose mounts /logs-dir from
 * the start, the check found the mount present and reported "IS mounted but nginx will not serve
 * it", a hard failure with a reinstall as the fix, on every fresh install. Reported by the
 * other project's agent on 2026-09-11; hit again opening the £0 greenfield rehearsal.
 *
 * The mount is what is under test, so the check now writes a probe file into the directory
 * docker says is mounted and fetches it through nginx. Executed against the real script with a
 * stub docker (reports the mount and its host source) and a stub curl (answers 200 only for a
 * file that exists in that directory at request time).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, copyFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(opts: { mounted: boolean; serves: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'logs-mount-')); dirs.push(d);
  const logDir = join(d, 'orchestrations/logs'); mkdirSync(logDir, { recursive: true });
  mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
  mkdirSync(join(d, 'orchestrations/scripts/lib'), { recursive: true });
  mkdirSync(join(d, 'orchestrations-installer'), { recursive: true });
  copyFileSync(join(ROOT, 'orchestrations-installer/pipeline-health.sh'), join(d, 'orchestrations-installer/pipeline-health.sh'));
  chmodSync(join(d, 'orchestrations-installer/pipeline-health.sh'), 0o755);
  cpSync(join(ROOT, 'orchestrations-installer/lib'), join(d, 'orchestrations-installer/lib'), { recursive: true });
  copyFileSync(join(ROOT, 'orchestrations/scripts/lib/service-urls.sh'), join(d, 'orchestrations/scripts/lib/service-urls.sh'));
  // The registries the script derives everything from: only the dashboard service, on the claude set.
  writeFileSync(join(d, 'orchestrations/config/services.json'), JSON.stringify({ services: {
    dashboard: { url: 'http://localhost:8092', env: 'EPAM_DASHBOARD_URL', stateVar: 'OBS_DASHBOARD_PORT' },
  } }));
  writeFileSync(join(d, 'orchestrations/config/provider-sets.json'), JSON.stringify({ defaultSet: 'claude', sets: { claude: { settingsFile: 'llm-defaults.claude.json', credentials: [] } } }));
  writeFileSync(join(d, 'orchestrations/config/llm-defaults.claude.json'), JSON.stringify({ runners: { claude: {} } }));
  writeFileSync(join(d, '.pipeline-services-state.env'), 'OBS_PROJECT=fixture-obs\nOBS_DASHBOARD_PORT=8092\n');
  writeFileSync(join(d, '.env'), 'EPAM_PROVIDER_SET=claude\n');
  const bin = join(d, 'bin'); mkdirSync(bin);
  for (const cmd of ['git', 'jq-unused', 'python3', 'claude']) { writeFileSync(join(bin, cmd), '#!/bin/bash\nexit 0\n'); chmodSync(join(bin, cmd), 0o755); }
  // docker: the agent-monitor container exists and (when mounted) reports /logs-dir from logDir.
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1 $2" in
  "ps --format") echo "fixture-obs-agent-monitor-1" ;;
  "inspect fixture-obs-agent-monitor-1")
    # Two formats are asked for: destinations only, or destination=source per line.
    if [ "${opts.mounted ? '1' : '0'}" = "1" ]; then
      case "$*" in
        *Source*) printf '%s\\n' '/logs-dir=${logDir}' '/prd-dir=${join(d, 'orchestrations/projects')}' ;;
        *) echo '/logs-dir /prd-dir ' ;;
      esac
    else echo; fi
    ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  // curl: 200 for a /logs/<file> that exists in the mounted directory when serving; 404 otherwise.
  writeFileSync(join(bin, 'curl'), `#!/bin/bash
url="\${@: -1}"
code=404
case "$url" in
  */logs/*) f="${logDir}/\${url##*/logs/}"; if [ "${opts.serves ? '1' : '0'}" = "1" ] && [ -f "$f" ]; then code=200; fi ;;
  */) code=200 ;;
esac
printf '%s' "$code"
`);
  chmodSync(join(bin, 'curl'), 0o755);
  return { d, bin, logDir };
}

function health(f: ReturnType<typeof fixture>) {
  const r = spawnSync('bash', [join(f.d, 'orchestrations-installer/pipeline-health.sh')], {
    cwd: f.d, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, HOME: f.d },
  });
  return (r.stdout || '') + (r.stderr || '');
}

describe('the /logs mount is proved with a file that exists', () => {
  it('THE DEFECT: a mounted, empty log directory is reported SERVING, not as a mount nginx refuses', () => {
    const out = health(fixture({ mounted: true, serves: true }));
    expect(out).toMatch(/dashboard \/logs mount: serving \(probe file fetched/);
    expect(out).not.toMatch(/IS mounted but nginx will not serve it/);
  });

  it('a mount nginx genuinely does not serve is still a hard failure', () => {
    const out = health(fixture({ mounted: true, serves: false }));
    expect(out).toMatch(/IS mounted but nginx will not serve it/);
  });

  it('no mount at all is still the pre-first-run warning', () => {
    const out = health(fixture({ mounted: false, serves: false }));
    expect(out).toMatch(/not mounted yet/);
  });

  it('the probe file is removed afterwards — a health check leaves no litter in a run\'s log directory', () => {
    const f = fixture({ mounted: true, serves: true });
    health(f);
    expect(readFileSync(join(f.d, '.env'), 'utf8')).toBeTruthy();
    expect(spawnSync('ls', [f.logDir], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });
});
