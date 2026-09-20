/**
 * A STORY COMMITS ONLY ITS OWN WORK.
 *
 * regintel 20260919T224649Z: "REGI-007a: story complete (6 file(s))" carried a +297/−98 rewrite of
 * regintel/classifier.py — a file 007a does not declare. It was the partial edit of a scoped fix
 * that ran in REGI-005a during 007a's escalation, did not converge, and was left in the tree;
 * 007a's commit swept it up. "REGI-005b: story complete (9 file(s))" carried
 * retry-extension-decisions.jsonl — a pipeline ledger written into the codeline because its
 * writer defaulted to OUTPUT_DIR. Provenance is lost and other stories' half-work ships under
 * the wrong name.
 *
 * (1) A scoped fix that does not converge is reverted to the tree as it stood when the fix
 * began (the same snapshot the analyst's evidence uses), so nothing of it reaches the
 * escalating story's commit. (2) The retry-extension ledger lives in LOG_DIR with the run's
 * other ledgers, never in the codeline. Executed with real git.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const src = engineSource(join(ROOT, 'orchestrations/scripts/claude.sh')) + '\n' + readFileSync(join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh'), 'utf8');
const RETRY_LIB = join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fn(name: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (start === -1) throw new Error(`no ${name}`);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) { body.push(lines[i]); if (lines[i] === '}') return body.join('\n'); }
  throw new Error(`unterminated ${name}`);
}
const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).stdout.trim();

function codeline() {
  const dir = mkdtempSync(join(tmpdir(), 'own-work-')); dirs.push(dir);
  git(dir, 'init', '-q'); mkdirSync(join(dir, 'regintel'));
  writeFileSync(join(dir, 'regintel/classifier.py'), 'async def classify_event(event, client=None): ...\n');
  writeFileSync(join(dir, 'regintel/api.py'), 'app = None\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'REGI-004a: story complete');
  // 007a's own in-flight edit, uncommitted, present when the escalation fires.
  writeFileSync(join(dir, 'regintel/api.py'), 'app = FastAPI()\n');
  return dir;
}

describe('(1) a non-converged scoped fix is reverted to the tree as it stood when the fix began', () => {
  function resolve(dir: string, fixOutcome: 0 | 1) {
    const logs = join(dir, 'logs'); mkdirSync(logs, { recursive: true });
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [
      { id: 'REGI-005a', technicalNotes: { files: ['regintel/classifier.py'] } },
      { id: 'REGI-007a', technicalNotes: { files: ['regintel/api.py'] } },
    ] }));
    mkdirSync(join(dir, '.epam/escalations'), { recursive: true });
    writeFileSync(join(dir, '.epam/escalations/REGI-007a.json'), JSON.stringify({ targetFile: 'regintel/classifier.py', diagnosis: 'd', requiredFix: 'f' }));
    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      `source ${JSON.stringify(RETRY_LIB)}`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`, `PRD_FILE=${JSON.stringify(join(dir, 'prd.json'))}`, `LOG_DIR=${JSON.stringify(logs)}`, `MAX_RETRIES=7`,
      `log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; success() { echo "OK: $*"; }`,
      // The owner's writer half-rewrites its file and adds a stray one, then reports the outcome.
      `implement_story() { printf 'def classify_event(conn, event_row): ...  # half done\\n' > "$PROJECT_ROOT/regintel/classifier.py"; printf 'x' > "$PROJECT_ROOT/regintel/stray.py"; return ${fixOutcome}; }`,
      fn('_attempt_start_snapshot'), fn('_restore_tree_snapshot'), fn('resolve_escalation'),
      'resolve_escalation REGI-007a; echo "EXIT:$?"',
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`;
  }

  it('did not converge → the owner\'s file is back to what it was, the stray file is gone, the escalating story\'s own edit is untouched', () => {
    const dir = codeline();
    const out = resolve(dir, 1);
    expect(out, out).toMatch(/EXIT:1/);
    expect(readFileSync(join(dir, 'regintel/classifier.py'), 'utf8')).toMatch(/async def classify_event/);
    expect(existsSync(join(dir, 'regintel/stray.py'))).toBe(false);
    expect(readFileSync(join(dir, 'regintel/api.py'), 'utf8')).toBe('app = FastAPI()\n');
    expect(out).toMatch(/revert/i);
  });
  it('converged → the fix stays', () => {
    const dir = codeline();
    const out = resolve(dir, 0);
    expect(out).toMatch(/EXIT:0/);
    expect(readFileSync(join(dir, 'regintel/classifier.py'), 'utf8')).toMatch(/half done/);
  });
  it('_restore_tree_snapshot restores tracked, staged and untracked state alike', () => {
    const dir = codeline();
    const r = spawnSync('bash', ['-c', [
      `PROJECT_ROOT=${JSON.stringify(dir)}`, fn('_attempt_start_snapshot'), fn('_restore_tree_snapshot'),
      'snap=$(_attempt_start_snapshot)',
      'printf "changed" > "$PROJECT_ROOT/regintel/classifier.py"; printf "new" > "$PROJECT_ROOT/new.txt"; git -C "$PROJECT_ROOT" add regintel/classifier.py; rm "$PROJECT_ROOT/regintel/api.py"',
      '_restore_tree_snapshot "$snap"',
      'echo "AFTER=$(_attempt_start_snapshot) SNAP=$snap"',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.stdout).toMatch(/AFTER=(\w+) SNAP=\1/);
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'regintel/api.py'), 'utf8')).toBe('app = FastAPI()\n');
  });
});

describe('(2) the retry-extension ledger lives with the run\'s ledgers, never in the codeline', () => {
  it('is written under LOG_DIR even when OUTPUT_DIR (the codeline) is set', () => {
    const src2 = readFileSync(join(ROOT, 'orchestrations/scripts/lib/retry-extension.sh'), 'utf8');
    expect(src2).not.toMatch(/\$\{OUTPUT_DIR:-\$LOG_DIR\}\/retry-extension-decisions\.jsonl/);
    expect(src2).toMatch(/"\$\{LOG_DIR\}\/retry-extension-decisions\.jsonl"/);
  });
  it('and the run\'s reset clears it with the other ledgers', () => {
    const reset = readFileSync(join(ROOT, 'orchestrations/scripts/pre-run-reset.sh'), 'utf8');
    expect(reset).toMatch(/retry-extension-decisions\.jsonl/);
  });
});
