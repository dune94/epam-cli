/**
 * A CONFIG VALUE READ WHERE IT IS NEVER SUBSTITUTED IS DEAD CODE THAT TYPE-CHECKS.
 *
 * WRITTEN BEFORE THE PLUGIN. RED WHEN WRITTEN.
 *
 * Live 2026-08-14, AMSD-2041 on next.metrolinx.com. The writer shipped:
 *
 *     if (process.env.CONTENTSTACK_LIVE_PREVIEW_ENABLED !== "true") return;   // _app.tsx
 *
 * in a function called from useEffect -- the browser. Next.js only inlines NEXT_PUBLIC_-prefixed
 * variables into the client bundle, and next.config.js exposes no others, so the value is
 * undefined, the guard returns early, and the SDK never initialises. The feature is dead on
 * arrival.
 *
 * NOTHING IN THE PIPELINE COULD SEE IT. eslint:recommended, @typescript-eslint/recommended and
 * next/core-web-vitals carry no rule for this; `process.env.X` is `string | undefined`, so tsc is
 * green. The repo's own eslint config could express it via no-restricted-properties -- but that
 * is a CLIENT repository, which we may not write to. The knowledge has to live on our side.
 *
 * WHAT MAKES THIS PLUGIN GENERIC, which is the whole point of it being a plugin:
 *   - it scans THE CODELINE BEING CHANGED, reading that codeline's own config, so it never
 *     carries a codeline identity and works for gotransit / upexpress / metrolinx alike;
 *   - the framework fact (which prefix, which config file, which contexts are server-only) is an
 *     ADAPTER selected by what the codeline declares in its own package.json. A new stack is a
 *     new adapter, never an engine change;
 *   - a codeline whose stack it cannot identify reports UNDECLARED, never "zero findings".
 *     Absent is absent: silently finding nothing is how a broken check looks exactly like a
 *     clean repository.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const PLUGIN = join(ROOT, 'orchestrations/plugins/client-env-boundary-plugin.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = () => require(PLUGIN);

const CODELINES = ['next.gotransit.com', 'next.upexpress.com', 'next.metrolinx.com']
  .map((c) => ({ name: c, path: join('/home/bradleyjerome/projects/metrolinx', c) }))
  .filter((c) => existsSync(c.path));

describe('THE PLUGIN EXISTS AND DECLARES ITS CONTRACT', () => {
  it('is present at the path the engine loads plugins from', () => {
    expect(existsSync(PLUGIN), 'client-env-boundary-plugin.js is missing').toBe(true);
  });

  it('exports the scan and an api version, like every other plugin here', () => {
    const p = plugin();
    expect(typeof p.scanClientEnvBoundary, 'scanClientEnvBoundary is not exported').toBe('function');
    expect(p.pluginApiVersion, 'no pluginApiVersion — the engine cannot check compatibility').toBeTruthy();
  });
});

describe('IT FINDS THE DEFECT THAT SHIPPED', () => {
  const metrolinx = CODELINES.find((c) => c.name === 'next.metrolinx.com');

  it.runIf(metrolinx)('flags the client-side read of a non-exposed variable in _app.tsx', () => {
    const r = plugin().scanClientEnvBoundary(metrolinx!.path, ['src/pages/_app.tsx']);

    // VACUITY GUARD. Every negative assertion below is worthless if nothing was read.
    expect(r.filesScanned, 'the scan read no files — every assertion here would pass vacuously')
      .toBeGreaterThan(0);
    expect(r.exposureDeclared, 'the plugin could not identify the stack, so it found nothing for the wrong reason')
      .toBe(true);

    const hit = r.findings.find((f: any) => f.variable === 'CONTENTSTACK_LIVE_PREVIEW_ENABLED');
    expect(hit,
      'the plugin did not flag CONTENTSTACK_LIVE_PREVIEW_ENABLED being read in client code — ' +
      'this is the exact line that shipped dead on 2026-08-14')
      .toBeTruthy();
    expect(hit.file).toContain('_app.tsx');
  });
});

describe('IT DOES NOT OVER-INCLUDE — the half a presence test cannot see', () => {
  const metrolinx = CODELINES.find((c) => c.name === 'next.metrolinx.com');

  it.runIf(metrolinx)('does NOT flag server-only contexts, where the value really is substituted', () => {
    // The same commit reads the same variable inside getStaticProps and is CORRECT there --
    // that is the pattern the writer should have reused. A check that flags it teaches the
    // opposite lesson and would push the writer to break working code.
    const r = plugin().scanClientEnvBoundary(metrolinx!.path, ['src/pages/[[...slug]].tsx']);
    expect(r.filesScanned).toBeGreaterThan(0);
    const inServerCtx = r.findings.filter((f: any) => f.variable === 'CONTENTSTACK_LIVE_PREVIEW_ENABLED');
    expect(inServerCtx,
      'flagged a getStaticProps read — server-only contexts are not bundled to the client and are correct')
      .toHaveLength(0);
  });

  it.runIf(metrolinx)('does NOT flag exposed variables', () => {
    const dir = join(tmpdir(), `ceb-exposed-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '^15.0.0' } }));
    writeFileSync(join(dir, 'src/a.tsx'),
      'export const x = () => process.env.NEXT_PUBLIC_THING;\n');

    const r = plugin().scanClientEnvBoundary(dir, ['src/a.tsx']);
    expect(r.filesScanned).toBeGreaterThan(0);
    expect(r.findings, 'flagged a properly exposed NEXT_PUBLIC_ variable').toHaveLength(0);
  });
});

describe('IT IS NOT PINNED TO A CODELINE', () => {
  it('identifies the stack for every codeline in the estate, not just the one it was written against', () => {
    expect(CODELINES.length, 'no codelines present to check against').toBeGreaterThan(0);
    for (const c of CODELINES) {
      const r = plugin().scanClientEnvBoundary(c.path, []);
      expect(r.exposureDeclared, `${c.name}: the plugin could not identify this codeline's stack`).toBe(true);
    }
  });
});

describe('ABSENT IS ABSENT', () => {
  it('reports UNDECLARED for a stack it cannot identify, rather than a clean bill of health', () => {
    const dir = join(tmpdir(), `ceb-unknown-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { cowsay: '^1.0.0' } }));
    writeFileSync(join(dir, 'src/a.js'), 'const t = process.env.SOME_TOKEN;\n');

    const r = plugin().scanClientEnvBoundary(dir, ['src/a.js']);
    expect(r.exposureDeclared,
      'an unidentifiable stack reported as declared — a broken check then looks exactly like a clean repo')
      .toBe(false);
    expect(r.findings, 'guessed findings for a stack whose boundary rule is unknown').toHaveLength(0);
  });

  it('does not crash on a directory that is not a project at all', () => {
    const dir = join(tmpdir(), `ceb-empty-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    expect(() => plugin().scanClientEnvBoundary(dir, [])).not.toThrow();
  });
});
