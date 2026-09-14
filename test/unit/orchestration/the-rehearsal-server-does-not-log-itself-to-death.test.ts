/**
 * THE REHEARSAL SERVER DOES NOT LOG ITSELF TO DEATH.
 *
 * Run 18 of the £0 greenfield harness (2026-09-14): MockServer at its default INFO level writes,
 * for EVERY expectation a request fails to match, the whole request — 536 expectations × a 157KB
 * prompt = 84MB of log per call, 1.5GB of container stdout in an hour, and the JVM's log ring
 * buffer ran out of heap 40 seconds into the run ("OutOfMemoryError: Java heap space" inside
 * SimpleFormatter.format). Every call after that hung or fell to the catch-all, the roster review
 * timed out at 30 minutes, and the run reported a pipeline regression that was the mock dying.
 *
 * The declaration is what runs, so the declaration is what is judged: compose renders it, and the
 * rendered service must not log at a level that reproduces the request per expectation, and its
 * container log must be capped so a day of rehearsals cannot fill the disk.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../..');
const COMPOSE = path.join(REPO, 'orchestrations/mock-llm/docker-compose.yml');

function rendered(): any {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, 'config', '--format', 'json'], {
    encoding: 'utf8', cwd: path.dirname(COMPOSE), env: { ...process.env, EPAM_MOCK_SUBNET: '172.29.0.0/16' },
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe('the rehearsal server does not log itself to death', () => {
  const cfg = rendered();
  const svc = cfg.services && cfg.services.mockserver;

  it('the mockserver service renders (the test is not judging nothing)', () => {
    expect(svc).toBeTruthy();
    expect(svc.image).toMatch(/mockserver/);
  });

  it('logs at a level that does NOT reproduce the request for every expectation it fails to match', () => {
    const level = String((svc.environment || {}).MOCKSERVER_LOG_LEVEL || '').toUpperCase();
    expect(level, 'MOCKSERVER_LOG_LEVEL must be declared — the default is INFO, which killed run 18').not.toBe('');
    expect(['WARN', 'ERROR', 'WARNING']).toContain(level);
  });

  it('its container log is capped — a day of rehearsals cannot fill the disk', () => {
    const opts = (svc.logging && svc.logging.options) || {};
    expect(String(opts['max-size'] || '')).toMatch(/^\d+[kmg]$/i);
    expect(Number(opts['max-file'] || 0)).toBeGreaterThan(0);
  });

  it('stays memory-bound with the ceiling it already had', () => {
    expect(svc.mem_limit || svc.deploy?.resources?.limits?.memory).toBeTruthy();
    expect(svc.memswap_limit).toBeTruthy();
  });
});
