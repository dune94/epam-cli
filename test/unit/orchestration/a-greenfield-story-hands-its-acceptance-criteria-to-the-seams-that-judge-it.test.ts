/**
 * A GREENFIELD STORY HANDS ITS ACCEPTANCE CRITERIA TO THE SEAMS THAT JUDGE IT.
 *
 * ea920ee7 (2026-09-01) removed __STORY_ACS__ from four templates — failure-analyst,
 * team-lead-review, code-review-cycle, code-graph-detective — because a brownfield ticket has no
 * acceptance criteria (it judges on verification criteria) and the empty-placeholder guard
 * refused every render. Right about brownfield; it threw away greenfield, where the PRD is
 * authored WITH acceptance criteria and they are in scope (operator, 2026-09-11). Since then the
 * diagnostician diagnosed, the detective located and both reviewers judged a greenfield story
 * without ever seeing what it was supposed to satisfy — and the analyst's ac_patches had nothing
 * to point at.
 *
 * Both rulings hold when the heading travels WITH the criteria: the block is "heading + AC1..ACn"
 * when the story declares them, and nothing when it does not, so brownfield renders no heading
 * (the 2026-09-01 objection) and greenfield renders its criteria. The shape has one home in shell
 * (lib/story-acs-block.sh) and one in JS (spec-mode-runner.js storyAcsBlock); the templates
 * declare __STORY_ACS__ mayBeEmpty.
 *
 * Every case EXECUTES: the shell helper against real PRD files, the JS helper against a story, and
 * the REAL renderer over the four provisioned templates in both states.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionProject, cleanupProvisioned } from '../../support/provisioned-project';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/story-acs-block.sh');
const TPL_DIR = join(ROOT, 'orchestrations/prompts/templates');

/** The templates that carry __STORY_ACS__ — discovered, not listed. */
const AC_TEMPLATES = readdirSync(TPL_DIR).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((id) => (JSON.parse(readFileSync(join(TPL_DIR, `${id}.json`), 'utf8')).placeholders || []).includes('__STORY_ACS__'));

const dirs: string[] = [];
let PROJECT = '';
beforeAll(() => { PROJECT = provisionProject(); });
afterAll(() => { cleanupProvisioned(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function prd(stories: any[]) {
  const d = mkdtempSync(join(tmpdir(), 'acs-')); dirs.push(d);
  const f = join(d, 'prd.json'); writeFileSync(f, JSON.stringify({ stories }));
  return f;
}
function block(prdFile: string, id: string, heading?: string) {
  const args = heading ? `"${heading}"` : '';
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; story_acs_block ${JSON.stringify(prdFile)} ${JSON.stringify(id)} ${args}`], { encoding: 'utf8' });
  return r.stdout;
}

describe('the shell block: heading and criteria together, or nothing', () => {
  it('a greenfield story with criteria gets the heading and every criterion numbered', () => {
    const f = prd([{ id: 'GF-1', acceptanceCriteria: ['Behaviour A holds', 'Behaviour B holds'] }]);
    expect(block(f, 'GF-1')).toBe('ACCEPTANCE CRITERIA:\nAC1: Behaviour A holds\nAC2: Behaviour B holds\n\n');
  });
  it('a brownfield story with none gets NOTHING — no empty heading', () => {
    const f = prd([{ id: 'BF-1', description: 'a defect' }, { id: 'BF-2', acceptanceCriteria: [] }, { id: 'BF-3', acceptanceCriteria: ['', null] }]);
    for (const id of ['BF-1', 'BF-2', 'BF-3']) expect(block(f, id), `${id} rendered a heading over nothing`).toBe('');
  });
  it('the caller may name the heading — the analyst calls them test criteria', () => {
    const f = prd([{ id: 'GF-1', acceptanceCriteria: ['x'] }]);
    expect(block(f, 'GF-1', 'CURRENT TEST CRITERIA (acceptance criteria):')).toMatch(/^CURRENT TEST CRITERIA \(acceptance criteria\):\nAC1: x\n\n$/);
  });
  it('a missing PRD or story is nothing, never an error', () => {
    expect(block('/nonexistent/prd.json', 'X-1')).toBe('');
    expect(block(prd([{ id: 'A' }]), 'B')).toBe('');
  });
});

describe('the JS block the detective uses is the same shape', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { storyAcsBlock } = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
  it('numbers the criteria under the heading', () => {
    expect(storyAcsBlock({ acceptanceCriteria: ['a', 'b'] })).toBe('Acceptance criteria:\nAC1: a\nAC2: b\n\n');
  });
  it('is empty for a brownfield story', () => {
    expect(storyAcsBlock({ description: 'd' })).toBe('');
    expect(storyAcsBlock({ acceptanceCriteria: [] })).toBe('');
  });
});

describe('the four seams render in both states through the real renderer', () => {
  it('the templates that take the block are the four the ruling named — found, not listed', () => {
    expect(AC_TEMPLATES.sort()).toEqual(['code-graph-detective', 'code-review-cycle', 'failure-analyst', 'team-lead-review']);
  });

  it.each(AC_TEMPLATES)('%s declares __STORY_ACS__ mayBeEmpty and carries no fixed criteria heading of its own', (id) => {
    const doc = JSON.parse(readFileSync(join(TPL_DIR, `${id}.json`), 'utf8'));
    expect(doc.mayBeEmpty, `${id}: absent criteria (brownfield) must be a legal state`).toContain('__STORY_ACS__');
    expect(doc.body, `${id}: a heading in the body renders over nothing on brownfield`).not.toMatch(/acceptance criteria:|CURRENT TEST CRITERIA/i);
  });

  function renderWith(id: string, acs: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));
    const doc = JSON.parse(readFileSync(join(TPL_DIR, `${id}.json`), 'utf8'));
    const values: Record<string, string> = {};
    for (const p of doc.placeholders || []) values[p] = p === '__STORY_ACS__' ? acs : `value-for-${p}`;
    return lib.buildPrompt(id, PROJECT, values);
  }

  it.each(AC_TEMPLATES)('%s: a greenfield block lands in the prompt, numbered', (id) => {
    const out = renderWith(id, 'ACCEPTANCE CRITERIA:\nAC1: Behaviour A holds\nAC2: Behaviour B holds\n\n');
    expect(out).toContain('AC1: Behaviour A holds');
    expect(out).toContain('AC2: Behaviour B holds');
  });

  it.each(AC_TEMPLATES)('%s: a brownfield story renders — and with no criteria heading anywhere', (id) => {
    const out = renderWith(id, '');
    expect(out.length, 'the render refused or produced nothing').toBeGreaterThan(200);
    expect(out).not.toMatch(/acceptance criteria:|CURRENT TEST CRITERIA/i);
    expect(out).not.toContain('__STORY_ACS__');
  });
});
