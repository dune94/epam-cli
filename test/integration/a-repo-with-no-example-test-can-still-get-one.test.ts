/**
 * A REPO WITH NO EXAMPLE TEST IS EXACTLY WHERE A REPRO TEST IS NEEDED.
 *
 * brownfield-repro-test-writer.sh offers the writer an example test to mirror:
 *
 *     _example_block=""
 *     if [ -n "$_example_rel" ] && [ -f "$PROJECT_ROOT/$_example_rel" ]; then _example_block=...
 *
 * so a codeline with no existing test leaves it empty. prompt-library refuses any DECLARED
 * placeholder that renders empty — correctly, because an agent cannot tell a failed lookup from a
 * genuinely absent one — and the template declared no `mayBeEmpty`. The seam then printed
 *
 *     FATAL: the repro-test-writer prompt did not render — refusing to invoke a test writer
 *     with no instructions
 *
 * and exited 1. A repository with no tests is the one that most needs this seam, and it was the
 * one case the seam could not serve.
 *
 * Same shape as code-review-cycle's __PRIOR_CONTEXT__, which could never be non-empty on a first
 * iteration. `mayBeEmpty` exists for exactly this: absent is a real state, and saying so is not the
 * same as loosening the guard — every OTHER placeholder still refuses.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const TEMPLATE = join(REPO, 'orchestrations/prompts/templates/repro-test-writer.json');
const LIB = join(REPO, 'orchestrations/scripts/lib/prompt-library.js');

const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));

/** Render the real template through the real library, with one placeholder left empty. */
function renderWith(empty: string[]) {
  const work = mkdtempSync(join(tmpdir(), 'repro-render-'));
  const proj = join(work, 'proj');
  mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(TEMPLATE, join(proj, 'prompts/repro-test-writer.json'));

  const vals: Record<string, string> = {};
  for (const p of template().placeholders) vals[p] = empty.includes(p) ? '' : 'x';
  const valsFile = join(work, 'vals.json');
  writeFileSync(valsFile, JSON.stringify(vals));

  const r = spawnSync(process.execPath, [LIB, 'render', 'repro-test-writer', proj, valsFile],
    { encoding: 'utf8', timeout: 60000, cwd: REPO });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('a repo with no example test can still get a repro test', () => {
  it('the template declares the placeholders this is about', () => {
    // Guards the vacuous pass: if the placeholder were renamed, every assertion below would hold
    // for the wrong reason.
    const ph: string[] = template().placeholders || [];
    expect(ph, 'the example-block placeholder is gone — the shape has changed')
      .toContain('__EXAMPLE_BLOCK__');
    expect(ph).toContain('__FIX_DIFF__');
  });

  it('renders when there is no example test to mirror', () => {
    const r = renderWith(['__EXAMPLE_BLOCK__']);
    expect(r.code, `the seam cannot run on a repo with no example test:\n${r.err.slice(0, 300)}`)
      .toBe(0);
    expect(r.out.length, 'it rendered nothing').toBeGreaterThan(50);
  }, 60_000);

  it('and still refuses when something that must be present is missing', () => {
    // The negative half. Declaring one placeholder optional must not make the guard permissive:
    // an empty fix diff means the fix changed nothing, which the writer cannot write a test about.
    const r = renderWith(['__FIX_DIFF__']);
    expect(r.code, 'an empty fix diff was accepted — the guard has been loosened, not narrowed')
      .not.toBe(0);
    expect(r.err).toMatch(/EMPTY values/);
  }, 60_000);

  it('a fully supplied render still works', () => {
    const r = renderWith([]);
    expect(r.code, r.err.slice(0, 200)).toBe(0);
  }, 60_000);
});
