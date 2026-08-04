/**
 * The manifest must be correct WHERE IT IS PRODUCED.
 *
 * TWO FAILURES THIS FILE EXISTS FOR.
 *
 * 1. THE DEFECT. buildPerCodelineManifest() resolves every declared path against the
 *    lane's real checkout, but technicalNotes.files keeps the DECLARED spelling. Live
 *    2026-08-04 (run 20260804T035435Z) two of three lanes paused with a manifest naming
 *    a file that does not exist:
 *        upexpress  manifest: ContentstackContext.tsx   on disk: ContentstackContext.ts
 *        metrolinx  manifest: ContentstackContext.tsx   on disk: contentstackContext.tsx
 *    That contradiction is what sent a writer into a 120-iteration, ~2M-token loop.
 *
 * 2. MY WRONG FIX. I first projected the manifest in _filtered_prd (run-agent-
 *    orchestration.sh), which builds each lane's PRD. But the lane PRD is built BEFORE
 *    the spec pass runs — 03:55:59 for both, filter first — so perCodeline did not exist
 *    yet and the projection was a silent no-op. Six tests passed anyway, because I fed
 *    _filtered_prd a PRD that ALREADY had perCodeline: input the real pipeline never
 *    produces at that point. Testing the receiver with hand-made input is the same
 *    mistake the whole investigation is about.
 *
 * So this test drives the REAL producer — applySpecChanges — against a REAL checkout on
 * disk, and asserts on what it persists. The fixture invents its own names; nothing here
 * is project-, vendor- or codeline-specific.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applySpecChanges } = require('../../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Two real checkouts. The same logical file is spelled differently in each, and
 * differently again from what the story declares — the live condition.
 */
function twoLaneWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'manifest-src-'));
  dirs.push(root);

  const alpha = join(root, 'alpha');
  mkdirSync(join(alpha, 'src/ctx'), { recursive: true });
  writeFileSync(join(alpha, 'src/ctx/widgetContext.tsx'), 'export const a = 1;\n'); // lower w
  writeFileSync(join(alpha, 'src/shared.ts'), 'export const s = 1;\n');

  const beta = join(root, 'beta');
  mkdirSync(join(beta, 'src/ctx'), { recursive: true });
  writeFileSync(join(beta, 'src/ctx/WidgetContext.ts'), 'export const b = 1;\n');   // .ts
  writeFileSync(join(beta, 'src/shared.ts'), 'export const s = 1;\n');

  return { root, alpha, beta };
}

function prdFor(w: ReturnType<typeof twoLaneWorkspace>) {
  return {
    project: {
      outputDirs: [
        { codeline: 'alpha', path: w.alpha },
        { codeline: 'beta', path: w.beta },
      ],
    },
    stories: [
      {
        id: 'ST-1',
        title: 'spanning story',
        codelines: ['alpha', 'beta'],
        // DECLARED: matches NEITHER lane exactly.
        technicalNotes: { files: ['src/ctx/WidgetContext.tsx', 'src/shared.ts'] },
      },
    ],
  };
}

/** Run the REAL producer the way the spec pass does. */
function runSpecPass() {
  const w = twoLaneWorkspace();
  const prd = prdFor(w);
  const story = prd.stories[0];
  applySpecChanges(story, { technicalNotes: story.technicalNotes }, [], prd, 'core', 'run-1', w.root);
  return { w, story };
}

