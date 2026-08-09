/**
 * THE WRITER PROMPT MUST NOT CARRY ANOTHER CODELINE'S FILES.
 *
 * _render_technical_notes already scopes per-codeline OBJECTS: a key whose value is an object
 * containing this lane's name is replaced by that lane's sub-value. technicalNotes looks like
 *
 *     { "files": [ ...union of all three codelines... ],
 *       "perCodeline": { "gotransit": {"files": [...]}, "upexpress": {...}, "metrolinx": {...} } }
 *
 * so "perCodeline" is narrowed correctly and "files" — an ARRAY, not an object — sails straight
 * through. The rendered prompt therefore states the union AND the lane's own list, and the union
 * wins the argument because it is listed first and looks authoritative.
 *
 * Live 2026-08-09: gotransit's writer prompt named
 * src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx twice. That component
 * exists only in next.metrolinx.com. This is the other half of the deliverable-gate defect
 * (see deliverable-gate-is-scoped-to-its-codeline): the gate demanded a file that does not
 * belong in gotransit BECAUSE the prompt had told the writer to create it. It is also the
 * likeliest explanation for that file appearing in next.gotransit.com during a window when no
 * writer was believed to be running — nothing breached the perimeter, the prompt asked for it.
 *
 * Fixing only the gate would have silenced the rejection while leaving the writer building the
 * wrong component. Both seams read the same bad shape and both had to be scoped.
 *
 * The rule is general, not a special case for "files": when perCodeline carries an entry for
 * this lane, that entry's keys SUPERSEDE the top-level keys of the same name, and perCodeline
 * is not additionally dumped raw. Nothing is hardcoded about which keys exist.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');

/** The shipped function body, lifted verbatim — never a paraphrase. */
function shippedFn(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('_render_technical_notes() {');
  expect(start, '_render_technical_notes not found').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

function render(notes: unknown, codeline: string): string {
  return execFileSync('bash', ['-c',
    `${shippedFn()}\n_render_technical_notes "$1" "$2"`, '_',
    JSON.stringify(notes), codeline,
  ], { encoding: 'utf8' });
}

const SHARED = ['src/services/contentstack.ts', 'src/hooks/useContent.ts'];
const MX_ONLY = 'src/components/contentstack/ContentstackQuote/ContentstackQuote.tsx';

/** The live shape: a union `files` beside a per-codeline map. */
const notes = () => ({
  files: [...SHARED, MX_ONLY],
  perCodeline: {
    gotransit: { files: SHARED },
    upexpress: { files: SHARED },
    metrolinx: { files: [...SHARED, MX_ONLY] },
  },
});

describe('the fixture reproduces the live shape', () => {
  it('the union holds a file belonging to one codeline only', () => {
    expect(notes().files).toContain(MX_ONLY);
    expect(notes().perCodeline.gotransit.files).not.toContain(MX_ONLY);
  });

  it('the renderer produces real output — a blank render would pass every negative below', () => {
    const out = render(notes(), 'gotransit');
    expect(out.trim().length, 'rendered nothing').toBeGreaterThan(0);
    expect(out, 'fell through to the fallback branch, so nothing was really rendered')
      .not.toContain('None specified');
  });
});

describe("THE DEFECT: the prompt states only this lane's files", () => {
  it('gotransit is never told about a metrolinx-only component', () => {
    expect(
      render(notes(), 'gotransit'),
      'the writer is instructed to create a component that does not belong in this repository',
    ).not.toContain(MX_ONLY);
  });

  it('upexpress is not either', () => {
    expect(render(notes(), 'upexpress')).not.toContain(MX_ONLY);
  });

  it('metrolinx IS still told about it', () => {
    // The paired positive: scoping must narrow the prompt, not empty it.
    expect(render(notes(), 'metrolinx')).toContain(MX_ONLY);
  });

  it("the lane's own files all survive", () => {
    const out = render(notes(), 'gotransit');
    for (const f of SHARED) expect(out, `${f} was dropped from the prompt`).toContain(f);
  });

  it('the raw per-codeline map is not dumped alongside, naming every other lane', () => {
    // Rendering perCodeline verbatim re-introduces the other lanes' paths by another route.
    const out = render(notes(), 'gotransit');
    expect(out).not.toContain('upexpress');
    expect(out).not.toContain('metrolinx');
  });
});

describe('shapes without per-codeline data are unchanged', () => {
  it('a flat notes object renders as before', () => {
    const out = render({ files: SHARED, approach: 'use the SDK' }, 'gotransit');
    expect(out).toContain('src/services/contentstack.ts');
    expect(out).toContain('use the SDK');
  });

  it('a lane with no entry keeps the flat list rather than rendering nothing', () => {
    const out = render(notes(), 'brand-new-codeline');
    expect(out).toContain(MX_ONLY);
    for (const f of SHARED) expect(out).toContain(f);
  });

  it('no codeline argument keeps the flat list', () => {
    expect(render(notes(), '')).toContain(MX_ONLY);
  });

  it('empty notes still say so', () => {
    expect(render('', 'gotransit').trim()).toBe('None specified');
  });

  it('keys the per-codeline entry does not mention are preserved', () => {
    // Superseding must be per-key, not a wholesale replacement that silently drops guidance.
    const out = render(
      { files: [MX_ONLY], approach: 'use the SDK', perCodeline: { gotransit: { files: SHARED } } },
      'gotransit',
    );
    expect(out, 'unrelated guidance was discarded by the scoping').toContain('use the SDK');
    expect(out).not.toContain(MX_ONLY);
  });
});

/**
 * The fixture above uses a per-codeline entry of {files}. The REAL one, written by the spec
 * pass, is {files, resolved, unresolved} — and every one of those keys gets merged into the
 * prompt. A fixture simpler than the artefact tests a shape that does not exist.
 */
describe('the real per-codeline shape, not a simplified one', () => {
  const realShape = () => ({
    files: [...SHARED, MX_ONLY],
    perCodeline: {
      gotransit: {
        files: SHARED,
        resolved: SHARED.map((f) => ({ declared: f, actual: f, match: 'exact' })),
        unresolved: [],
      },
      metrolinx: {
        files: [...SHARED, MX_ONLY],
        resolved: [...SHARED, MX_ONLY].map((f) => ({ declared: f, actual: f, match: 'exact' })),
        unresolved: [],
      },
    },
  });

  it('all three keys are scoped to this lane, not just files', () => {
    const out = render(realShape(), 'gotransit');
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).not.toContain('None specified');
    expect(out, "another codeline's path reached the prompt through resolved/unresolved")
      .not.toContain(MX_ONLY);
  });

  it("the lane's own resolved detail still reaches the prompt", () => {
    // Scoping must narrow, not delete: the resolution detail is guidance the writer uses.
    expect(render(realShape(), 'gotransit')).toContain('exact');
  });

  it('an unresolved entry belonging to THIS lane is still shown', () => {
    // Documents current behaviour deliberately. gotransit's live prompt names a component that
    // does not exist in its repo via its own `unresolved` list — spec-pass diagnostics meaning
    // "this declared path did not resolve here". The deliverable gate ignores it, so it is no
    // longer story-fatal, but naming an unresolvable path in a writer prompt invites the writer
    // to create it. Tracked in BACKLOG as the residual item; if that is fixed, this expectation
    // is the one to invert.
    const notes = realShape();
    notes.perCodeline.gotransit.unresolved = [{ declared: MX_ONLY, reason: 'not found in this codeline' }] as never;
    expect(render(notes, 'gotransit')).toContain(MX_ONLY);
  });
});
