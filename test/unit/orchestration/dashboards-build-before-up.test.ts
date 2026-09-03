import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * orchestrations/dashboards/live/ is gitignored — eleventy's own build output, never tracked — so
 * on every fresh install it starts EMPTY. agent-monitor's healthcheck probes `/`; nginx has no
 * index and autoindex is off, so a brand-new install was 403-unhealthy FOREVER, and grafana
 * (depends_on agent-monitor: condition service_healthy) never even started. Found live 2026-09-03
 * against a real npx-installed tree, reproduced twice (uninstall, reinstall, same failure both
 * times) before this fix. install.sh must run the dashboard build before bringing the stack up —
 * but ONLY when there is something to build FROM (src/ present); a packaged, src/-less install
 * ships no eleventy at all.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER_REL = 'orchestrations-installer/install.sh';

function fixture(withSrc: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboards-build-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(REPO, INSTALLER_REL), path.join(dir, INSTALLER_REL));
  fs.chmodSync(path.join(dir, INSTALLER_REL), 0o755);
  for (const f of ['container-runtime.sh', 'isolated-compose-identity.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'EPAM_PROVIDER_SET=claude\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  fs.writeFileSync(path.join(dir, 'docker-compose.observability.yml'), 'services: {}\n');
  if (withSrc) fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  const npmLog = path.join(dir, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const dockerLog = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return { dir, bin, npmLog };
}

const run = (f: { dir: string; bin: string }) =>
  spawnSync('bash', [path.join(f.dir, INSTALLER_REL), '--docker'], {
    cwd: f.dir, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, EPAM_NONINTERACTIVE: '1', EPAM_CONTAINER_RUNTIME: 'docker' },
  });

describe('install.sh builds dashboards before bringing the observability stack up', () => {
  it('runs dashboards:build when src/ is present, so agent-monitor has real content to serve', () => {
    const f = fixture(true);
    run(f);
    const log = fs.existsSync(f.npmLog) ? fs.readFileSync(f.npmLog, 'utf8') : '';
    expect(log, `dashboards:build was never invoked:\n${log}`).toMatch(/dashboards:build/);
  });

  it('skips the build on a packaged (src/-less) tree — nothing to build from', () => {
    const f = fixture(false);
    run(f);
    const log = fs.existsSync(f.npmLog) ? fs.readFileSync(f.npmLog, 'utf8') : '';
    expect(log, `dashboards:build ran on a packaged tree with no src/:\n${log}`).not.toMatch(/dashboards:build/);
  });
});
