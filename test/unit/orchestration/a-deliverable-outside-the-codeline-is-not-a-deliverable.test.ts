/**
 * A DELIVERABLE OUTSIDE THE CODELINE IS NOT A DELIVERABLE.
 *
 * verify_story_deliverables resolved an ABSOLUTE declared path as given. The greenfield canonical
 * PRD declared /home/<user>/projects/skyscanner-app/package.json — the output directory of a run
 * in August — and that directory still existed on the host, so the £0 run of 2026-09-13, building
 * into a fresh directory, reported "Verified 3 declared deliverable(s)" for a story whose codeline
 * held nothing at all. A verification that looks outside the codeline it is verifying is a false
 * green by construction.
 *
 * Outside PROJECT_ROOT (and, in worktree mode, MAIN_PROJECT_ROOT, which is re-rooted) an absolute
 * path is refused by name. Relative declarations, and absolute ones under the codeline, are
 * unchanged. The real function is lifted from claude.sh and EXECUTED, as its sibling tests do.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = engineSource(CLAUDE_SH);
function fn(name: string): string {
  const m = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm').exec(SRC);
  if (!m) throw new Error(`no ${name}()`);
  return SRC.slice(m.index, SRC.indexOf('\n}', m.index) + 2);
}

function verify(declared: (root: string, elsewhere: string) => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'deliv-'));
  const root = join(dir, 'codeline'); const elsewhere = join(dir, 'elsewhere');
  mkdirSync(root); mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'package.json'), '{"name":"not-this-run"}');
  writeFileSync(join(root, 'package.json'), '{"name":"this-run"}');
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', technicalNotes: { files: declared(root, elsewhere) } }] }));
  const script = [
    `PROJECT_ROOT=${JSON.stringify(root)}`, `PRD_FILE=${JSON.stringify(prd)}`, `MAIN_PRD_FILE=${JSON.stringify(prd)}`,
    'error() { echo "ERROR: $*"; }', 'success() { echo "SUCCESS: $*"; }', 'warning() { echo "WARN: $*"; }', 'log() { echo "LOG: $*"; }',
    'verify_prescribed_helper_used() { return 0; }', 'record_story_outputs() { return 0; }', '_get_vendor_dirs() { :; }',
    fn('_resolve_deliverable_path'), fn('_resolved_baseline_ref'), fn('verify_story_deliverables'),
    'verify_story_deliverables S-1; echo "RC=$?"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });
  rmSync(dir, { recursive: true, force: true });
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: Number((out.match(/RC=(\d+)/) || [])[1]), out };
}

describe('a deliverable outside the codeline is not a deliverable', () => {
  it('THE DEFECT: an absolute path in another directory is refused, even when that file exists', () => {
    const r = verify((_root, elsewhere) => [join(elsewhere, 'package.json')]);
    expect(r.rc, r.out).toBe(1);
    expect(r.out).toMatch(/outside the codeline/i);
    expect(r.out).not.toMatch(/Verified 1 declared/);
  });

  it('an absolute path under the codeline is verified as before', () => {
    const r = verify((root) => [join(root, 'package.json')]);
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toMatch(/Verified 1 declared/);
  });

  it('a relative path is verified against the codeline as before', () => {
    const r = verify(() => ['package.json']);
    expect(r.rc, r.out).toBe(0);
  });
});