describe('the manifest is resolved where it is produced', () => {
  it('produces a per-lane manifest at all (guard against a vacuous pass)', () => {
    const { story } = runSpecPass();
    expect(
      story.technicalNotes.perCodeline,
      'buildPerCodelineManifest did not run, so every assertion below proves nothing',
    ).toBeTruthy();
  });

  it("REPRODUCES THE LIVE DEFECT: alpha's list names the file alpha actually has", () => {
    const { story } = runSpecPass();
    const files = story.technicalNotes.perCodeline.alpha.files;
    expect(
      files,
      'the lane manifest kept the declared spelling — the writer would be sent to a path ' +
        'this checkout does not have, which is the 2M-token loop',
    ).toContain('src/ctx/widgetContext.tsx');
    expect(files).not.toContain('src/ctx/WidgetContext.tsx');
  });

  it("beta's list names the file beta actually has (different variant)", () => {
    const { story } = runSpecPass();
    const files = story.technicalNotes.perCodeline.beta.files;
    expect(files).toContain('src/ctx/WidgetContext.ts');
    expect(files).not.toContain('src/ctx/WidgetContext.tsx');
  });

  it('every resolved path EXISTS in that lane — checked against the real filesystem', () => {
    const { w, story } = runSpecPass();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs');
    for (const [lane, root] of [['alpha', w.alpha], ['beta', w.beta]] as const) {
      for (const f of story.technicalNotes.perCodeline[lane].files) {
        expect(existsSync(join(root, f)), `${lane} manifest names a missing file: ${f}`).toBe(true);
      }
    }
  });

  it('a path both lanes share is untouched', () => {
    const { story } = runSpecPass();
    expect(story.technicalNotes.perCodeline.alpha.files).toContain('src/shared.ts');
    expect(story.technicalNotes.perCodeline.beta.files).toContain('src/shared.ts');
  });

  it('an unresolvable path is RECORDED, not silently dropped', () => {
    const w = twoLaneWorkspace();
    const prd = prdFor(w);
    prd.stories[0].technicalNotes.files.push('src/ctx/DoesNotExist.tsx');
    const story = prd.stories[0];
    applySpecChanges(story, { technicalNotes: story.technicalNotes }, [], prd, 'core', 'run-1', w.root);
    const unresolved = story.technicalNotes.perCodeline.alpha.unresolved;
    expect(
      unresolved.map((u: { declared: string }) => u.declared),
      'a path that exists in NO lane vanished instead of being flagged',
    ).toContain('src/ctx/DoesNotExist.tsx');
  });
});

/**
 * THE FLAT LIST IS WHAT THE WRITER READS. perCodeline was always correct; nothing
 * consumed it. technicalNotes.files kept the declared spelling and that is the list
 * rendered into the prompt, handed to the reviewer, and checked by the gates.
 *
 * The spec pass runs PER LANE, on that lane's own filtered PRD, so within a lane the
 * flat list can and must be that lane's resolved list. The lane is derived the same way
 * everywhere else in the engine: project.outputDir matched against project.outputDirs[].
 */
describe('the flat manifest the writer reads is resolved for THIS lane', () => {
  function runInLane(lane: 'alpha' | 'beta') {
    const w = twoLaneWorkspace();
    const prd = prdFor(w) as Record<string, any>;
    // A lane's filtered PRD carries project.outputDir set to that lane's checkout.
    prd.project.outputDir = lane === 'alpha' ? w.alpha : w.beta;
    const story = prd.stories[0];
    applySpecChanges(story, { technicalNotes: story.technicalNotes }, [], prd, 'core', 'run-1', w.root);
    return { w, story };
  }

  it("REPRODUCES THE LIVE DEFECT: alpha's flat files list holds alpha's real spelling", () => {
    const { story } = runInLane('alpha');
    expect(
      story.technicalNotes.files,
      'technicalNotes.files kept the DECLARED name. This is the list the writer prompt, ' +
        'the reviewer and the gates all read — perCodeline being correct helps nobody.',
    ).toContain('src/ctx/widgetContext.tsx');
    expect(story.technicalNotes.files).not.toContain('src/ctx/WidgetContext.tsx');
  });

  it("beta's flat list holds beta's real spelling", () => {
    const { story } = runInLane('beta');
    expect(story.technicalNotes.files).toContain('src/ctx/WidgetContext.ts');
    expect(story.technicalNotes.files).not.toContain('src/ctx/WidgetContext.tsx');
  });

  it('every flat path EXISTS in that lane', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs');
    for (const lane of ['alpha', 'beta'] as const) {
      const { w, story } = runInLane(lane);
      const root = lane === 'alpha' ? w.alpha : w.beta;
      for (const f of story.technicalNotes.files) {
        expect(existsSync(join(root, f)), `${lane}: flat manifest names a missing file: ${f}`).toBe(true);
      }
    }
  });

  it('with NO lane derivable, the declared list is left alone (single-codeline runs)', () => {
    const { story } = runSpecPass(); // no project.outputDir set
    expect(story.technicalNotes.files).toContain('src/ctx/WidgetContext.tsx');
  });
});
