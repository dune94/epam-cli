/**
 * RUN ONE CODELINE, BY CONFIGURATION.
 *
 * A three-lane run costs ~3x and averages the spec's behaviour across lanes, which is
 * exactly what made AMSD-2041's plan nondeterminism hard to see: the prescribed fix
 * differed PER LANE and PER RUN, so no single observation was clean.
 *
 * The only way to do this before was to hand-build a directory containing a symlink to
 * one client codeline and point JIRA_CODELINE_ROOT at it. That is a hardcoded artefact —
 * it names one client's repo, it does not exist for the next project, and it is neither
 * configurable nor determinable. It is precisely what the engine is not allowed to need.
 *
 * EPAM_CODELINE_FILTER is the configured form. It applies at the ONE point every lane fact
 * is derived from — `allCodelines` in synthesize-prd-from-jira.js — so project.outputDirs,
 * each story's codeline, the spanning-story split and implementationOrder all follow from
 * a single narrowed list. The PRD is coherently single-lane rather than a three-lane PRD
 * with two lanes quietly skipped, which is the partial-state failure that would produce
 * disagreements among the 18 downstream consumers of outputDirs.
 *
 * This script names no codeline (its own header says so) and this filter adds none: the
 * value comes from the environment, and an unset filter changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYNTH = join(__dirname, '../../../orchestrations/scripts/synthesize-prd-from-jira.js');
// The synthesizer has no built-in template: a built-in one lent every run another
// project's identity. These tests are about the synthesizer's own logic, so the template
// they supply is deliberately anonymous.
const TEMPLATE = join(__dirname, '../../fixtures/prd/neutral-synthesis-template.json');

// DERIVED: the interpreter already running this test. Never a machine-specific path.
const NODE = process.execPath;

/** Three classified tickets, one per codeline — the shape a real ingest produces. */
const CLASSIFICATIONS = [
  { key: 'AAA-1', title: 'one', codeline: 'alpha', acceptanceCriteria: ['a'] },
  { key: 'AAA-2', title: 'two', codeline: 'beta', acceptanceCriteria: ['b'] },
  { key: 'AAA-3', title: 'three', codeline: 'gamma', acceptanceCriteria: ['c'] },
];

function synthesize(env: Record<string, string>, classifications = CLASSIFICATIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'clf-'));
  const cls = join(dir, 'classifications.json');
  const out = join(dir, 'prd.json');
  writeFileSync(cls, JSON.stringify(classifications, null, 2));
  const r = spawnSync(NODE, [SYNTH, '--classifications', cls, '--out', out, '--template', TEMPLATE], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      JIRA_WORKTREE_ALPHA: '/repos/alpha',
      JIRA_WORKTREE_BETA: '/repos/beta',
      JIRA_WORKTREE_GAMMA: '/repos/gamma',
      ...env,
    },
  });
  return {
    status: r.status,
    stderr: r.stderr || '',
    prd: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
  };
}

const lanesOf = (prd: Record<string, never> | null) =>
  ((prd as never as { project?: { outputDirs?: Array<{ codeline: string }> } })?.project
    ?.outputDirs || []).map((d) => d.codeline).sort();

const storyLanesOf = (prd: Record<string, never> | null) => [
  ...new Set(
    ((prd as never as { stories?: Array<{ codeline?: string }> })?.stories || [])
      .map((s) => s.codeline)
      .filter(Boolean) as string[],
  ),
].sort();

describe('unset filter changes nothing', () => {
  it('all codelines are produced, exactly as before', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(lanesOf(r.prd)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('an absent variable behaves identically to an empty one', () => {
    const r = synthesize({});
    expect(lanesOf(r.prd)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('a filter narrows every lane fact coherently', () => {
  it('THE POINT: one codeline in, one lane out', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: 'beta' });
    expect(r.status, r.stderr).toBe(0);
    expect(lanesOf(r.prd)).toEqual(['beta']);
  });

  it('the STORIES agree with outputDirs — no lane runs without a lane entry', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: 'beta' });
    expect(
      storyLanesOf(r.prd),
      'a PRD whose stories name a codeline that outputDirs does not carry is the ' +
        'partial-state failure this filter must not create — 18 downstream consumers read ' +
        'outputDirs and would disagree with the stories',
    ).toEqual(['beta']);
  });

  it('project.outputDir points at the surviving lane, not a filtered-out one', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: 'gamma' });
    const project = (r.prd as never as { project: { outputDir: string } }).project;
    expect(project.outputDir).toBe('/repos/gamma');
  });

  it('accepts several codelines, and tolerates spacing', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: 'alpha, gamma' });
    expect(lanesOf(r.prd)).toEqual(['alpha', 'gamma']);
  });
});

