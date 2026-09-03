/**
 * PRE-LAUNCH DELETES THE LAUNCHING PROJECT'S KB. ALL OF IT.
 *
 * The KB is per-run scratch: agents write to it freely DURING a run, and that is how a finding
 * reaches a later step of the same run. What is never permitted is survival — no part of it may be
 * stale from a previous run, and none of it may cross projects.
 *
 * Only half of that was enforced. kb-canonical.sh restored the ENGINE KB (orchestrations/agents/
 * KB.md from KB.md.original) and truncated the engine store (orchestrations/agents/kb/). The
 * LAUNCHING PROJECT'S OWN KB was untouched by anything:
 *
 *   projects/metrolinx/KB.md                   16 Aug — 16 references to a closed ticket
 *   projects/metrolinx/kb/healing-events.jsonl 30 Aug
 *   projects/metrolinx/kb/constraints.json     30 Aug
 *
 * kb-store.js reads exactly that path — EPAM_PROJECT_CONFIG_DIR/kb — so the 2026-09-01 metrolinx
 * run for AMSD-1919 (a checkout email case-sensitivity fix) started against a KB carrying August's
 * conclusions about AMSD-2041, a Contentstack live-preview ticket. The run was killed at the roster
 * step.
 *
 * DELETED, NOT TRUNCATED. The operator's instruction is deletion, and kb-store.js recreates its
 * directory on first write (mkdirSync recursive), so nothing needs an empty file left behind.
 *
 * A RESET THAT CANNOT CLEAN MUST SAY SO. Reporting a clean start while carrying the previous run's
 * conclusions is the failure this exists to prevent, so a residue left behind is an error, never a
 * silent pass.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/kb-canonical.sh');
const RESET = join(REPO, 'orchestrations/scripts/pre-run-reset.sh');

/** A project directory carrying a previous run's KB, in the shape the pipeline writes. */
function projectWithStaleKb() {
  const dir = mkdtempSync(join(tmpdir(), 'proj-kb-'));
  writeFileSync(join(dir, 'KB.md'), '## KB-015\n**StoryRef:** AMSD-2041\nlive_preview enable\n');
  mkdirSync(join(dir, 'kb'), { recursive: true });
  writeFileSync(join(dir, 'kb/healing-events.jsonl'), '{"story":"AMSD-2041","fix":"stale"}\n');
  writeFileSync(join(dir, 'kb/constraints.json'), '[{"rule":"from a previous run"}]');
  writeFileSync(join(dir, 'kb/unmapped-rules.jsonl'), '{"rule":"older still"}\n');
  // Not KB: must survive, or the reset is deleting the project itself.
  writeFileSync(join(dir, 'config.env'), 'EPAM_X=1\n');
  writeFileSync(join(dir, 'prd.json'), '{"stories":[]}');
  return dir;
}

function run(dir: string | null) {
  const r = spawnSync('bash', ['-c', `
    set +e
    success() { echo "SUCCESS: $*"; }
    info()    { echo "INFO: $*"; }
    warning() { echo "WARN: $*"; }
    . ${JSON.stringify(LIB)}
    ${dir === null ? '' : `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(dir)}`}
    kb_delete_project_kb
    echo "RC=$?"`], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: '' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, rc: /RC=(\d+)/.exec(r.stdout || '')?.[1] };
}

describe('pre-launch deletes the project\'s KB', () => {
  it('the function exists', () => {
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; type -t kb_delete_project_kb`],
      { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').trim(), 'kb_delete_project_kb is not defined').toBe('function');
  }, 40_000);

  it('deletes KB.md and every file under kb/', () => {
    const dir = projectWithStaleKb();
    const r = run(dir);
    expect(r.rc, `it failed:\n${r.out}`).toBe('0');
    expect(existsSync(join(dir, 'KB.md')), 'KB.md survived').toBe(false);
    const left = existsSync(join(dir, 'kb')) ? readdirSync(join(dir, 'kb')) : [];
    expect(left, `kb/ still holds a previous run's files: ${left.join(', ')}`).toEqual([]);
  }, 70_000);

  it('deletes NOTHING else — config and PRD survive', () => {
    // The negative half. A reset that takes the project with it is not a reset.
    const dir = projectWithStaleKb();
    run(dir);
    expect(existsSync(join(dir, 'config.env')), 'config.env was deleted').toBe(true);
    expect(existsSync(join(dir, 'prd.json')), 'prd.json was deleted').toBe(true);
  }, 70_000);

  it('says what it removed, so a clean start is not merely claimed', () => {
    const dir = projectWithStaleKb();
    expect(run(dir).out).toMatch(/SUCCESS:.*KB/i);
  }, 70_000);

  it('with no project selected it reports that, rather than passing silently', () => {
    const r = run(null);
    expect(r.rc).toBe('0');
    expect(r.out, 'a reset with no project said nothing at all — indistinguishable from having run')
      .toMatch(/no project|not selected|nothing to delete/i);
  }, 70_000);

  it('RESIDUE IS AN ERROR, not a silent pass', () => {
    // A file it cannot remove means the next run inherits a previous run's conclusions. The reset
    // must fail loudly rather than announce a clean start it did not achieve.
    const dir = projectWithStaleKb();
    const kb = join(dir, 'kb');
    chmodSync(kb, 0o500); // read+execute only: entries cannot be unlinked
    try {
      const r = run(dir);
      expect(r.rc, `residue was left but it reported success:\n${r.out}`).not.toBe('0');
    } finally {
      chmodSync(kb, 0o700);
    }
  }, 70_000);

  it('PRE-RUN-RESET CALLS IT — a function nothing invokes deletes nothing', () => {
    const { readFileSync } = require('node:fs');
    expect(readFileSync(RESET, 'utf8'), 'pre-run-reset.sh never calls kb_delete_project_kb')
      .toMatch(/kb_delete_project_kb/);
  });
});
