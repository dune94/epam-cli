/**
 * A LINT FINDING MAPS TO THE STORY THAT WROTE IT.
 *
 * AMSD-2974 run 9 (2026-10-10), cxshared Writer: the lint gate failed on the story's own repro spec
 * (jest/expect-expect). Its remediation asks the gate-finding-analyst which story the finding belongs to, choosing
 * from the "active stories" — which listed only stories NOT completed. The writer had just marked AMSD-2974 completed,
 * so the list was empty; the analyst answered story_id null; the parser printed Python's `None`, which then passed as a
 * story id; its ACs were empty; the lint-ac-remediator prompt refused to render and the lane exited 1. Even without the
 * crash it would end "could not map lint failure to a story" — exit 1, lane failed, every time.
 *
 * EXECUTED: the two real lines lifted from run-agent-orchestration.sh, against a PRD whose story was just completed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
/** The single line of the script that begins with `marker` (after indentation). */
function line(marker: string): string {
  const l = SRC.split('\n').find((x) => x.trimStart().startsWith(marker));
  if (!l) throw new Error(`line starting ${marker} not found — the harness is stale`);
  return l;
}
/** The line that writes the analyst's story list — found by what it writes, so the test survives either version. */
const STORIES_LINE = (() => {
  const l = SRC.split('\n').find((x) => x.trimStart().startsWith('python3 -c') && x.includes('> "$_lf_stories_file"'));
  if (!l) throw new Error('the lint analyst\'s story-list line was not found — the harness is stale');
  return l;
})();
const PARSE_LINE = line('_lint_story_id="$(echo "$_lint_finding_raw" | python3 -c "');

function activeStories(prd: object, phase: string): any[] {
  const d = mkdtempSync(join(tmpdir(), 'lint-map-'));
  const f = join(d, 'prd.json'); writeFileSync(f, JSON.stringify(prd));
  const out = join(d, 'stories.json');
  const r = spawnSync('bash', ['-c', `PRD_FILE=${JSON.stringify(f)}; MAIN_PRD_FILE=""; PHASE=${JSON.stringify(phase)}; _lf_stories_file=${JSON.stringify(out)}\n${STORIES_LINE}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(readFileSync(out, 'utf8'));
}

function parsedStoryId(raw: string): string {
  // The assignment spans to the closing `")"`; lift it whole.
  const start = SRC.indexOf(PARSE_LINE);
  const end = SRC.indexOf('2>/dev/null || echo "")"', start) + '2>/dev/null || echo "")"'.length;
  const r = spawnSync('bash', ['-c', `_lint_finding_raw=${JSON.stringify(raw)}\n${SRC.slice(start, end)}\nprintf '%s' "$_lint_story_id"`], { encoding: 'utf8' });
  return r.stdout;
}

describe('the lint analyst is offered the story the phase just wrote', () => {
  it('a story completed in this phase is still offered — it wrote the file that failed lint', () => {
    const ids = activeStories({ implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', title: 't', agentRole: 'a', completed: true }] }, 'core')
      .map((s) => s.id);
    expect(ids, 'the just-written story was hidden from the analyst, so no finding can ever map to it').toEqual(['S-1']);
  });

  it('a completed story of ANOTHER phase is not offered', () => {
    const ids = activeStories({ implementationOrder: { core: ['S-1'], earlier: ['S-0'] },
      stories: [{ id: 'S-0', completed: true }, { id: 'S-1', completed: true }] }, 'core').map((s) => s.id);
    expect(ids).toEqual(['S-1']);
  });

  it('stories not yet completed are offered as before', () => {
    const ids = activeStories({ implementationOrder: { core: [] }, stories: [{ id: 'S-2', completed: false }] }, 'core').map((s) => s.id);
    expect(ids).toEqual(['S-2']);
  });
});

describe('an analyst that names no story yields no story id', () => {
  it('story_id null is empty — never the text "None"', () => {
    expect(parsedStoryId('{"story_id": null, "file": "x"}')).toBe('');
  });
  it('a named story is returned as named', () => {
    expect(parsedStoryId('analysis… {"story_id": "S-1", "file": "x"}')).toBe('S-1');
  });
});
