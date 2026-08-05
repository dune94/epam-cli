/**
 * SERVICE ENDPOINTS COME FROM CONFIG, NOT FROM 20 COPIES IN CODE.
 *
 * localhost:8092 appeared 13 times, plus Langfuse, Grafana, the story API, the phase graph
 * and the remote session store. Moving a service to another port meant finding every copy,
 * and missing one produced a health check that passed against a service nobody was using.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
