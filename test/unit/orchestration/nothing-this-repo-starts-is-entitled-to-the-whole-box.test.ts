/**
 * NOTHING THIS REPOSITORY STARTS IS ENTITLED TO THE WHOLE MACHINE.
 *
 * Standing operator rule, restated 2026-09-04: "I have stated this 100+ times: processes cannot be
 * unbounded for memory." It has been broken in three different shapes now, and the shapes matter
 * because each one was invisible from where the previous fix was made:
 *
 *   1. a command I typed (vitest, twice in one turn — WSL died)
 *   2. a container started ad-hoc (MockServer at 7.1GB of 14GB)
 *   3. a service declared in compose with no `mem_limit` at all
 *
 * Shape 3 is what this file closes. `docker stats` on 2026-09-04 showed FIVE of the seven
 * observability services reporting the host's entire 13.65GiB as their limit — postgres, redis,
 * langfuse-server, agent-monitor and grafana. Only clickhouse was bounded, because only clickhouse
 * had ever caused a visible problem. A limit added one service at a time, after each incident, is
 * not a policy.
 *
 * `memswap_limit` is required ALONGSIDE `mem_limit` and is not decoration: with mem_limit alone a
 * throttled process escapes into swap and the bound becomes advisory. This is the same finding as
 * run-bounded.sh's MemorySwapMax=0 — proven live, a 4GB allocation succeeded under a 698MB ceiling
 * by swapping.
 *
 * DERIVED, NEVER LISTED: compose files are globbed and their services parsed, so a service added
 * tomorrow is checked tomorrow rather than whenever someone remembers this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');

/** Every compose file this repository ships — found by git, so nothing untracked skews it. */
function composeFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*docker-compose*.yml', '*docker-compose*.yaml'],
    { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => existsSync(join(REPO, f)));
}

/**
 * Services and the keys each declares. Parsed by indentation rather than with a YAML dependency:
 * these files are plain two-space compose documents, and the parse is asserted below by requiring
 * that services were actually found.
 */
function servicesOf(file: string): Array<{ name: string; keys: Set<string> }> {
  const lines = readFileSync(join(REPO, file), 'utf8').split('\n');
  const out: Array<{ name: string; keys: Set<string> }> = [];
  let inServices = false;
  let cur: { name: string; keys: Set<string> } | null = null;

  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    if (/^services:\s*$/.test(raw)) { inServices = true; continue; }
    if (/^[a-zA-Z_]/.test(raw)) {                 // any other top-level key ends the block
      if (cur) { out.push(cur); cur = null; }
      inServices = /^services:/.test(raw);
      continue;
    }
    if (!inServices) continue;
    const svc = raw.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
    if (svc) { if (cur) out.push(cur); cur = { name: svc[1], keys: new Set() }; continue; }
    const key = raw.match(/^ {4}([A-Za-z0-9._-]+):/);
    if (key && cur) cur.keys.add(key[1]);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A service that only EXTENDS or overrides another (an override file's partial entry) is bounded
 * by its base. Only a service that defines what to run needs its own bound here.
 */
const DEFINES_A_CONTAINER = (keys: Set<string>) => keys.has('image') || keys.has('build');

const CASES = composeFiles().flatMap((file) =>
  servicesOf(file)
    .filter((s) => DEFINES_A_CONTAINER(s.keys))
    .map((s) => ({ file, name: s.name, keys: s.keys })));

/**
 * AND EVERY STACK MUST BE ABLE TO START ON A HOST WHOSE ADDRESS POOL IS EXHAUSTED.
 *
 * Measured on this host, 2026-09-04: SEVEN networks held subnets, several /16s in docker's default
 * range were visibly free, and `docker network create probe` still failed with
 *
 *     all predefined address pools have been fully subnetted
 *
 * The daemon does not reliably release a removed network's pool, and `docker network prune` did
 * not recover it. A `--subnet` request is served from the request itself and never consults the
 * pool, so it SUCCEEDS on exactly the host where an allocated one fails — proven both ways before
 * this was written.
 *
 * docker-compose.observability.yml has named its subnet since 2026-09-03 and says why: it "is the
 * reason an install succeeds on a corporate laptop with the VPN up — which is the normal case, not
 * the exception". The same reasoning applies to every stack this repo ships, and three of them had
 * not been given it.
 *
 * The rule is derived, not a list: a file that DEFINES a container must name a subnet. An override
 * that only adds volumes or limits defines none and needs none.
 */
describe('every stack this repo ships names its own subnet', () => {
  const files = composeFiles().filter((f) => servicesOf(f).some((s) => DEFINES_A_CONTAINER(s.keys)));

  it('there are container-defining compose files to check', () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it.each(files)('%s', (file) => {
    expect(readFileSync(join(REPO, file), 'utf8'), [
      `${file} names no subnet, so compose asks docker to allocate one from its default pools.`,
      'On a host whose pools are exhausted — which happens without every /16 being in use, because',
      'the daemon does not reliably release a removed network\'s — the stack cannot start at all.',
      'Declare it the way docker-compose.observability.yml does:',
      '',
      '  networks:',
      '    default:',
      '      ipam:',
      '        config:',
      '          - subnet: ${SOME_OVERRIDE:-172.X.0.0/16}',
    ].join('\n')).toMatch(/subnet:/);
  });
});

describe('every container this repo declares carries a memory bound', () => {
  it('compose files and services were actually parsed — otherwise every case is vacuous', () => {
    expect(composeFiles().length, 'no compose files found under git').toBeGreaterThan(0);
    expect(CASES.length, 'no services parsed — the indentation parse broke, not the compose files')
      .toBeGreaterThan(3);
  });

  it.each(CASES)('$file :: $name', ({ file, name, keys }) => {
    expect(keys.has('mem_limit'), [
      `${file}: service '${name}' declares no mem_limit, so docker grants it the entire host.`,
      '`docker stats` reports its limit as the box\'s total RAM. On WSL the OOM victim is the whole',
      'environment, not the offending container — that is how the observability stack took the VM',
      'down mid-run on 2026-09-02.',
    ].join('\n')).toBe(true);

    expect(keys.has('memswap_limit'), [
      `${file}: service '${name}' sets mem_limit without memswap_limit, which makes the bound`,
      'ADVISORY: a throttled process escapes into swap instead of being stopped. Proven live —',
      'a 4GB allocation succeeded under a 698MB ceiling by swapping. Set memswap_limit equal to',
      'mem_limit so the ceiling is real.',
    ].join('\n')).toBe(true);
  });
});
