/**
 * EVERY IMAGE NAMES ITS REGISTRY.
 *
 * Docker silently resolves a short name like `grafana/grafana:11.4.0` to docker.io. Podman does
 * not — it refuses:
 *
 *   Error: short-name "grafana/grafana:11.4.0" did not resolve to an alias and no
 *   unqualified-search registries are defined in "/etc/containers/registries.conf"
 *
 * Live (2026-09-07, a podman install): SIX of the observability stack's seven services never
 * started for this reason, and `podman compose` still exited 0, so the installer reported
 * "✓ podman is up" over a stack that was one container deep. Only the health check, much later,
 * noticed langfuse and grafana were not serving.
 *
 * A fully-qualified name is what BOTH runtimes accept — docker.io/grafana/grafana:11.4.0 is
 * exactly what docker resolves the short form to — so this removes a runtime difference rather
 * than special-casing one.
 *
 * Scans compose files AND Dockerfiles: `FROM nginx:alpine` fails the same way under podman build.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Tracked compose files and Dockerfiles — never a stale copy under .parked or node_modules. */
function tracked(pattern: RegExp): string[] {
  // maxBuffer: this repo tracks tens of thousands of files and the default 1MB overflows.
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((f) => f && pattern.test(f) && !f.includes('.parked/')
    && !f.includes('node_modules/') && !f.startsWith('test/archived/'));
}

/** A reference is qualified when its first segment is a registry host (contains a dot or port). */
const qualified = (ref: string) =>
  ref.startsWith('localhost/') || /^[^/]+[.:][^/]*\//.test(ref);

describe('container images', () => {
  it('every compose image names its registry', () => {
    const bad: string[] = [];
    for (const f of tracked(/docker-compose[\w.-]*\.ya?ml$/)) {
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        const m = line.match(/^\s+image:\s*["']?([^\s"'#]+)/);
        if (!m) return;
        const ref = m[1];
        if (ref.includes('${')) return;              // env-substituted, resolved elsewhere
        if (!qualified(ref)) bad.push(`${f}:${i + 1} ${ref}`);
      });
    }
    expect(bad, 'short image names — docker resolves these silently, podman refuses them and the '
      + `services never start:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('every Dockerfile base image names its registry', () => {
    const bad: string[] = [];
    for (const f of tracked(/(^|\/)Dockerfile$/)) {
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        const m = line.match(/^FROM\s+(\S+)/i);
        if (!m) return;
        const ref = m[1];
        if (ref.includes('${') || /^scratch$/i.test(ref)) return;
        if (!qualified(ref)) bad.push(`${f}:${i + 1} ${ref}`);
      });
    }
    expect(bad, `short base images — podman build refuses them:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
