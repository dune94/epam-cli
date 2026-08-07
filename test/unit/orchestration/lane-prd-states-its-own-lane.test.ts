/**
 * A LANE'S PRD MUST DESCRIBE THAT LANE.
 *
 * _filtered_prd selects the stories belonging to a codeline and copied them through unchanged,
 * so a story spanning three codelines carried its PRIMARY codeline into all three lane PRDs.
 * Every consumer reading the singular field got the same answer in every lane.
 *
 * Live 2026-08-07, three-lane run: the detective resolved its investigator from
 * story.codeline, so all three lanes used the FIRST lane's investigator — two repositories
 * were investigated with a brief written for a different one. The log shows
 * "detective for gotransit = gotransit-investigator" four times and the other two never.
 *
 * The same shape produced two more defects: agentRole singular while a spanning story runs in
 * N lanes, and project.outputDir vs outputDirs. A singular field that is right for exactly one
 * lane in three is a trap.
 *
 * Fixed at the data seam rather than in each reader: once a lane's PRD tells the truth about
 * which lane it is, every consumer is correct without knowing lanes exist. These tests execute
 * the REAL filter and assert on the PRDs it writes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run the REAL _filtered_prd for one codeline and return the PRD it wrote. */
function filtered(codeline: string, prd: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'lanePrd-')); dirs.push(dir);
  const src = join(dir, 'src.json');
  const out = join(dir, `${codeline}-prd.json`);
  writeFileSync(src, JSON.stringify(prd));

  const start = SRC.indexOf('  _filtered_prd() {');
  const end = SRC.indexOf('\n  }', start);
  expect(start, '_filtered_prd is gone from the orchestrator').toBeGreaterThan(-1);
  const fn = SRC.slice(start, end + 4);

  const script = `set +e\nNODE_BIN=${JSON.stringify(NODE)}\n${fn}\n_filtered_prd ${JSON.stringify(codeline)} ${JSON.stringify(out)} ${JSON.stringify(src)}\n`;
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  let parsed: any = null;
  try { parsed = JSON.parse(readFileSync(out, 'utf8')); } catch { /* leave null */ }
  return { parsed, res };
}

const SPANNING = {
  project: {
    outputDir: '/repos/alpha',
    outputDirs: [
      { codeline: 'alpha', path: '/repos/alpha' },
      { codeline: 'beta', path: '/repos/beta' },
      { codeline: 'gamma', path: '/repos/gamma' },
    ],
  },
  implementationOrder: { core: ['S-1'] },
  stories: [{
    id: 'S-1', title: 'spans three', codeline: 'alpha',
    codelines: ['alpha', 'beta', 'gamma'],
  }],
};

describe('the fixture is real', () => {
  it('the filter runs and writes a PRD containing the spanning story', () => {
    const { parsed, res } = filtered('beta', SPANNING);
    expect(parsed, `filter produced nothing: ${res.stderr}`).toBeTruthy();
    expect(parsed.stories).toHaveLength(1);
    expect(parsed.stories[0].id).toBe('S-1');
  });
});

describe('each lane PRD claims its OWN codeline', () => {
  it.each(['alpha', 'beta', 'gamma'])('the %s lane PRD says codeline=%s', (cl) => {
    const { parsed } = filtered(cl, SPANNING);
    expect(
      parsed.stories[0].codeline,
      `this lane's PRD says it is a different lane — every consumer reading the singular field is wrong here`,
    ).toBe(cl);
  });

  it('THE LIVE DEFECT: a non-primary lane no longer inherits the primary codeline', () => {
    const { parsed } = filtered('gamma', SPANNING);
    expect(
      parsed.stories[0].codeline,
      'the third lane still claims the first lane — this is how two repositories were ' +
      'investigated with another one\'s brief',
    ).not.toBe('alpha');
  });
});

describe('nothing else about the story is lost', () => {
  it('codelines[] survives, so the story still knows it spans three', () => {
    const { parsed } = filtered('beta', SPANNING);
    expect(parsed.stories[0].codelines).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('the lane PRD points project.outputDir at THIS lane', () => {
    const { parsed } = filtered('gamma', SPANNING);
    expect(parsed.project.outputDir).toBe('/repos/gamma');
  });

  it('other story fields are untouched', () => {
    const { parsed } = filtered('beta', SPANNING);
    expect(parsed.stories[0].title).toBe('spans three');
  });
});

describe('a single-codeline story is unaffected', () => {
  it('it keeps its own codeline and still lands in its lane', () => {
    const single = {
      implementationOrder: { core: ['S-9'] },
      stories: [{ id: 'S-9', codeline: 'beta', title: 'one lane only' }],
    };
    const { parsed } = filtered('beta', single);
    expect(parsed.stories).toHaveLength(1);
    expect(parsed.stories[0].codeline).toBe('beta');
  });

  it('a story belonging elsewhere does not appear in this lane', () => {
    const single = {
      implementationOrder: { core: ['S-9'] },
      stories: [{ id: 'S-9', codeline: 'beta', title: 'one lane only' }],
    };
    const { parsed } = filtered('gamma', single);
    expect(parsed.stories).toHaveLength(0);
  });
});
