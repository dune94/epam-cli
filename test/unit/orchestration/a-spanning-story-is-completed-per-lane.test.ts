/**
 * A STORY THAT SPANS CODELINES IS COMPLETED PER LANE — ANOTHER LANE'S COMPLETION IS NOT THIS ONE'S.
 *
 * Multi-lane £0 run 13, 2026-10-02: the shared library's lane completed EST-1; the next lane
 * (a site consuming it) found EST-1 "already completed, skipping" and did nothing. The lanes export
 * the earlier lanes' PRDs as CROSS_CODELINE_PRD so a story can depend on ANOTHER codeline's story,
 * and is_story_completed consulted it for every story — including the one this lane is running.
 * A story this lane's PRD carries is completed when THIS lane completed it; the cross PRD answers
 * only for a story this lane does not carry (a dependency on another codeline).
 *
 * EXECUTED: the real is_story_completed (lib/prd-state.sh) against real PRD files.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/prd-state.sh');
const work = mkdtempSync(join(tmpdir(), 'span-complete-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const lane = join(work, 'site-prd.json');
writeFileSync(lane, JSON.stringify({ stories: [{ id: 'T-1', codeline: 'site', completed: false }] }));
const cross = join(work, 'cross.json');
writeFileSync(cross, JSON.stringify({ stories: [{ id: 'T-1', codeline: 'lib', completed: true }, { id: 'LIB-9', codeline: 'lib', completed: true }] }));

const completed = (id: string) => spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; is_story_completed ${id} && echo YES || echo NO`],
  { encoding: 'utf8', env: { ...process.env, PRD_FILE: lane, CROSS_CODELINE_PRD: cross } }).stdout.trim();

describe('a spanning story is completed per lane', () => {
  it('the lane\'s own story is not completed by another lane\'s completion', () => {
    expect(completed('T-1')).toBe('NO');
  });
  it('a dependency on another codeline\'s story still reads that codeline\'s completion', () => {
    expect(completed('LIB-9')).toBe('YES');
  });
  it('an unknown story is not completed', () => {
    expect(completed('NOPE-1')).toBe('NO');
  });
});
