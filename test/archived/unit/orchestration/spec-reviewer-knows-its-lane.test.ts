/**
 * THE SPEC REVIEWER DID NOT KNOW IT WAS REVIEWING ONE LANE OF A SPANNING STORY.
 *
 * The spec pass runs per codeline, against that codeline's own checkout, and produces the
 * file manifest, fix sites and verification criteria observable THERE. The reviewer's prompt
 * said nothing about this. So on AMSD-2041 it saw `codelines: [gotransit, upexpress,
 * metrolinx]` on the story and criteria naming only metrolinx surfaces, and reported
 * `missing_cross_codeline_paths` — scoring 0.65 with the note that "an implementer sent to GO
 * or UP cannot function".
 *
 * The reviewer was reasoning correctly from what it was shown. It was shown one lane's work
 * and told it was the whole story. 0.7 is the halt threshold, so this stopped real runs.
 *
 * The block below tells it which lane produced the artefact and that the others are specced
 * by their own lanes — WITHOUT telling it to ignore cross-codeline problems, which are real
 * whenever this lane's own change depends on another.
 *
 * Every codeline name is read from the PRD's own project.outputDirs. Nothing here names a
 * client, a brand or a repository.
 */
import { describe, it, expect, afterAll } from 'vitest';

const { codelineScopeBlock } = require('../../../orchestrations/scripts/spec-mode-runner.js');

const LANES = ['gotransit', 'upexpress', 'metrolinx'];

function lanePrd(codeline: string, lanes = LANES) {
  return {
    project: {
      outputDir: `/estate/${codeline}`,
      outputDirs: lanes.map((cl) => ({ codeline: cl, path: `/estate/${cl}` })),
    },
  };
}

const spanning = [{ id: 'SPAN-1', codelines: [...LANES] }];
const solo = [{ id: 'SOLO-1', codelines: ['gotransit'] }];

describe('the block appears exactly when it is true', () => {
  it('a spanning story on a derivable lane gets the block', () => {
    expect(codelineScopeBlock(lanePrd('metrolinx'), spanning).trim()).not.toBe('');
  });

  it('a single-codeline story gets NOTHING — no noise in a prompt that does not need it', () => {
    expect(codelineScopeBlock(lanePrd('gotransit'), solo)).toBe('');
  });

  it('no derivable lane gets nothing rather than a guess', () => {
    expect(codelineScopeBlock({ project: {} }, spanning)).toBe('');
    expect(codelineScopeBlock(null, spanning)).toBe('');
  });

  it('no stories gets nothing', () => {
    expect(codelineScopeBlock(lanePrd('metrolinx'), [])).toBe('');
    expect(codelineScopeBlock(lanePrd('metrolinx'), null)).toBe('');
  });

  it('one spanning story among several is enough', () => {
    const mixed = [...solo, ...spanning];
    expect(codelineScopeBlock(lanePrd('metrolinx'), mixed).trim()).not.toBe('');
  });
});

describe('the block says which lane produced the artefact', () => {
  const block = () => codelineScopeBlock(lanePrd('metrolinx'), spanning);

  it('names this lane', () => {
    expect(block()).toContain('metrolinx');
  });

  it('names the lanes it is NOT reviewing, so "missing" paths are attributable', () => {
    expect(block()).toContain('gotransit');
    expect(block()).toContain('upexpress');
  });

  it('states that the other lanes are specced by their own passes', () => {
    expect(block().toLowerCase()).toMatch(/own lane|its own|separately|per codeline|own pass/);
  });
});

describe('it corrects the misjudgement without disabling the judgement', () => {
  const block = () => codelineScopeBlock(lanePrd('metrolinx'), spanning);

  it('says not to penalise the spec for paths absent from the OTHER codelines', () => {
    // The literal 0.65 finding: metrolinx paths judged against GO and UP.
    expect(block().toLowerCase()).toMatch(/not.*(penalis|penaliz|lower|reduce|deduct)/);
  });

  it('still leaves a genuine cross-codeline dependency in scope', () => {
    expect(
      block().toLowerCase(),
      'the block silenced cross-codeline concerns entirely instead of scoping them',
    ).toMatch(/depend|relies|requires|consumes|contract/);
  });

  it('does not instruct the reviewer to raise or floor the score', () => {
    // Correcting what it is shown is legitimate; steering the number is not.
    expect(block().toLowerCase()).not.toMatch(/score (at least|above|higher)|give it a|award/);
  });
});

