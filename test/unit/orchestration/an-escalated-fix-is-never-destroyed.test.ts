/**
 * AN ESCALATED FIX IS NEVER DESTROYED — IT IS ISOLATED, AS THE ENGINE ISOLATES EVERYTHING ELSE.
 *
 * When story A's analyst finds the defect in story B's file, the engine runs B as a scoped fix and
 * then — if B's result does not converge — RESTORES A TREE SNAPSHOT, deleting every file B wrote:
 *
 *     [Escalation] REGI-002's partial edits reverted — nothing of a non-converged fix reaches the commit
 *
 * Live, regintel resume 9 (2026-09-23): REGI-002 was handed the RU-006 ingest defect twice, wrote
 * the correct fix twice, passed its own tests twice — and had the work deleted twice, because the
 * whole-codeline suite still failed on tests owned by OTHER stories (against an empty baseline it
 * could never satisfy). Each retry therefore began from identical code. Self-heal diagnosed
 * correctly four times and was overruled four times by a deterministic revert.
 *
 * The hazard the revert addressed is real: B's half-finished edits must not be swept into A's
 * commit. But this pipeline already isolates work — worktrees, one per lane — so attribution is
 * structural rather than something enforced by deleting. A non-converged fix stays on its own
 * branch, in its own worktree, and the next escalation resumes from it.
 *
 * NEGATIVES FIRST, because this path had no test at all and its failure mode is silent data loss.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const LADDER = join(ROOT, 'orchestrations/scripts/lib/model-ladder.sh');
const HEALING = join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Drives the REAL resolve_escalation. `implement_story` is stubbed because it is the AGENT — the
 * thing under test is what the engine does with the agent's work, not what the agent writes.
 */
