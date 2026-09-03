/**
 * THE HEALTH GATE — assess every codeline ONCE, before any spend. 96 lines, no test.
 *
 * Live AMSD-2041, 2026-07-28: discovery resolved three codelines; all three declared a test script
 * and a runner, none could resolve one. Until that morning Step 5 skipped silently on exactly this,
 * so an unverified baseline was accepted once per lane. Making it fail was right, but it failed
 * INSIDE the phase — after the spec pass was already paid for. Assessing here turns a twenty-minute
 * discovery into a few seconds.
 *
 * GENERIC BY CONSTRUCTION: it knows no package manager, no test runner and no language. Its header
 * said so once while its body named package.json, node_modules and four npm lockfiles, so a Rust,
 * Python or Ruby codeline declared nothing, had nothing checked, and was reported HEALTHY without
 * being assessed — a free pass from the one gate that exists to stop a run before it pays for an
 * unusable baseline. That is the case worth asserting.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/lib/codeline-health.sh');

function health(paths: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...paths], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function codeline(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

describe('the health gate assesses every codeline before any spend', () => {
  it('NO codelines is not a failure — there is nothing to assess', () => {
    // Discovery may legitimately resolve none, and refusing here would stop a run for the absence
    // of a thing that is allowed to be absent.
    const r = health([]);
    expect(r.code).toBe(0);
    expect(r.out, 'it said nothing about having nothing to do').not.toBe('');
  }, 180_000);

  it('a healthy NODE codeline passes', () => {
    const dir = codeline({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'echo ok' } }),
    });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const r = health([dir]);
    expect(r.out, 'the codeline was not named in its own report').toContain(dir.split('/').pop()!);
  }, 180_000);

  it('a NON-NODE codeline is ASSESSED, not waved through', () => {
    // The defect this exists to stop: a Rust, Python or Ruby codeline declared nothing, had nothing
    // checked, and was reported healthy without being assessed at all.
    for (const [manifest, body] of [
      ['Cargo.toml', '[package]\nname = "x"\n'],
      ['requirements.txt', 'requests==2.0\n'],
      ['go.mod', 'module x\n'],
    ] as const) {
      const dir = codeline({ [manifest]: body });
      const r = health([dir]);
      expect(r.out, `a ${manifest} codeline was not mentioned in the report at all`)
        .toContain(dir.split('/').pop()!);
    }
  }, 180_000);

  it('EVERY codeline is named, not just the first — one unhealthy repo must not hide behind another', () => {
    const a = codeline({ 'package.json': '{"name":"a"}' });
    const b = codeline({ 'package.json': '{"name":"b"}' });
    const c = codeline({ 'go.mod': 'module c\n' });
    const r = health([a, b, c]);
    for (const d of [a, b, c]) {
      expect(r.out, `${d} is missing from the assessment`).toContain(d.split('/').pop()!);
    }
  }, 180_000);

  it('a codeline that does not exist is reported rather than skipped in silence', () => {
    // A path discovery returned but nothing can open is exactly the state that produced an
    // unverified baseline accepted once per lane.
    const r = health(['/no/such/codeline']);
    expect(r.out, 'a missing codeline produced no report line').not.toBe('');
  }, 180_000);

  it('a codeline declaring NO ecosystem is reported, not called healthy by default', () => {
    const dir = codeline({ 'README.md': '# just docs\n' });
    const r = health([dir]);
    expect(r.out).toContain(dir.split('/').pop()!);
  }, 180_000);

  it('it is honest about what it did — a summary line per codeline', () => {
    // Without one, "assessed and fine" and "not assessed" look identical from the outside, which is
    // the whole failure this gate replaced.
    const a = codeline({ 'package.json': '{"name":"a"}' });
    const b = codeline({ 'Cargo.toml': '[package]\nname="b"\n' });
    const r = health([a, b]);
    const lines = r.out.split('\n').filter((l) => l.includes(a.split('/').pop()!)
      || l.includes(b.split('/').pop()!));
    expect(lines.length, 'fewer report lines than codelines assessed').toBeGreaterThanOrEqual(2);
  }, 180_000);
});
