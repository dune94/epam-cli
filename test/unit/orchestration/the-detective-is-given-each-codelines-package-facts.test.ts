/**
 * THE DETECTIVE IS GIVEN EACH CODELINE'S PACKAGE FACTS — IT NEVER HAS TO ASSUME A VERSION.
 *
 * Live 2026-10-02, AMSD-2974 (a shared library at 8.10.0; sites declaring ^7.x), run
 * 20261001T181327Z: whether a site's range takes the library's change depended on the library
 * lane's detective choosing to report the version it ships in. Twice it did not; one site then
 * bumped its range, another wrote "no change needed while cx-shared ships a 7.x release (caret
 * range already accepts it)" — an assumption, the library being at 8.10.0.
 *
 * The engine reads each codeline's own manifest through the ecosystem provider that owns it (the
 * same providers every other manifest reader uses) and gives the detective of a spanning story the
 * facts: what each codeline provides, at what version, and the range each codeline declares for a
 * package another codeline of the story provides. The judgement — does that range take the change —
 * stays the detective's.
 *
 * EXECUTED: the real codelinePackages (lib/codeline-packages.js) over real manifests on disk, and
 * the real detectivePrescription (spec-mode-runner.js), given the PRD the lane runs with.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const work = mkdtempSync(join(tmpdir(), 'codeline-packages-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function repo(dir: string, manifest: object) {
  const p = join(work, dir); mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify(manifest));
  return p;
}
const lib = repo('lib-repo', { name: '@scope/lib', version: '8.1.0', dependencies: { react: '^18.0.0' } });
const site = repo('site.example', { name: 'site', version: '1.0.0', dependencies: { '@scope/lib': '^7.0.0', react: '^18.0.0' } });
const other = repo('other.example', { name: 'other', version: '2.0.0', devDependencies: { '@scope/lib': '^8.0.0' } });

const prd = {
  project: { outputDirs: [{ codeline: 'lib', path: lib }, { codeline: 'site', path: site }, { codeline: 'other', path: other }] },
  stories: [],
};
const story = (lane: string) => ({ id: 'S-1', codeline: lane, codelines: ['lib', 'site', 'other'], fixSiteAnalysisPerCodeline: {} });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { codelinePackages } = require(join(SCRIPTS, 'lib/codeline-packages.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(SCRIPTS, 'spec-mode-runner.js'));

describe('each codeline\'s package facts, read from its own manifest', () => {
  const facts = codelinePackages(prd, ['lib', 'site', 'other']);
  const by = (cl: string) => facts.find((f: any) => f.codeline === cl);

  it('what each codeline provides, and at what version', () => {
    expect(by('lib').provides).toEqual({ name: '@scope/lib', version: '8.1.0' });
    expect(by('site').provides).toEqual({ name: 'site', version: '1.0.0' });
  });

  it('the range each codeline declares for a package a sibling provides — and only those', () => {
    expect(by('site').declares).toEqual({ '@scope/lib': '^7.0.0' });
    expect(by('other').declares).toEqual({ '@scope/lib': '^8.0.0' });
    expect(by('lib').declares).toEqual({});
  });

  it('a codeline with no folder in the PRD is reported as unknown, never guessed', () => {
    const f = codelinePackages(prd, ['lib', 'ghost']).find((x: any) => x.codeline === 'ghost');
    expect(f.provides).toBeNull();
    expect(f.declares).toEqual({});
  });
});

describe('the detective of a spanning story is given those facts', () => {
  for (const kind of ['defect', 'novel']) {
    it(`${kind}: the provider's version and every sibling's declared range are in its instructions`, () => {
      const out = runner.detectivePrescription(kind, story('site'), prd);
      expect(out).toContain('@scope/lib');
      expect(out).toContain('8.1.0');
      expect(out).toContain('^7.0.0');
      expect(out).toContain('^8.0.0');
    });
  }

  it('the lane\'s own PRD (PRD_FILE) is read when the caller passes none — as the spec pass runs it', () => {
    const f = join(work, 'lane-prd.json'); writeFileSync(f, JSON.stringify(prd));
    const prev = process.env.PRD_FILE; process.env.PRD_FILE = f;
    try { expect(runner.detectivePrescription('novel', story('site'))).toContain('8.1.0'); }
    finally { if (prev === undefined) delete process.env.PRD_FILE; else process.env.PRD_FILE = prev; }
  });

  // ONE CODELINE, ONE PLAN, SAME PROCESS (operator, 2026-10-06): asked for its plan, given no package facts.
  it('a story confined to one codeline is asked for its plan, and given no cross-codeline package facts', () => {
    const base = runner.detectivePrescription('novel');
    expect(base.length).toBeGreaterThan(100);
    const one = runner.detectivePrescription('novel', { id: 'S-2', codeline: 'lib' }, prd);
    expect(one.startsWith(base)).toBe(true);
    expect(one).toContain('<OVERALL_PLAN>');
    expect(one).not.toContain('PACKAGE FACTS');
  });
});

describe('the detective itself is given the facts — the real call, as both callers make it', () => {
  // A stand-in model that records the prompt it is given and answers nothing.
  const capture = join(work, 'det-prompt.txt');
  const runnerSh = join(work, 'det-runner.sh');
  writeFileSync(runnerSh, `#!/bin/bash\n{ echo "ARGS: $*"; cat; } >> ${JSON.stringify(capture)}\n`);
  chmodSync(runnerSh, 0o755);
  const proj = join(work, 'det-project'); mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(join(SCRIPTS, '../prompts/templates/code-graph-detective.json'), join(proj, 'prompts', 'code-graph-detective.json'));

  it('runCodeGraphDetective uses the PRD it is given (opts.prd)', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { EPAM_BROWNFIELD: '1', EPAM_PROJECT_CONFIG_DIR: proj, PROJECT_ROOT: site, AI_RUNNER_CMD: runnerSh, EPAM_ORCHESTRATION_PROVIDER: process.env.EPAM_ORCHESTRATION_PROVIDER || 'openrouter', SPEC_MODE_NO_MAIN: '1' });
    delete process.env.PRD_FILE;
    try {
      const logDir = join(work, 'det-logs'); mkdirSync(logDir, { recursive: true });
      await runner.runCodeGraphDetective({ ...story('site'), title: 'toast fix', description: 'make the toast accessible' }, logDir, { promptExec: { cmd: runnerSh, args: [] }, prd });
    } finally { process.env = saved; }
    expect(existsSync(capture), 'the detective never asked its model').toBe(true);
    const text = readFileSync(capture, 'utf8');
    expect(text).toContain('THIS STORY SPANS CODELINES');
    expect(text).toContain('PACKAGE FACTS');
    expect(text).toContain('8.1.0');
  }, 170000);

  it('the detective re-run step hands the detective its PRD', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rerun = require(join(SCRIPTS, 'detective-rerun-step.js'));
    const seen: any[] = [];
    const p = { ...prd, stories: [{ id: 'S-1', codelines: ['lib', 'site', 'other'], fixSiteAnalysisPerCodeline: { site: [] } }] };
    await rerun.runRerun({ prd: p, codelines: ['site'], logDir: '', detective: async (_s: any, _l: any, opts: any) => { seen.push(opts); return []; } });
    expect(seen.length, 'the detective was never called').toBeGreaterThan(0);
    expect(seen[0].prd).toBe(p);
  });
});
