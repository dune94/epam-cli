/**
 * buildPerCodelineManifest — resolve every declared file against EACH codeline's own
 * checkout, and record the result per codeline.
 *
 * THE FAILURE THIS CLOSES (live, 2026-08-03, AMSD-2041). `technicalNotes.files` is a
 * single array shared by every lane, but the same logical file has different real names
 * per repo:
 *     gotransit  src/context/ContentstackContext.tsx
 *     upexpress  src/context/ContentstackContext.ts     (different EXTENSION)
 *     metrolinx  src/context/contentstackContext.tsx    (different CASE)
 * The detective's own root-cause fix site was declared once, so it resolved on ONE of
 * three lanes. Two writers were handed a path that does not exist — one of them never
 * touched the provider at all — and a reviewer then blocked that writer for not editing
 * it. At most one lane's path can ever be correct with a shared array; this is
 * structural, not a naming-convention problem, which is why no camelCase rule fixes it.
 *
 * NO CONVENTION IS IMPOSED. Resolution reads the real checkout and reports what is
 * actually there (exact / case variant / extension variant), so it works on the next
 * unknown repo. An unresolvable path is recorded AS unresolved with the candidates
 * checked — never silently dropped and never passed off as real.
 *
 * Codeline→checkout mapping comes from the PRD's own project.outputDirs, so nothing
 * here names a client.
 *
 * Real temp repos. Zero LLM calls.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildPerCodelineManifest } = spec;

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A checkout containing exactly these files. */
function repo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'percl-'));
  cleanup.push(root);
  for (const f of files) {
    const full = join(root, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// fixture\n');
  }
  return root;
}

describe('buildPerCodelineManifest — one manifest per codeline, resolved against its own repo', () => {
  it('REPRODUCES the live case: same logical file, three real names, each lane gets its own truth', () => {
    const go = repo(['src/context/WidgetContext.tsx']);
    const up = repo(['src/context/WidgetContext.ts']);
    const mx = repo(['src/context/widgetContext.tsx']);

    const story = {
      id: 'X-1',
      codelines: ['go', 'up', 'mx'],
      technicalNotes: { files: ['src/context/WidgetContext.tsx'] },
    };
    const prd = {
      project: {
        outputDirs: [
          { codeline: 'go', path: go },
          { codeline: 'up', path: up },
          { codeline: 'mx', path: mx },
        ],
      },
    };

    const out = buildPerCodelineManifest(story, prd);

    expect(Object.keys(out).sort()).toEqual(['go', 'mx', 'up']);
    expect(out.go.files).toEqual(['src/context/WidgetContext.tsx']);
    expect(out.up.files).toEqual(['src/context/WidgetContext.ts']);   // extension variant
    expect(out.mx.files).toEqual(['src/context/widgetContext.tsx']);  // case variant
    for (const cl of ['go', 'up', 'mx']) {
      expect(out[cl].unresolved, `${cl} should have nothing unresolved`).toEqual([]);
    }
  });

  it('records an unresolvable path AS unresolved, with the candidates checked — never silently dropped', () => {
    const a = repo(['src/real.ts']);
    const story = { id: 'X-2', codelines: ['a'], technicalNotes: { files: ['src/does/not/exist.ts'] } };
    const prd = { project: { outputDirs: [{ codeline: 'a', path: a }] } };

    const out = buildPerCodelineManifest(story, prd);

    expect(out.a.files).toEqual([]);
    expect(out.a.unresolved).toHaveLength(1);
    expect(out.a.unresolved[0].declared).toBe('src/does/not/exist.ts');
    expect(out.a.unresolved[0].reason).toBeTruthy();
  });

  it('a file present in one lane and absent in another is resolved in one and flagged in the other', () => {
    const a = repo(['src/only-here.ts']);
    const b = repo(['src/other.ts']);
    const story = { id: 'X-3', codelines: ['a', 'b'], technicalNotes: { files: ['src/only-here.ts'] } };
    const prd = { project: { outputDirs: [{ codeline: 'a', path: a }, { codeline: 'b', path: b }] } };

    const out = buildPerCodelineManifest(story, prd);

    expect(out.a.files).toEqual(['src/only-here.ts']);
    expect(out.b.files).toEqual([]);
    expect(out.b.unresolved.map((u: any) => u.declared)).toEqual(['src/only-here.ts']);
  });

  it('falls back to the single-codeline story shape (story.codeline) when there is no codelines array', () => {
    const a = repo(['src/solo.ts']);
    const story = { id: 'X-4', codeline: 'solo', technicalNotes: { files: ['src/solo.ts'] } };
    const prd = { project: { outputDirs: [{ codeline: 'solo', path: a }] } };

    const out = buildPerCodelineManifest(story, prd);
    expect(out.solo.files).toEqual(['src/solo.ts']);
  });

  it('is a no-op (returns null) when the PRD declares no codeline paths — never invents one', () => {
    const story = { id: 'X-5', codelines: ['a'], technicalNotes: { files: ['src/x.ts'] } };
    expect(buildPerCodelineManifest(story, { project: {} })).toBeNull();
    expect(buildPerCodelineManifest(story, {})).toBeNull();
  });

  it('is a no-op when the story declares no files', () => {
    const a = repo(['src/x.ts']);
    const story = { id: 'X-6', codelines: ['a'], technicalNotes: {} };
    const prd = { project: { outputDirs: [{ codeline: 'a', path: a }] } };
    expect(buildPerCodelineManifest(story, prd)).toBeNull();
  });

  it('carries no client, vendor or convention vocabulary in its implementation', () => {
    const src = buildPerCodelineManifest.toString();
    expect(src).not.toMatch(/contentstack|metrolinx|gotransit|upexpress/i);
    expect(src).not.toMatch(/camel|pascal/i);
  });
});

/**
 * WIRING — a per-codeline manifest that nothing reads is dead data, which is exactly how
 * four plugin tools shipped unusable earlier the same day. These assert the real
 * producer persists it and the real consumer prefers it.
 */
describe('the per-codeline manifest is actually produced and consumed', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const specSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const claudeSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

  it('applySpecChanges persists it onto the story', () => {
    const i = specSrc.indexOf('function applySpecChanges');
    expect(i).toBeGreaterThan(-1);
    const body = specSrc.slice(i);
    expect(body, 'applySpecChanges never calls buildPerCodelineManifest').toMatch(/buildPerCodelineManifest\(/);
    expect(body, 'the result is computed but never stored on the story').toMatch(/perCodeline/);
  });

  it('claude.sh prefers this lane\'s resolved files over the shared flat array', () => {
    expect(
      claudeSrc,
      'the writer prompt still reads only technicalNotes.files, so a lane whose real ' +
        'filename differs is handed a path that does not exist',
    ).toMatch(/perCodeline/);
  });
});
