/**
 * THE DASHBOARD MUST NOT DEPEND ON CONTAINER DNS.
 *
 * nginx resolved its upstream by SERVICE NAME (`proxy_pass http://launch-api:8099`), which needs
 * the container engine to run a DNS server. Docker always does. Rootless podman on this host does
 * not: netavark writes aardvark-dns's config — the alias `launch-api` is registered at its real
 * address — but never starts the daemon, so nginx died with
 *
 *   [emerg] host not found in upstream "launch-api"
 *
 * 124 times across 62 restarts, and the install ended "✗ install incomplete". Proven to be DNS
 * alone: the same containers reach each other by IP, and aardvark-dns stays up when started by
 * hand.
 *
 * A name lookup between two containers of the SAME stack is a dependency the stack does not need.
 * Sharing one network namespace makes the API reachable on loopback, which needs no resolver on
 * any runtime — so this removes the failure rather than working around it.
 *
 * The published port then belongs to the container that OWNS the namespace: a service using
 * another's namespace cannot publish ports, and compose refuses to start if it tries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMPOSE = readFileSync(join(ROOT, 'launch-dashboard', 'docker-compose.yml'), 'utf8');
const NGINX = readFileSync(join(ROOT, 'launch-dashboard', 'frontend', 'nginx.conf'), 'utf8');

/** The block of one service, so an assertion cannot pass on a neighbour's lines. */
function service(name: string): string {
  const m = COMPOSE.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|$)`));
  expect(m, `service ${name} not found in the compose file`).toBeTruthy();
  return m![1];
}

describe('the launch dashboard', () => {
  it('does not resolve its API by name — nothing guarantees a DNS server', () => {
    expect(NGINX, 'nginx still resolves the API by service name, which fails on any runtime whose '
      + 'DNS daemon is absent').not.toMatch(/proxy_pass\s+https?:\/\/launch-api/);
    expect(NGINX, 'the upstream is not on loopback').toMatch(/proxy_pass\s+https?:\/\/127\.0\.0\.1:/);
  });

  it('the UI shares the API network namespace, which is what makes loopback true', () => {
    expect(service('launch-ui'), 'the UI has its own namespace, so 127.0.0.1 is NOT the API and '
      + 'the proxy would hit nothing').toMatch(/network_mode:\s*["']?service:launch-api/);
  });

  it('the port is published by the namespace OWNER, or compose refuses to start', () => {
    expect(service('launch-ui'), 'a service using another network namespace cannot publish ports')
      .not.toMatch(/^\s+ports:/m);
    expect(service('launch-api'), 'nobody publishes the UI port — the dashboard is unreachable')
      .toMatch(/LAUNCH_UI_PORT/);
  });

  it('the API still listens on the port the proxy targets', () => {
    // Read from the BACKEND IMAGE, which is what actually decides the port — asserting against
    // the compose file would only prove the compose file agrees with itself.
    const port = NGINX.match(/proxy_pass\s+https?:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    expect(port, 'no upstream port in nginx.conf').toBeTruthy();
    const dockerfile = readFileSync(join(ROOT, 'launch-dashboard', 'backend', 'Dockerfile'), 'utf8');
    expect(dockerfile, `nginx proxies to ${port}, which is not the port the API image listens on`)
      .toMatch(new RegExp(`PORT=${port}\\b`));
  });
});
