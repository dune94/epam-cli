/**
 * An estate whose codelines depend on each other must resolve those locally.
 *
 * Live AMSD-2041, 2026-07-28. All three discovered codelines depend on a private
 * package from a registry that answers:
 *
 *   npm error code E401
 *   npm error 401 Unauthorized - GET https://npm.pkg.github.com/@metrolinx%2fcx-shared
 *   npm error unauthenticated: User cannot be authenticated with the token provided.
 *
 * So no codeline could install, no toolchain could resolve, and no gate could
 * run. But that package is ALREADY IN THE ESTATE — a sibling directory whose own
 * manifest declares exactly that name, cloned and built. The dependency the
 * registry would not serve was on disk the whole time.
 *
 * Note the provider is NOT one of the selected codelines: discovery returned
 * three brand sites, and the shared library is a fourth directory nobody
 * selected. So the provider map is built from the estate ROOT, not from the
 * lanes the run happens to be working in.
 *
 * GENERIC. Nothing here knows a vendor, a scope, or a repository name. It reads
 * the `name` field of every manifest under the root and matches it against
 * dependencies that could not be resolved. Any estate whose codelines depend on
 * one another benefits — which is the multi-codeline case MC-1 exists for.
 *
 * RESTART-SAFE, by user requirement: links are re-established on EVERY run. A
 * direct symlink inside the consumer's own node_modules, not `npm link`'s global
 * store, so nothing depends on state outside the estate; a dangling link left by
 * a reboot or a wiped node_modules is detected and repaired rather than assumed.
 *
 * It never edits package.json — the declared dependency is unchanged; only its
 * resolution is satisfied locally.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HEALTH = join(__dirname, '../../../orchestrations/scripts/lib/codeline-health.sh');

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** An estate root containing several codelines. */
function estate() {
  const root = mkdtempSync(join(tmpdir(), 'estate-'));
  roots.push(root);
  return {
    root,
    /** A codeline directory with a manifest. */
    add(dir: string, manifest: Record<string, unknown>, installed: string[] = []) {
      const p = join(root, dir);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'package.json'), JSON.stringify(manifest));
      writeFileSync(join(p, 'package-lock.json'), '{}');
      for (const pkg of installed) {
        mkdirSync(join(p, 'node_modules', pkg), { recursive: true });
        writeFileSync(join(p, 'node_modules', pkg, 'package.json'), '{}');
      }
      return p;
    },
  };
}

function assess(root: string, paths: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [HEALTH, '--root', root, ...paths], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CODELINE_HEALTH_NO_INSTALL: '1', CODELINE_HEALTH_NO_PULL: '1', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const CONSUMER = {
  name: 'brand-site',
  scripts: { test: 'jest', build: 'shared-lib-build' },
  devDependencies: { jest: '^29.0.0' },
  dependencies: { '@org/shared': '^7.0.0' },
};

describe('a dependency the registry cannot serve is resolved from the estate', () => {
  it('links a sibling codeline that declares that exact package name', () => {
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } }, ['jest']);

    const r = assess(e.root, [consumer]);
    const link = join(consumer, 'node_modules/@org/shared');
    expect(existsSync(link), `expected local link, got:\n${r.out}`).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(e.root, 'shared'));
  });

  it('reports healthy once the local link satisfies it', () => {
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } }, ['jest']);
    expect(assess(e.root, [consumer]).code).toBe(0);
  });

  it('builds the provider map from the ESTATE, not the selected lanes', () => {
    // The live provider was a directory nobody selected: discovery returned the
    // brand sites, the shared library was a fourth directory.
    const e = estate();
    e.add('not-a-lane', { name: '@org/shared', version: '1.0.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } }, ['jest']);
    assess(e.root, [consumer]);   // only the consumer is passed as a lane
    expect(existsSync(join(consumer, 'node_modules/@org/shared'))).toBe(true);
  });

  it('leaves a dependency nobody provides as UNHEALTHY', () => {
    const e = estate();
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/nowhere && jest' },
                                     dependencies: { '@org/nowhere': '^1.0.0' } }, ['jest']);
    const r = assess(e.root, [consumer]);
    expect(r.code, 'an unresolvable dependency was reported healthy').not.toBe(0);
  });
});

describe('links survive restarts because they are re-made every run', () => {
  it('repairs a dangling link left by a reboot or a wiped node_modules', () => {
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } }, ['jest']);

    // A link pointing at somewhere that no longer exists.
    mkdirSync(join(consumer, 'node_modules/@org'), { recursive: true });
    symlinkSync(join(e.root, 'gone-after-restart'), join(consumer, 'node_modules/@org/shared'));

    const r = assess(e.root, [consumer]);
    expect(readlinkSync(join(consumer, 'node_modules/@org/shared')),
      `a dangling link was left in place:\n${r.out}`)
      .toBe(join(e.root, 'shared'));
    expect(r.code).toBe(0);
  });

  it('is idempotent — running twice changes nothing', () => {
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } }, ['jest']);
    assess(e.root, [consumer]);
    const first = readlinkSync(join(consumer, 'node_modules/@org/shared'));
    const r = assess(e.root, [consumer]);
    expect(readlinkSync(join(consumer, 'node_modules/@org/shared'))).toBe(first);
    expect(r.code).toBe(0);
  });

  it('never replaces a real installed package with a link', () => {
    // If it is genuinely installed from a registry, that is what the project
    // asked for — do not silently substitute a working copy.
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } },
                           ['jest', '@org/shared']);
    assess(e.root, [consumer]);
    expect(lstatSync(join(consumer, 'node_modules/@org/shared')).isSymbolicLink(),
      'a real installed package was replaced by a link to a working copy')
      .toBe(false);
  });
});

describe('it does not rewrite the client project', () => {
  it('leaves package.json untouched', () => {
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const manifest = { ...CONSUMER, scripts: { test: '@org/shared && jest' } };
    const consumer = e.add('site', manifest, ['jest']);
    assess(e.root, [consumer]);
    expect(JSON.parse(require('node:fs').readFileSync(join(consumer, 'package.json'), 'utf8')))
      .toEqual(manifest);
  });

  it('says what it linked and to where', () => {
    const e = estate();
    e.add('shared', { name: '@org/shared', version: '7.11.0' });
    const consumer = e.add('site', { ...CONSUMER, scripts: { test: '@org/shared && jest' } }, ['jest']);
    const r = assess(e.root, [consumer]);
    expect(r.out).toMatch(/@org\/shared/);
    expect(r.out).toMatch(/link/i);
  });
});
