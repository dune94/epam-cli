/**
 * A codeline must be assessed HEALTHY before the run spends anything on it.
 *
 * Live AMSD-2041, 2026-07-28. Discovery resolved three codelines. All three
 * declare a test script and jest; none could resolve a runner:
 *
 *   next.gotransit.com   node_modules=yes  runner=NONE   <- partial/broken install
 *   next.upexpress.com   node_modules=NO   runner=NONE
 *   next.metrolinx.com   node_modules=NO   runner=NONE
 *
 * Until today Step 5 skipped silently on exactly this, so an unverified baseline
 * was accepted three times over. Making it fail (f1410a2) was right, but it
 * fails INSIDE the phase — after the spec pass has already been paid for. On the
 * next launch that would have cost a full spec pass per lane to discover a
 * dependency problem.
 *
 * So health is assessed once, up front, for whatever codelines DISCOVERY
 * returned — not for a list anyone wrote down. The codelines are resolved per
 * ticket at runtime; pre-installing "the three repos" would hardcode the output
 * of discovery, which is the same defect one level up.
 *
 * GENERIC BY CONSTRUCTION. It does not know npm, jest, or Node. It reads what
 * each codeline itself declares — a manifest, a lockfile naming its package
 * manager — and prepares it accordingly. A codeline with no manifest has nothing
 * to install and is healthy by definition. The next client's stack may be none
 * of these things and this must still hold.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HEALTH = join(__dirname, '../../../orchestrations/scripts/lib/codeline-health.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'cl-health-'));
  dirs.push(d);
  return d;
}

/** A codeline. `manifest` may declare deps; `lock` names the package manager. */
function codeline(opts: {
  manifest?: Record<string, unknown>;
  lock?: string;
  installed?: string[];
} = {}) {
  const d = scratch();
  if (opts.manifest) writeFileSync(join(d, 'package.json'), JSON.stringify(opts.manifest));
  if (opts.lock) writeFileSync(join(d, opts.lock), '{}');
  for (const pkg of opts.installed || []) {
    // Installed == the package directory exists. A .bin entry named after the
    // package would be wrong for scoped packages, whose binary usually has a
    // different name (@11ty/eleventy installs `eleventy`).
    mkdirSync(join(d, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(d, 'node_modules', pkg, 'package.json'), '{}');
  }
  return d;
}

/** Run the assessor. NO_INSTALL keeps tests offline and fast. */
function assess(paths: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [HEALTH, ...paths], {
    // 60s was starvation, not a ceiling on the work. The assessor answers an empty
    // codeline in ~0s standalone, but this file does ~340s of real subprocess work in
    // total, and under full-suite parallel load these children were killed at 60s while
    // merely waiting for CPU — two tests failed in the suite and all 14 passed alone.
    // A genuine hang still fails here, just later; contention no longer reads as a defect.
    encoding: 'utf8', timeout: 180000,
    env: { ...process.env, CODELINE_HEALTH_NO_INSTALL: '1', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('a codeline that declares nothing is healthy', () => {
  it('passes a codeline with no manifest', () => {
    // Content and config repos exist in a real estate. Requiring a manifest
    // would be assuming everything is a Node project.
    const r = assess([codeline()]);
    expect(r.code, `expected healthy, got:\n${r.out}`).toBe(0);
  });

  it('passes a manifest that declares no dependencies', () => {
    expect(assess([codeline({ manifest: { name: 'x' } })]).code).toBe(0);
  });
});

describe('a codeline that declares dependencies must have them resolvable', () => {
  it('reports UNHEALTHY when declared tooling cannot be resolved', () => {
    // The live case: declares a test script and a runner, nothing installed.
    const c = codeline({
      manifest: { name: 'site', scripts: { test: 'jest' }, devDependencies: { jest: '^29.0.0' } },
      lock: 'package-lock.json',
    });
    const r = assess([c]);
    expect(r.code, 'an unprepared codeline was reported healthy').not.toBe(0);
    expect(r.out).toMatch(/unhealthy|not resolvable|missing/i);
  });

  it('reports HEALTHY when they are resolvable', () => {
    const c = codeline({
      manifest: { name: 'site', scripts: { test: 'jest' }, devDependencies: { jest: '^29.0.0' } },
      lock: 'package-lock.json',
      installed: ['jest'],
    });
    expect(assess([c]).code, assess([c]).out).toBe(0);
  });

  it('does not assume which runner — it reads what the codeline declares', () => {
    // The next client may use anything. Nothing here may name a tool.
    const c = codeline({
      manifest: { name: 'site', scripts: { test: 'mocha' }, devDependencies: { mocha: '^10.0.0' } },
      lock: 'package-lock.json',
      installed: ['mocha'],
    });
    expect(assess([c]).code, assess([c]).out).toBe(0);
  });
});

describe('it names every unhealthy codeline, not just the first', () => {
  it('assesses all of them before failing', () => {
    // A dependency the project never invokes is not required tooling — the
    // fixture must declare a script that calls it, which is what the live
    // codelines do.
    const bad1 = codeline({
      manifest: { name: 'a', scripts: { test: 'jest' }, devDependencies: { jest: '^29' } },
      lock: 'package-lock.json' });
    const good = codeline();
    const bad2 = codeline({
      manifest: { name: 'b', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2' } },
      lock: 'package-lock.json' });
    const r = assess([bad1, good, bad2]);
    expect(r.code).not.toBe(0);
    // A run that stops at the first problem hides the other two, so the operator
    // fixes one, relaunches, and waits to find the next.
    expect(r.out).toMatch(/a/);
    expect(r.out).toMatch(/b/);
  });

  it('says which codeline and why', () => {
    const bad = codeline({
      manifest: { name: 'reporting', scripts: { test: 'jest' }, devDependencies: { jest: '^29' } },
      lock: 'package-lock.json' });
    expect(assess([bad]).out).toMatch(/reporting|codeline/i);
  });

  it('ignores a dependency the project never invokes', () => {
    // Declaring a package is not the same as needing it to run. Treating every
    // declared dep as required tooling would fail healthy codelines.
    const c = codeline({
      manifest: { name: 'c', dependencies: { 'some-library': '^1' } },
      lock: 'package-lock.json' });
    expect(assess([c]).code, assess([c]).out).toBe(0);
  });
});

describe('it is honest about what it did', () => {
  it('reports a summary line per codeline', () => {
    const r = assess([codeline(), codeline()]);
    expect((r.out.match(/healthy/gi) || []).length,
      'not every codeline is accounted for in the output').toBeGreaterThanOrEqual(2);
  });

  it('can be bypassed deliberately', () => {
    const bad = codeline({ manifest: { name: 'x', devDependencies: { jest: '^29' } }, lock: 'package-lock.json' });
    expect(assess([bad], { SKIP_CODELINE_HEALTH: '1' }).code,
      'no escape hatch — a false positive would block all work').toBe(0);
  });
});

describe('it never clobbers client work', () => {
  const src = require('node:fs').readFileSync(HEALTH, 'utf8');

  it('pulls fast-forward only', () => {
    expect(src, 'a pull could rewrite client history').toMatch(/--ff-only|ff-only/);
  });

  it('skips a tree with TRACKED changes rather than discarding client work', () => {
    expect(src, 'uncommitted client work could be discarded')
      .toMatch(/status --porcelain/);
  });

  it('does not count its own artefacts as client changes', () => {
    // The pipeline writes .epam/ and .codegraph/ into client repos. Those are
    // untracked, so a plain --porcelain check makes every repo it has ever
    // touched look permanently dirty — meaning it syncs once and never again,
    // silently. Found live: all four codelines reported dirty with nothing in
    // them but our own artefacts.
    expect(src, 'untracked pipeline artefacts would permanently disable syncing')
      .toMatch(/--untracked-files=no/);
  });

  it('never commits inside a client repo', () => {
    expect(src).not.toMatch(/git\s+(-C\s+\S+\s+)?commit/);
  });
});
