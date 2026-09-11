/**
 * THE FRAMEWORK'S CONFIG NEVER REACHES THE BROWSER, WHATEVER IT IS CALLED.
 *
 * client-env-boundary-plugin.js flags a `process.env.X` read in code that will run in the browser
 * when the framework substitutes only prefixed names (NEXT_PUBLIC_…) into the client bundle. Its
 * Next.js adapter knows next.config.{js,mjs,ts} is build-time config and exempt.
 *
 * gotransit's config is next.config.source.ts — bundled by esbuild into next.config.js on every
 * `pretest`/`prebuild`. The adapter did not recognise the variant, scanned it as client code, and
 * flagged `process.env.ANALYZE` on line 57 of the CLIENT'S UNCHANGED FILE. Live, on every run of
 * AMSD-1919 since 2026-09-10: a "free" retry, then on the identical second hit HealingBroken → the
 * failure analyst → a ladder climb — ~15 minutes and three model calls per resume. And on
 * 2026-09-11 the writer, told by the retry prompt that ANALYZE was the problem, EDITED
 * next.config.source.ts to destructure it out of process.env — an unrelated change to the client's
 * build config, made to silence a false positive.
 *
 * The exemption is a framework fact: next.config.* is read by Node at build/server time. It is not
 * a gotransit fact, so nothing here names gotransit's file — the fixture is a Next.js project with
 * a config variant, and a real client file to prove the check is not weakened.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const plugin = require(join(ROOT, 'orchestrations/plugins/client-env-boundary-plugin.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function nextProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'next-cfg-')); dirs.push(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'fx', dependencies: { next: '14.0.0', react: '18.0.0' },
    scripts: { 'build:config': 'esbuild next.config.source.ts --bundle --outfile=next.config.js --platform=node', pretest: 'npm run build:config' },
  }));
  // The framework's config, in a bundled-source variant: a bare env read at build time.
  writeFileSync(join(d, 'next.config.source.ts'), [
    'const withBundleAnalyzer = require("@next/bundle-analyzer")({',
    '  enabled: process.env.ANALYZE === "true",',
    '});',
    'module.exports = withBundleAnalyzer({ reactStrictMode: true });',
  ].join('\n'));
  // The generated config, as pretest leaves it on disk.
  writeFileSync(join(d, 'next.config.js'), 'module.exports={reactStrictMode:true};');
  // A real browser component reading a non-public name: THIS must still be flagged.
  mkdirSync(join(d, 'src/components'), { recursive: true });
  writeFileSync(join(d, 'src/components/Banner.tsx'), [
    'import { useEffect } from "react";',
    'export function Banner() {',
    '  useEffect(() => { if (process.env.FEATURE_BANNER === "true") { console.log("on"); } }, []);',
    '  return null;',
    '}',
  ].join('\n'));
  return d;
}

describe('a framework config file is not browser code', () => {
  it('the adapter engages and a real client read IS flagged — otherwise the case below is vacuous', () => {
    const r = plugin.scanClientEnvBoundary(nextProject(), ['src/components/Banner.tsx']);
    expect(r.exposureDeclared, 'the Next.js adapter did not engage on the fixture').toBe(true);
    expect(r.findings.map((f: any) => f.variable), 'a browser read of a non-public name must be flagged').toEqual(['FEATURE_BANNER']);
  });

  it('a config variant (next.config.source.ts) is build-time code and produces no finding', () => {
    const r = plugin.scanClientEnvBoundary(nextProject(), ['next.config.source.ts']);
    expect(r.findings, [
      'next.config.source.ts is the framework config, read by Node at build time; nothing in it reaches',
      'a browser bundle. Flagging it sent the writer to edit the client\'s build config to silence a',
      'false positive, and cost ~15 minutes of retries per resume. Findings:',
      JSON.stringify(r.findings),
    ].join('\n')).toEqual([]);
  });
});