function escalate(opts: {
  converges: boolean;
  /** what the scoped fix writes, relative to whatever tree it runs in */
  writes?: Record<string, string>;
  /** a second escalation over the same sibling, to prove work accumulates */
  again?: { converges: boolean; writes?: Record<string, string> };
  /** the escalating story's own uncommitted work, which must never be touched */
  parentDirty?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'esc-preserve-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam', 'escalations'), { recursive: true });
  mkdirSync(join(repo, 'regintel'), { recursive: true });
  writeFileSync(join(repo, 'regintel', 'ingest.py'), 'def parse():\n    return None\n');
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'baseline');

  for (const [f, c] of Object.entries(opts.parentDirty ?? {})) writeFileSync(join(repo, f), c);

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: ['A-1', 'B-1'] },
    stories: [
      { id: 'A-1', status: 'pending', technicalNotes: { files: ['regintel/classifier.py'] } },
      { id: 'B-1', status: 'pending', technicalNotes: { files: ['regintel/ingest.py'] } },
    ],
  }));
  writeFileSync(join(repo, '.epam', 'escalations', 'A-1.json'), JSON.stringify({
    fromStoryId: 'A-1', targetFile: 'regintel/ingest.py',
    diagnosis: 'RU-006 ingested with empty jurisdiction_name',
    requiredFix: 'derive jurisdiction_name from raw_text when the Source line carries no label',
  }));

  // the scoped fix: writes its files into whatever tree it is given, then reports convergence
  const stub = (converges: boolean, writes?: Record<string, string>) => [
    'implement_story() {',
    '  local _root="${PROJECT_ROOT}"',
    ...Object.entries(writes ?? {}).map(([f, c]) =>
      `  mkdir -p "$(dirname "$_root/${f}")"; printf '%s' ${JSON.stringify(c)} > "$_root/${f}"`),
    `  return ${converges ? 0 : 1}`,
    '}',
  ].join('\n');

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export PRD_FILE=${JSON.stringify(prd)}`,
    `export LOG_DIR=${JSON.stringify(dir)}`,
    'export MAX_RETRIES=3',
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    'read_story_retry_count() { echo 0; }; write_story_retry_count() { :; }',
    'render_or_keep() { echo ""; }',
    // THE REAL SNAPSHOT AND RESTORE. Stubbing these to no-ops made every negative below pass
    // while proving nothing — the destruction under test simply never happened. They are the
    // mechanism, so they must be the real ones.
    shellFunction(HEALING, '_attempt_start_snapshot'),
    shellFunction(HEALING, '_restore_tree_snapshot'),
    stub(opts.converges, opts.writes),
    shellFunction(LADDER, '_escalation_branch'),
    shellFunction(LADDER, '_escalation_worktree'),
    shellFunction(LADDER, '_escalation_adopt_work'),
    shellFunction(LADDER, 'resolve_escalation'),
    'resolve_escalation A-1; echo "RC1=$?"',
    ...(opts.again ? [
      'rm -rf .stub && :',
      stub(opts.again.converges, opts.again.writes),
      `cat > "${join(repo, '.epam', 'escalations', 'A-1.json')}" <<'JSON'`,
      JSON.stringify({ fromStoryId: 'A-1', targetFile: 'regintel/ingest.py', diagnosis: 'still failing', requiredFix: 'again' }),
      'JSON',
      'resolve_escalation A-1; echo "RC2=$?"',
    ] : []),
  ].join('\n'));

  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  /** every file the scoped fix wrote, wherever it now lives — main tree or an isolated worktree */
  const findWritten = (rel: string) => {
    const hits: string[] = [];
    const scan = (d: string) => {
      for (const e of require('node:fs').readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const p = join(d, e.name);
        if (e.isDirectory()) scan(p);
        else if (p.endsWith(rel)) hits.push(p);
      }
    };
    scan(dir);
    return hits;
  };
  return { out, dir, repo, findWritten };
}

describe('an escalated fix is never destroyed', () => {
  it('NEGATIVE: a fix that does NOT converge still exists afterwards', () => {
    const { findWritten, out } = escalate({
      converges: false,
      writes: { 'regintel/ingest.py': 'def parse():\n    return "Ohio"  # derived from raw_text\n' },
    });
    const hits = findWritten('regintel/ingest.py').filter((p) => readFileSync(p, 'utf8').includes('Ohio'));
    expect(hits.length, `the scoped fix was deleted — nothing on disk carries it:\n${out.slice(-500)}`).toBeGreaterThan(0);
  });

  it('NEGATIVE: a new file the fix created is not deleted either', () => {
    const { findWritten } = escalate({
      converges: false,
      writes: { 'regintel/jurisdiction.py': 'US_STATES = ["Ohio"]\n' },
    });
    expect(findWritten('regintel/jurisdiction.py').length, 'a file the agent created was destroyed').toBeGreaterThan(0);
  });

  it("NEGATIVE: the escalating story's own uncommitted work is untouched", () => {
    const { repo } = escalate({
      converges: false,
      writes: { 'regintel/ingest.py': 'fixed\n' },
      parentDirty: { 'regintel/classifier.py': 'A-1 was here\n' },
    });
    expect(existsSync(join(repo, 'regintel', 'classifier.py')), "the parent's work vanished").toBe(true);
    expect(readFileSync(join(repo, 'regintel', 'classifier.py'), 'utf8')).toContain('A-1 was here');
  });

  it('NEGATIVE: a second escalation resumes from the first attempt, not from scratch', () => {
    const { findWritten } = escalate({
      converges: false,
      writes: { 'regintel/jurisdiction.py': 'first attempt\n' },
      again: { converges: false, writes: { 'regintel/ingest.py': 'second attempt\n' } },
    });
    expect(
      findWritten('regintel/jurisdiction.py').length,
      "the first attempt's work was gone by the time the second ran — every retry starts from nothing",
    ).toBeGreaterThan(0);
  });

  it('a fix that DOES converge reaches the codeline', () => {
    const { repo } = escalate({
      converges: true,
      writes: { 'regintel/ingest.py': 'def parse():\n    return "Ohio"\n' },
    });
    expect(readFileSync(join(repo, 'regintel', 'ingest.py'), 'utf8'), 'a converged fix did not reach the main tree').toContain('Ohio');
  });

  it("says where a non-converged fix was kept, so the next attempt can find it", () => {
    const { out } = escalate({ converges: false, writes: { 'regintel/ingest.py': 'fixed\n' } });
    expect(out, 'the work was kept but nothing said where').toMatch(/kept|preserved|worktree|branch/i);
  });

  // NON-VACUITY. Every negative above is about ISOLATION, and the old wording also matched the
  // no-worktree fallback ("the fix runs in the main tree; its work is kept either way"). When this
  // harness stopped lifting a function _escalation_worktree needs, the worktree failed silently,
  // the fix ran in the main tree, and all six tests still passed. They must see the worktree.
  it('the fix really ran in its own worktree, on the branch the log names — otherwise nothing above tested isolation', () => {
    const { out } = escalate({ converges: false, writes: { 'regintel/ingest.py': 'fixed\n' } });
    expect(out).not.toContain('no worktree available');
    expect(out).toMatch(/works in its own worktree \S+-esc-B-1 \(branch esc\/B-1\)/);
  });
});