/**
 * GUARD AGAINST A VACUOUS PASS.
 *
 * Everything above feeds codelineScopeBlock a PRD shaped by hand. If the REAL per-lane PRD
 * differed — if the filter dropped `codelines` down to the single lane, or never set
 * project.outputDir — the block would return '' on every real run and every test above would
 * still be green while the reviewer learned nothing.
 *
 * So: run the orchestrator's actual _filtered_prd against a spanning PRD and feed what it
 * writes to the actual block.
 */
describe('the real per-lane PRD produces a real block', () => {
  const { execFileSync } = require('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');

  const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
  const src: string = readFileSync(ORCH, 'utf8');

  /** The real _filtered_prd, lifted out of the orchestrator. */
  function filteredPrdBody(): string {
    const start = src.indexOf('  _filtered_prd() {');
    expect(start, '_filtered_prd is gone from the orchestrator').toBeGreaterThan(-1);
    const end = src.indexOf('\n  }', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end + 4).replace(/^  /gm, '');
  }

  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function realLanePrd(codeline: string) {
    const dir = mkdtempSync(join(tmpdir(), 'lane-prd-')); dirs.push(dir);
    const srcPrd = join(dir, 'canonical.json');
    const outPrd = join(dir, 'lane.json');
    writeFileSync(srcPrd, JSON.stringify({
      project: {
        outputDir: '/estate/gotransit',
        outputDirs: LANES.map((cl) => ({ codeline: cl, path: `/estate/${cl}` })),
      },
      stories: [{ id: 'SPAN-1', title: 'spanning', codelines: [...LANES] }],
    }, null, 2));

    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      `#!/usr/bin/env bash\nset -eu\nNODE_BIN=${JSON.stringify(process.execPath)}\n` +
      `${filteredPrdBody()}\n_filtered_prd ${JSON.stringify(codeline)} ${JSON.stringify(outPrd)} ${JSON.stringify(srcPrd)}\n`);
    execFileSync('bash', [sh], { encoding: 'utf8' });
    return JSON.parse(readFileSync(outPrd, 'utf8'));
  }

  it('the filter really does keep the story and set this lane', () => {
    const prd = realLanePrd('metrolinx');
    expect(prd.stories.length, 'the spanning story was dropped from its own lane').toBe(1);
    expect(prd.stories[0].codelines, 'codelines was narrowed, so nothing can tell the story spans')
      .toEqual(LANES);
    expect(prd.project.outputDir).toBe('/estate/metrolinx');
  });

  it('and the block renders from it, naming this lane and the others', () => {
    const prd = realLanePrd('metrolinx');
    const block = codelineScopeBlock(prd, prd.stories);
    expect(block.trim(), 'the block is empty on a REAL lane PRD — the reviewer learns nothing').not.toBe('');
    expect(block).toContain('metrolinx');
    expect(block).toContain('gotransit');
  });

  it('each lane describes itself, not a fixed one', () => {
    for (const cl of LANES) {
      const prd = realLanePrd(cl);
      expect(codelineScopeBlock(prd, prd.stories)).toContain(`against '${cl}' only`);
    }
  });
});

describe('nothing about the estate is hardcoded', () => {
  it('a completely different estate is described in its own terms', () => {
    const other = ['alpha', 'beta'];
    const block = codelineScopeBlock(lanePrd('alpha', other), [{ id: 'S', codelines: other }]);
    expect(block).toContain('alpha');
    expect(block).toContain('beta');
    for (const name of LANES) expect(block).not.toContain(name);
  });

  it('the engine source carries no codeline name of its own', () => {
    const block = codelineScopeBlock(lanePrd('alpha', ['alpha', 'beta']), [{ id: 'S', codelines: ['alpha', 'beta'] }]);
    // Anything not derived from the PRD would survive into a foreign estate's block.
    expect(block).not.toMatch(/gotransit|upexpress|metrolinx|contentstack/i);
  });
});
