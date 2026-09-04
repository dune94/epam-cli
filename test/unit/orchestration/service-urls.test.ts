/**
 * SERVICE ENDPOINTS COME FROM CONFIG, NOT FROM 20 COPIES IN CODE.
 *
 * localhost:8092 appeared 13 times, plus Langfuse, Grafana, the story API, the phase graph
 * and the remote session store. Moving a service to another port meant finding every copy,
 * and missing one produced a health check that passed against a service nobody was using.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const LIB = join(REPO, 'orchestrations/scripts/lib/service-urls.sh');
const CONFIG = join(REPO, 'orchestrations/config/services.json');

const resolve = (name: string, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; service_url ${JSON.stringify(name)}`], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return { out: (r.stdout || '').trim(), err: r.stderr || '', status: r.status };
};

describe('endpoints resolve from the config file', () => {
  it('every service in the config resolves', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const names = Object.keys(cfg.services);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) {
      const r = resolve(n);
      expect(r.out, `${n} did not resolve: ${r.err}`).toBe(cfg.services[n].url);
    }
  });

  it('the service env var wins, so a machine can differ without an edit', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const envName = cfg.services.dashboard.env;
    expect(resolve('dashboard', { [envName]: 'http://example.invalid:1234' }).out)
      .toBe('http://example.invalid:1234');
  });

  it('an unknown service fails loudly instead of guessing a port', () => {
    const r = resolve('no-such-service');
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/no service/i);
  });

  it('every entry declares an env override and a description', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    for (const [name, svc] of Object.entries(cfg.services) as Array<[string, Record<string, string>]>) {
      expect(svc.env, `${name} has no env override`).toBeTruthy();
      expect(svc.description, `${name} has no description — a settings viewer would show a bare port`).toBeTruthy();
    }
  });
});

describe('an ISOLATED install resolves its OWN port, not the compose file default', () => {
  // Confirmed live 2026-09-04, pipeline-tests-9: tier3-metrolinx-run.sh's observability preflight
  // checked http://localhost:3100 (Langfuse) and :3001 (Grafana) — the compose file's bare
  // defaults — against a stack actually isolated onto 3120/3021, and aborted the launch as
  // "NOT serving" while curl against the REAL ports showed both healthy. install.sh already
  // persists the port it actually allocated to .pipeline-services-state.env (the SAME file
  // pre-run-reset.sh and pipeline-services.sh already read for subnet/project identity) — nothing
  // read it back for dashboard/langfuse/grafana until now.
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function fixture(stateFileContent: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'service-urls-state-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'orchestrations/config'), { recursive: true });
    mkdirSync(join(dir, 'orchestrations/scripts/lib'), { recursive: true });
    writeFileSync(join(dir, 'orchestrations/config/services.json'), readFileSync(CONFIG, 'utf8'));
    writeFileSync(join(dir, 'orchestrations/scripts/lib/service-urls.sh'), readFileSync(LIB, 'utf8'));
    if (stateFileContent !== null) {
      writeFileSync(join(dir, '.pipeline-services-state.env'), stateFileContent);
    }
    return dir;
  }

  const resolveIn = (dir: string, name: string) => {
    const lib = join(dir, 'orchestrations/scripts/lib/service-urls.sh');
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(lib)}; service_url ${JSON.stringify(name)}`], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env },
    });
    return { out: (r.stdout || '').trim(), err: r.stderr || '', status: r.status };
  };

  it('dashboard/langfuse/grafana resolve to the PERSISTED port when a state file exists', () => {
    const dir = fixture([
      'OBS_PROJECT=test-fake',
      'OBS_SUBNET=172.23.0.0/16',
      'OBS_CLICKHOUSE_PORT=8143',
      'OBS_LANGFUSE_PORT=3120',
      'OBS_DASHBOARD_PORT=8112',
      'OBS_GRAFANA_PORT=3021',
      '',
    ].join('\n'));

    expect(resolveIn(dir, 'dashboard').out).toBe('http://localhost:8112');
    expect(resolveIn(dir, 'langfuse').out).toBe('http://localhost:3120');
    expect(resolveIn(dir, 'grafana').out).toBe('http://localhost:3021');
  });

  it('falls back to the static default when no state file exists — the dev-checkout path, unchanged', () => {
    const dir = fixture(null);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(resolveIn(dir, 'dashboard').out).toBe(cfg.services.dashboard.url);
    expect(resolveIn(dir, 'langfuse').out).toBe(cfg.services.langfuse.url);
    expect(resolveIn(dir, 'grafana').out).toBe(cfg.services.grafana.url);
  });

  it('an explicit env var still outranks the state file', () => {
    const dir = fixture(['OBS_LANGFUSE_PORT=3120', ''].join('\n'));
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(join(dir, 'orchestrations/scripts/lib/service-urls.sh'))}; service_url langfuse`], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, LANGFUSE_BASE_URL: 'http://example.invalid:9999' },
    });
    expect(r.stdout.trim()).toBe('http://example.invalid:9999');
  });

  it('a state var declared but MISSING from an existing state file falls back to the static default, not an empty URL', () => {
    const dir = fixture(['OBS_PROJECT=test-fake', ''].join('\n'));
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(resolveIn(dir, 'grafana').out).toBe(cfg.services.grafana.url);
  });

  it('a service with no declared stateVar (storyApi) is unaffected by a state file being present', () => {
    const dir = fixture(['OBS_LANGFUSE_PORT=3120', ''].join('\n'));
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(resolveIn(dir, 'storyApi').out).toBe(cfg.services.storyApi.url);
  });
});
