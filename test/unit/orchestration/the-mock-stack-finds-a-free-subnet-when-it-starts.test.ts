/**
 * THE MOCK STACK FINDS A FREE SUBNET WHEN IT STARTS.
 *
 * install.sh records MOCK_SUBNET — the first candidate free at that moment — BEFORE it brings the
 * launch dashboard up, and the launch stack then takes the same range as free. The first
 * `pipeline-services.sh --start --mock` on a fresh install (2026-09-13, the £0 greenfield
 * rehearsal) died with "Pool overlaps with other one on this address space", and the £0 path was
 * closed by the installer's own ordering.
 *
 * The observability stack already walks the candidate sequence on exactly this error; the mock
 * stack now does the same, tries the recorded subnet first, and records the one that worked so
 * --stop finds what --start created. Executed against a fixture install with a stub container
 * runtime that overlaps on the first range and accepts the second.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A fixture install: only the mock stack exists, with a recorded (stale) subnet. */
function fixtureInstall(opts: { overlapsFirst: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'mock-subnet-')); dirs.push(d);
  const root = join(d, 'install'); mkdirSync(join(root, 'orchestrations/mock-llm'), { recursive: true });
  writeFileSync(join(root, 'orchestrations/mock-llm/docker-compose.yml'), 'services:\n  mockserver:\n    image: x\n');
  writeFileSync(join(root, '.pipeline-services-state.env'), 'MOCK_PROJECT=fixture-mock\nMOCK_SUBNET=10.99.0.0/16\n');
  // The installer's own scripts, next to the fixture root, as `$HERE/..` resolves them.
  const here = join(root, 'orchestrations-installer'); mkdirSync(here);
  for (const f of ['pipeline-services.sh']) writeFileSync(join(here, f), readFileSync(join(ROOT, 'orchestrations-installer', f), 'utf8'));
  chmodSync(join(here, 'pipeline-services.sh'), 0o755);
  spawnSync('cp', ['-r', join(ROOT, 'orchestrations-installer/lib'), join(here, 'lib')]);
  // A stub docker: `compose ... up` overlaps on the recorded subnet and accepts any other;
  // `network ls/inspect` (the candidate prober) sees nothing held. Every call is logged.
  const bin = join(d, 'bin'); mkdirSync(bin);
  const log = join(d, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
echo "subnet=\${EPAM_MOCK_SUBNET:-} args=$*" >> ${JSON.stringify(log)}
case "$*" in
  *"compose"*"up"*)
    if [ "${opts.overlapsFirst ? '1' : '0'}" = "1" ] && [ "\${EPAM_MOCK_SUBNET:-}" = "10.99.0.0/16" ]; then
      echo "Error response from daemon: invalid pool request: Pool overlaps with other one on this address space" >&2; exit 1
    fi
    exit 0 ;;
  *"compose"*"down"*) exit 0 ;;
  info) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  return { root, bin, log };
}

function startMock(f: ReturnType<typeof fixtureInstall>) {
  const r = spawnSync('bash', [join(f.root, 'orchestrations-installer/pipeline-services.sh'), '--start', '--mock', '--dest', f.root], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, PODMAN_COMPOSE_PROVIDER: '' },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status, calls: readFileSync(f.log, 'utf8') };
}

describe('the mock stack finds a free subnet when it starts', () => {
  it('a recorded subnet that now overlaps is walked past, and the one that worked is recorded back', () => {
    const f = fixtureInstall({ overlapsFirst: true });
    const r = startMock(f);
    expect(r.out, r.out).toMatch(/fixture-mock is up \(subnet: (?!10\.99\.0\.0)/);
    const ups = r.calls.split('\n').filter((l) => /compose.*up/.test(l));
    expect(ups[0]).toMatch(/subnet=10\.99\.0\.0\/16/);
    expect(ups.length).toBeGreaterThan(1);
    const state = readFileSync(join(f.root, '.pipeline-services-state.env'), 'utf8');
    expect(state).not.toMatch(/MOCK_SUBNET=10\.99\.0\.0\/16/);
    expect(state).toMatch(/^MOCK_SUBNET=\d+\.\d+\.\d+\.\d+\/\d+$/m);
    expect(state).toMatch(/^MOCK_PROJECT=fixture-mock$/m);
  });

  it('a recorded subnet that is still free is used first and left recorded', () => {
    const f = fixtureInstall({ overlapsFirst: false });
    const r = startMock(f);
    expect(r.out).toMatch(/fixture-mock is up \(subnet: 10\.99\.0\.0\/16\)/);
    expect(r.calls.split('\n').filter((l) => /compose.*up/.test(l))).toHaveLength(1);
    expect(readFileSync(join(f.root, '.pipeline-services-state.env'), 'utf8')).toMatch(/^MOCK_SUBNET=10\.99\.0\.0\/16$/m);
  });
});
