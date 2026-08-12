/**
 * KEEP-OR-DISCARD IS A SPEC QUESTION, AND IT ASKED THE WRONG FIELD.
 *
 * Between ladder rungs, _selective_worktree_reset decides whether the attempt's work survives.
 * It kept the work only if the attempt touched a file where fixVerified === true.
 *
 * WRONG FIELD. `fixVerified` means "the detective's PRESCRIPTION for this file was verified".
 * "This file must be edited" is `changeRequired`. Reading the first to answer the second
 * inverted the guard against its own stated intent. Measured on the live AMSD-2041/gotransit
 * PRD:
 *
 *   changeRequired  fixVerified  file                                 protected?
 *   true            true         src/context/ContentstackContext.tsx   yes
 *   true            FALSE        src/pages/_app.tsx                    NO
 *   true            NULL         .env.local.sample                     NO
 *   false           true         src/services/contentstack.ts          yes
 *   false           true         src/hooks/useContent.ts               yes
 *
 * Two of the THREE files the story must edit were not evidence of progress, so an attempt that
 * correctly edited _app.tsx and .env.local.sample and nothing else was DELETED as "changed no
 * VERIFIED fix site". Both files the detective said to LEAVE ALONE did count, so an attempt
 * that wrongly rewrote useContent.ts was PRESERVED — rewarding the exact failure mode that
 * killed three runs.
 *
 * This function was ALREADY rewritten once, 2026-08-10, after "25 file writes across five
 * invocations, zero survivors". That rewrite fixed the compiler-vs-spec question and left the
 * predicate wrong.
 *
 * These tests run the REAL function against a REAL git repository and assert THE POST-RESET
 * TREE — the artifact, not the source text.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Site = { file: string; changeRequired?: boolean | null; fixVerified?: boolean | null };

const BASELINE = 'BASELINE\n';
const EDITED = 'EDITED BY THE WRITER\n';

/** Extract the real function from claude.sh, braces balanced. */
function extract(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf(`${name}() {`);
  expect(start, `${name} not found — the test is stale, not the code`).toBeGreaterThan(-1);
  let depth = 0; let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

/**
 * Build a git repo at a baseline, edit `edited`, then run the real reset guard.
 * Returns which of the repo's files still differ from baseline afterwards.
 */
function runReset(sites: Site[], edited: string[]): string[] {
  const d = mkdtempSync(join(tmpdir(), 'resetguard-')); dirs.push(d);
  const repo = join(d, 'repo');
  const files = [...new Set(sites.map((s) => s.file))];

  const git = (args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), BASELINE);
  }
  git(['add', '-A']); git(['commit', '-qm', 'baseline']);
  // The guard resolves origin/<branch>; a local ref of that name is indistinguishable to it.
  git(['update-ref', 'refs/remotes/origin/develop', 'HEAD']);

  for (const f of edited) writeFileSync(join(repo, f), EDITED);

  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{
      id: 'AMSD-TEST',
      fixSiteAnalysis: sites.map((s) => {
        const o: Record<string, unknown> = { file: s.file };
        if (s.changeRequired !== undefined) o.changeRequired = s.changeRequired;
        if (s.fixVerified !== undefined) o.fixVerified = s.fixVerified;
        return o;
      }),
    }],
  }, null, 2));

  const script = [
    'set -u',
    'log() { :; }',
    '_provision_epam_plugin_config() { :; }',
    'EPAM_BROWNFIELD=1',
    `PROJECT_ROOT='${repo}'`,
    `PRD_FILE='${prd}'`,
    'MAIN_PRD_FILE=""',
    'JIRA_BASELINE_BRANCH=develop',
    'LAST_VERIFIED_TOUCHED_FILES=""',
    'LAST_VERIFIED_UNCHANGED_FILES=""',
    extract('_selective_worktree_reset'),
    '_selective_worktree_reset "AMSD-TEST"',
  ].join('\n');

  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, `guard failed: ${r.stderr}`).toBe(0);

  return files.filter((f) => {
    try { return readFileSync(join(repo, f), 'utf8') !== BASELINE; } catch { return false; }
  }).sort();
}

describe('the harness is real — otherwise every assertion is vacuous', () => {
  it('an edit survives when the guard preserves, and is undone when it resets', () => {
    const kept = runReset([{ file: 'a.ts', changeRequired: true }], ['a.ts']);
    expect(kept, 'nothing survived — the harness never edited anything').toEqual(['a.ts']);
    const wiped = runReset([{ file: 'a.ts', changeRequired: false }], ['a.ts']);
    expect(wiped, 'the guard never reset — every assertion below would pass trivially').toEqual([]);
  });
});

describe('A FILE THE SPEC SAYS MUST CHANGE IS EVIDENCE OF PROGRESS', () => {
  /** The live gotransit prescription, exactly. */
  const LIVE: Site[] = [
    { file: 'ctx.tsx', changeRequired: true, fixVerified: true },
    { file: 'app.tsx', changeRequired: true, fixVerified: false },
    { file: 'env.sample', changeRequired: true, fixVerified: null },
    { file: 'service.ts', changeRequired: false, fixVerified: true },
    { file: 'useContent.ts', changeRequired: false, fixVerified: true },
  ];

  it('THE DEFECT: editing only _app.tsx and .env.local.sample is no longer deleted', () => {
    // changeRequired:true on both; fixVerified false and null. The old predicate discarded
    // this attempt as "changed no VERIFIED fix site".
    expect(runReset(LIVE, ['app.tsx', 'env.sample'])).toEqual(['app.tsx', 'env.sample']);
  });

  it('a single required edit is enough to preserve the whole attempt', () => {
    expect(runReset(LIVE, ['env.sample'])).toEqual(['env.sample']);
  });

  it('editing ONLY files the detective said to leave alone is NOT progress', () => {
    // Both are fixVerified:true, so the old predicate PRESERVED this — rewarding the exact
    // over-reach (useContent.ts) that killed three runs.
    expect(runReset(LIVE, ['useContent.ts', 'service.ts'])).toEqual([]);
  });

  it('changing nothing at all resets', () => {
    expect(runReset(LIVE, [])).toEqual([]);
  });
});

describe('ABSENT MEANS PROTECT — "we do not know yet" is not grounds for deleting work', () => {
  it('a site with NO verdict counts as progress', () => {
    // Matches the enforcement gate's own `!= false` reading. Build-config candidates are
    // added with changeRequired absent by design; discarding work on them would delete the
    // fix the candidate exists to obtain.
    expect(runReset([{ file: 'jest.config.js' }], ['jest.config.js'])).toEqual(['jest.config.js']);
  });

  it('an explicit false is the ONLY exemption', () => {
    expect(runReset([{ file: 'x.ts', changeRequired: false }], ['x.ts'])).toEqual([]);
  });

  it('a null verdict protects', () => {
    expect(runReset([{ file: 'y.ts', changeRequired: null }], ['y.ts'])).toEqual([]
      .concat(['y.ts']));
  });

  it('fixVerified alone no longer decides anything', () => {
    // fixVerified:true with changeRequired:false must NOT protect; the inverse must.
    expect(runReset([{ file: 'p.ts', changeRequired: false, fixVerified: true }], ['p.ts'])).toEqual([]);
    expect(runReset([{ file: 'q.ts', changeRequired: true, fixVerified: false }], ['q.ts'])).toEqual(['q.ts']);
  });
});