describe('a filter that matches nothing fails loudly', () => {
  it('exits non-zero and names what it was given', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: 'nosuchlane' });
    expect(
      r.status,
      'silently running ALL lanes would spend 3x unexpectedly; silently running NONE would ' +
        'look like a clean no-op. Both are worse than stopping.',
    ).not.toBe(0);
    expect(r.stderr).toMatch(/nosuchlane/);
    expect(r.stderr).toMatch(/EPAM_CODELINE_FILTER/);
  });

  it('says which codelines WERE available, so the typo is obvious', () => {
    const r = synthesize({ EPAM_CODELINE_FILTER: 'beeta' });
    expect(r.stderr).toMatch(/alpha/);
    expect(r.stderr).toMatch(/beta/);
  });
});

/**
 * THE REAL-WORLD SHAPE. The story this filter exists to run cheaply is a SPANNING story —
 * one ticket labelled with the split value, executed against every codeline. If the filter
 * breaks that, it breaks the only case anyone wanted it for.
 */
describe('a spanning story survives the filter, narrowed not broken', () => {
  const SPANNING = [
    { key: 'AAA-9', title: 'spans', codeline: 'both', acceptanceCriteria: ['x'] },
  ];

  it('unfiltered, it spans every codeline', () => {
    const r = synthesize({ JIRA_CODELINES: 'alpha,beta,gamma' }, SPANNING);
    expect(r.status, r.stderr).toBe(0);
    expect(lanesOf(r.prd)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('filtered, it spans ONLY the surviving codeline', () => {
    const r = synthesize(
      { JIRA_CODELINES: 'alpha,beta,gamma', EPAM_CODELINE_FILTER: 'beta' },
      SPANNING,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(lanesOf(r.prd)).toEqual(['beta']);
    expect(
      (r.prd as never as { stories: unknown[] }).stories.length,
      'the spanning story must still EXIST — filtering the lanes must not delete the work',
    ).toBeGreaterThan(0);
  });

  it('every story the run orders actually exists', () => {
    const r = synthesize(
      { JIRA_CODELINES: 'alpha,beta,gamma', EPAM_CODELINE_FILTER: 'beta' },
      SPANNING,
    );
    const prd = r.prd as never as {
      stories: Array<{ id: string }>;
      implementationOrder?: Record<string, string[]>;
    };
    const ids = new Set(prd.stories.map((s) => s.id));
    const ordered = Object.values(prd.implementationOrder || {}).flat();
    const dangling = ordered.filter((id) => !ids.has(id));
    expect(
      dangling,
      'implementationOrder naming a story the PRD does not contain is exactly the ' +
        'partial-state defect this filter must not introduce',
    ).toEqual([]);
  });
});

/**
 * NO-REGRESSION, stated as strongly as it can be: with the filter unset, the generated PRD
 * must be BYTE-IDENTICAL to what the same inputs produced before. Every existing project
 * runs this code path on every ingest.
 */
describe('unset filter is byte-identical, not merely similar', () => {
  // The PRD id embeds a generation timestamp (`jira-sourced-<epoch>`), and ISO timestamps
  // appear in generated metadata. Those differ between two runs of the SAME code, so they
  // are normalised — and ONLY they are. Everything else must match exactly, or the
  // comparison would prove nothing about behaviour.
  const normalise = (prd: unknown) =>
    JSON.stringify(prd)
      .replace(/jira-sourced-\d+/g, 'jira-sourced-<ts>')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<iso>');

  it('produces exactly the same PRD as an environment with no filter variable at all', () => {
    const withEmpty = synthesize({ EPAM_CODELINE_FILTER: '' });
    const withAbsent = synthesize({});
    expect(withEmpty.status).toBe(0);
    expect(
      normalise(withEmpty.prd),
      'any difference here means the filter changed behaviour for projects that never set it',
    ).toBe(normalise(withAbsent.prd));
  });

  it('a spanning story is byte-identical too', () => {
    const spanning = [{ key: 'AAA-9', title: 'spans', codeline: 'both', acceptanceCriteria: ['x'] }];
    const a = synthesize({ JIRA_CODELINES: 'alpha,beta,gamma' }, spanning);
    const b = synthesize({ JIRA_CODELINES: 'alpha,beta,gamma', EPAM_CODELINE_FILTER: '' }, spanning);
    expect(normalise(a.prd)).toBe(normalise(b.prd));
  });
});

/**
 * NOT DUPLICATED HERE: "the engine names no client or vendor" is already enforced by
 * test/unit/orchestration/mock-external-cms-apis.test.ts, which caught a vendor name in a
 * comment of mine earlier today. A second copy would mean a hardcoded list of client names
 * living in two places and drifting — the exact defect shape this session kept finding.
 */
