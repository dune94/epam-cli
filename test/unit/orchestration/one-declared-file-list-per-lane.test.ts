/**
 * ONE STORY, ONE DECLARED FILE LIST, RESOLVED FOR THE LANE THAT IS RUNNING.
 *
 * spec-mode-runner resolves every declared path against each codeline's real checkout and persists
 * technicalNotes.perCodeline.<codeline>.{files,resolved,unresolved}. That data is correct: on the
 * live PRD, gotransit's list carries `src/context/ContentstackContext.tsx` with the repository's
 * real casing and omits `ContentstackQuote.tsx` entirely, recorded as unresolved because
 * "directory ... does not exist in this codeline".
 *
 * The prompt builder derives the list EIGHT times. Exactly one of those derivations reads the
 * resolved per-lane list; the other seven read the flat `technicalNotes.files`, which is the union
 * across every codeline in the story's declared spelling. So the writer receives:
 *
 *   - `## Files to Create/Modify`  — from the resolved list
 *   - `## Instructions`            — the same files re-rendered from the FLAT list
 *
 * two renderings of one thing, disagreeing. The flat one carries a path that does not exist in the
 * lane, a path whose case is wrong, and that wrong-case path twice. Feeding the wrong-case path
 * through _resolve_deliverable_path is also what emitted the warning that used to be captured into
 * the prompt — so the duplicate source is upstream of the pollution as well.
 *
 * THE FIX IS ARCHITECTURAL, NOT TEXTUAL. A single accessor returns this story's declared files for
 * the lane that is running, and every prompt-side consumer calls it. Nothing about the wording
 * changes; the list simply stops being derived eight ways. Falling back to the flat array keeps
 * older PRDs — written before perCodeline existed — working unchanged.
 *
 * NO STACK FACTS: no filename, extension, codeline or language appears here or in the accessor.
 * The lane arrives as data and the resolution was done upstream against the real checkout.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fnBody(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf(`\n${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in claude.sh`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

/** Run the accessor against a story fixture, with the lane supplied as data. */
function declaredFiles(storyJson: unknown, lane: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'declared-')); dirs.push(dir);
  const p = join(dir, 'story.json');
  writeFileSync(p, JSON.stringify(storyJson));
  const script = `
set -uo pipefail
PROGRESS_LOG=/dev/null
_current_lane() { printf '%s' ${JSON.stringify(lane)}; }
${fnBody('story_declared_files')}
story_declared_files "$(cat ${JSON.stringify(p)})"
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

const STORY = {
  technicalNotes: {
    // The union, in the DECLARED spelling — wrong case for this lane, and one foreign path.
    files: ['src/a.x', 'src/context/lowerName.x', 'src/foreign/Only.x', 'src/context/lowerName.x'],
    perCodeline: {
      alpha: { files: ['src/a.x', 'src/context/UpperName.x'], resolved: [], unresolved: [] },
      beta: { files: ['src/a.x', 'src/foreign/Only.x'], resolved: [], unresolved: [] },
    },
  },
};

describe('the accessor exists and is executable', () => {
  it('story_declared_files is defined', () => {
    expect(() => fnBody('story_declared_files')).not.toThrow();
  });
});

describe('the running lane gets ITS OWN resolved list', () => {
  it('returns the lane-resolved paths, with the repository casing', () => {
    expect(declaredFiles(STORY, 'alpha')).toEqual(['src/a.x', 'src/context/UpperName.x']);
  });

  it('a path that does not exist in this lane is absent', () => {
    expect(
      declaredFiles(STORY, 'alpha'),
      'a foreign codeline\'s file was handed to this lane — the writer is told to modify a path ' +
      'its checkout does not contain',
    ).not.toContain('src/foreign/Only.x');
  });

  it('a different lane gets a different list', () => {
    expect(declaredFiles(STORY, 'beta')).toEqual(['src/a.x', 'src/foreign/Only.x']);
  });

  it('the duplicate declaration does not survive', () => {
    const out = declaredFiles(STORY, 'alpha');
    expect(new Set(out).size, 'a duplicated entry renders twice in the prompt').toBe(out.length);
  });
});

describe('older PRDs keep working — absent perCodeline falls back', () => {
  it('a story with no perCodeline returns the flat list', () => {
    const legacy = { technicalNotes: { files: ['src/a.x', 'src/b.x'] } };
    expect(declaredFiles(legacy, 'alpha')).toEqual(['src/a.x', 'src/b.x']);
  });

  it('a lane with no entry falls back rather than returning nothing', () => {
    // Returning empty would hand the writer no files at all — worse than an imperfect list.
    expect(declaredFiles(STORY, 'gamma').length).toBeGreaterThan(0);
  });

  it('an unknown lane still de-duplicates the flat list', () => {
    const out = declaredFiles(STORY, 'gamma');
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('THE SWEEP: prompt-side consumers all route through the accessor', () => {
  it('the prompt builder derives the list once, not eight times', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('\nbuild_implementation_prompt() {');
    const end = src.indexOf('\n}\n', src.indexOf('\n_module_resolution_context', start) === -1 ? start : start);
    const body = src.slice(start, start + 40000);
    const builderEnd = body.indexOf('\n}\n');
    const builder = body.slice(0, builderEnd);

    // Scoped to reads of THIS story's list. A PRD-wide query for OTHER stories' declared files
    // (the dependency spec-reality check) is a different question and correctly stays as it is —
    // the accessor answers "this story, this lane", not "every story".
    const rawReads = builder.split('\n').filter((l) => {
      const t = l.trim();
      if (t.startsWith('#')) return false;
      if (!/\.technicalNotes\.files/.test(l)) return false;
      return /story_json/.test(l);
    });
    expect(
      rawReads.map((l) => l.trim().slice(0, 90)),
      'these read the flat union directly inside the prompt builder; the lane-resolved list ' +
      'exists and disagrees with it',
    ).toEqual([]);
  });
});
