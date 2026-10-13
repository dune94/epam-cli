/**
 * THE PROMPT-INPUT DIGEST COVERS ONLY THE TEMPLATES THE BUILD READS.
 *
 * AMSD-2974 run 9 iteration 3 (2026-10-13): adding release-line-port.json — an engine template no project prompt is
 * built from — changed the digest (it covered every template in the layer); the resume read every kept prompt as
 * stale and sent all 44 back to the reviewer, paid, mid-run. Operator: "I don't want a full review".
 *
 * EXECUTED: the real promptInputsDigest on a copy of the real prompt layer — an engine-only template added, and a
 * template the build reads changed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const B = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'));
const REG = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function layer() {
  const d = mkdtempSync(join(tmpdir(), 'digest-')); dirs.push(d);
  cpSync(join(ROOT, 'orchestrations/prompts'), join(d, 'prompts'), { recursive: true });
  const tdir = join(d, 'prompts/templates');
  return { tdir, digest: () => B.promptInputsDigest({ templatesDir: tdir, registryFile: REG }) };
}

describe('the prompt-input digest covers only what the build reads', () => {
  it('an engine-only template added: the digest is unchanged — no kept prompt is stale', () => {
    const l = layer(); const before = l.digest();
    writeFileSync(join(l.tdir, 'zz-engine-only.json'), JSON.stringify({ id: 'zz-engine-only', seams: [], body: 'x' }));
    expect(l.digest()).toBe(before);
  });

  it('NEGATIVE: a template the build reads (the generator\'s own, from bootstrap.copyVerbatim) changed: the digest changes', () => {
    const l = layer(); const before = l.digest();
    const boot = JSON.parse(readFileSync(join(l.tdir, '..', 'bootstrap.json'), 'utf8'));
    const id = boot.copyVerbatim[0];
    const f = join(l.tdir, `${id}.json`); const t = JSON.parse(readFileSync(f, 'utf8'));
    t.body = `${t.body || ''}\n`; writeFileSync(f, JSON.stringify(t));
    expect(l.digest()).not.toBe(before);
  });

  it('NEGATIVE: a seam template the registry provisions changed: the digest changes', () => {
    const l = layer(); const before = l.digest();
    const reg = JSON.parse(readFileSync(REG, 'utf8'));
    const id = Object.values(reg.profiles || {}).map((p: any) => p && p.template).find((t: string) => t && !/release-line-port/.test(t));
    const f = join(l.tdir, `${id}.json`); const t = JSON.parse(readFileSync(f, 'utf8'));
    t.body = `${t.body || ''}\n`; writeFileSync(f, JSON.stringify(t));
    expect(l.digest()).not.toBe(before);
  });
});
