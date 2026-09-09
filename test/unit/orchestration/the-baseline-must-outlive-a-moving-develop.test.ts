/**
 * THE BASELINE WAS RECORDED BEFORE THE BRANCH IT DESCRIBES EXISTED.
 *
 * fae97818 made qa_phase_baseline_sha record the DIVERGENCE POINT instead of raw HEAD, and its
 * tests passed because both fixtures held `develop` still. Live 2026-09-09 it still misfired:
 *
 *   recorded baseline : 12e20001   (captured at the top of Step 8)
 *   branch after reset: 4cb3c33e   (ensure_story_branch rebased onto origin/develop)
 *
 * A colleague had merged PR #5669 that morning, so origin/develop moved between the capture and
 * the reset. The gates were handed THREE files of that colleague's work as if they belonged to
 * AMSD-1919, and plan-fidelity reported "the change went outside the plan of record".
 *
 *   this story changed : CheckoutForm.tsx                   1 file
 *   gates were shown   : CheckoutForm.tsx
 *                        useAbandonedCartPrompt.spec.tsx    <- 4cb3c33e
 *                        useAbandonedCartPrompt.ts          <- 4cb3c33e
 *                        useAbandonedCartPromptContent.ts   <- 4cb3c33e
 *
 * The ORDER is the defect: run-agent-orchestration.sh captures at line ~6174, before the story
 * loop, and ensure_story_branch resets at ~6257 inside it. Any upstream commit landing in that
 * window is attributed to the story.
 *
 * This harness moves `develop` in exactly that window — the case the earlier fixtures could not
 * express — and drives the REAL functions: qa_phase_baseline_sha from lib/qa-gate-evidence.sh and
 * ensure_story_branch lifted from lib/git-ops.sh. No pipeline run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const EVID = join(ROOT, 'orchestrations/scripts/lib/qa-gate-evidence.sh');
const GITOPS = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real function body, lifted from the real file — never a paraphrase. */
function fnText(file: string, name: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in ${file}`);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end + 2);
}

/**
 * An UPSTREAM repo plus a clone, so origin/<branch> is a real remote-tracking ref that can move
 * mid-test — which is the whole point. A single local repo cannot express this defect.
 */
function estate() {
  const d = mkdtempSync(join(tmpdir(), 'basemove-')); dirs.push(d);
  const up = join(d, 'upstream'), work = join(d, 'work');
  mkdirSync(up, { recursive: true });
  const g = (repo: string, ...a: string[]) =>
    spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

  g(up, 'init', '-q', '-b', 'develop');
  g(up, 'config', 'user.email', 't@t'); g(up, 'config', 'user.name', 't');
  mkdirSync(join(up, 'src'), { recursive: true });
  writeFileSync(join(up, 'src/CheckoutForm.tsx'), 'const compare = (a,b) => a !== b;\n');
  g(up, 'add', '-A'); g(up, 'commit', '-qm', 'develop base');

  spawnSync('git', ['clone', '-q', up, work], { encoding: 'utf8' });
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');

  // The PREVIOUS leg's story branch, carrying work the reset will discard.
  g(work, 'checkout', '-q', '-b', 'bugfix/AI-AMSD-1919');
  writeFileSync(join(work, 'src/CheckoutForm.tsx'), 'const compare = (a,b) => a !== b; // prev\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'prev leg: story complete');

  return { d, up, work, g };
}

/**
 * A colleague merges upstream — exactly what happened as PR #5669. Written as a SCRIPT so it can
 * run INSIDE the sequence, between capture and reset. Doing it before the sequence (my first
 * attempt) means the capture already sees the moved develop and the defect cannot reproduce.
 */
function colleagueScript(e: ReturnType<typeof estate>) {
  const f = join(e.d, 'colleague.sh');
  writeFileSync(f, `#!/usr/bin/env bash
set -e
mkdir -p "${e.up}/src/hooks"
printf 'export const x = 1;\\n' > "${e.up}/src/hooks/useAbandonedCartPrompt.ts"
git -C "${e.up}" add -A
git -C "${e.up}" commit -qm 'AMSD-2956: unrelated colleague work (#5669)'
`);
  return f;
}

/** Runs the REAL functions in the REAL order, with the colleague's merge in the chosen window. */
function sequence(order: 'capture-then-reset' | 'reset-then-capture') {
  const e = estate();
  const logs = join(e.d, 'logs'); mkdirSync(logs, { recursive: true });
  const script = join(e.d, 'run.sh');
  const capture = `qa_phase_baseline_sha "${e.work}" develop > "${logs}/phase-baseline-sha.txt"`;
  // ensure_story_branch needs the pipeline's log helpers; stub only those, never the logic.
  const reset = `ensure_story_branch "${e.work}" AMSD-1919 develop >/dev/null 2>&1 || true`;
  const body = order === 'capture-then-reset'
    ? `git -C "${e.work}" fetch -q origin\n${capture}\n__COLLEAGUE__\ngit -C "${e.work}" fetch -q origin\n${reset}`
    : `git -C "${e.work}" fetch -q origin\n__COLLEAGUE__\ngit -C "${e.work}" fetch -q origin\n${reset}\n${capture}`;

  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
# ensure_story_branch is a no-op unless the run is brownfield — the guard that made my first
# harness silently skip the reset, so the defect could not reproduce.
export EPAM_BROWNFIELD=1
# Only the PERIPHERAL helpers are stubbed: logging, the write perimeter and plugin provisioning.
# The branch resolution and reset are the real function's own code.
success(){ :; }; warning(){ :; }; error(){ :; }; info(){ :; }; log(){ :; }
perimeter_apply(){ :; }; _provision_epam_plugin_config(){ :; }
source "${EVID}"
${fnText(GITOPS, 'ensure_story_branch')}
${body.replace('__COLLEAGUE__', `bash "${join(e.d, 'colleague.sh')}"`)}
`);
  colleagueScript(e);

  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
  const recorded = (() => {
    try { return readFileSync(join(logs, 'phase-baseline-sha.txt'), 'utf8').trim(); } catch { return ''; }
  })();
  const head = e.g(e.work, 'rev-parse', 'HEAD').stdout.trim();
  const forkPoint = e.g(e.work, 'merge-base', 'HEAD', 'origin/develop').stdout.trim();
  const diffFiles = e.g(e.work, 'diff', '--name-only', recorded || 'HEAD', 'HEAD').stdout.trim();
  const branch = e.g(e.work, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const resetHappened = e.g(e.work, 'log', '-1', '--format=%s').stdout.trim() !== 'prev leg: story complete';
  return { recorded, head, forkPoint, diffFiles, branch, resetHappened, err: r.stderr };
}

describe('the phase baseline when develop moves mid-step', () => {
  it('CAPTURED BEFORE THE RESET it is stale — the live defect, reproduced', () => {
    const s = sequence('capture-then-reset');
    expect(s.recorded, `nothing recorded. stderr: ${s.err.slice(0, 200)}`).not.toBe('');
    expect(s.resetHappened, 'ensure_story_branch never reset the branch — this harness proves nothing')
      .toBe(true);
    expect(s.recorded, 'the premise is gone: the baseline already matches the fork point')
      .not.toBe(s.forkPoint);
    // The consequence the gates actually saw.
    expect(s.diffFiles, "the colleague's file is absent, so this no longer reproduces")
      .toContain('useAbandonedCartPrompt.ts');
  });

  it('CAPTURED AFTER THE RESET it is exact — and carries no foreign work', () => {
    const s = sequence('reset-then-capture');
    expect(s.recorded).not.toBe('');
    expect(s.resetHappened, 'ensure_story_branch never reset the branch — this harness proves nothing')
      .toBe(true);
    expect(s.recorded, 'the baseline is not the branch\'s true fork point').toBe(s.forkPoint);
    expect(s.diffFiles, "a colleague's commit is still attributed to this story")
      .not.toContain('useAbandonedCartPrompt.ts');
  });
});

/**
 * THE HARNESS ABOVE PROVES THE ORDER MATTERS; THIS PROVES THE SCRIPT IMPLEMENTS IT.
 *
 * Removing the re-derive from run-agent-orchestration.sh left the two cases above green, because
 * they exercise qa_phase_baseline_sha rather than the call site. So this lifts the script's OWN
 * re-derive block verbatim, runs it against a repo whose develop moved, and asserts the recorded
 * FILE changed — the artifact, not the source text.
 */
describe("the script's own re-derive block", () => {
  /**
   * The real block, extracted from the real file — a paraphrase would prove nothing.
   * Matched LINE-WISE on the closing `fi` at the opening `if`'s own indentation: an
   * indexOf('\nfi') finds a column-0 `fi` hundreds of lines later and swallows all of Step 8.
   */
  function reDeriveBlock(): string {
    const lines = readFileSync(
      join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes('if [ -z "${_phase_baseline_after_reset:-}" ]'));
    if (i === -1) {
      throw new Error('the post-reset re-derive is GONE from run-agent-orchestration.sh — '
        + 'the baseline reverts to whatever was captured before the branch reset');
    }
    const pad = lines[i].length - lines[i].trimStart().length;
    const close = ' '.repeat(pad) + 'fi';
    const j = lines.findIndex((l, n) => n > i && l === close);
    if (j === -1) throw new Error('could not find the block\'s closing fi at its own indentation');
    return lines.slice(i, j + 1).map((l) => l.slice(pad)).join('\n');
  }

  it('REWRITES the recorded baseline once the branch has been based', () => {
    const e = estate();
    const logs = join(e.d, 'logs'); mkdirSync(logs, { recursive: true });
    colleagueScript(e);

    const script = join(e.d, 'rederive.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
export EPAM_BROWNFIELD=1
success(){ :; }; warning(){ :; }; error(){ :; }; info(){ :; }; log(){ :; }
perimeter_apply(){ :; }; _provision_epam_plugin_config(){ :; }
source "${EVID}"
${fnText(GITOPS, 'ensure_story_branch')}
PROJECT_ROOT="${e.work}"
LOG_DIR="${logs}"
JIRA_BASELINE_BRANCH=develop
git -C "${e.work}" fetch -q origin
# the PROVISIONAL capture, as the script does it before the story loop
_phase_baseline="$(qa_phase_baseline_sha "${e.work}" develop)"
echo "$_phase_baseline" > "${logs}/phase-baseline-sha.txt"
echo "PROVISIONAL=$_phase_baseline"
# a colleague merges, then the story branch is based — the live window
bash "${join(e.d, 'colleague.sh')}"
git -C "${e.work}" fetch -q origin
ensure_story_branch "${e.work}" AMSD-1919 develop >/dev/null 2>&1 || true
${reDeriveBlock()}
echo "FINAL=$(cat "${logs}/phase-baseline-sha.txt")"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const provisional = /PROVISIONAL=([0-9a-f]+)/.exec(out)?.[1] || '';
    const final = /FINAL=([0-9a-f]+)/.exec(out)?.[1] || '';
    const forkPoint = e.g(e.work, 'merge-base', 'HEAD', 'origin/develop').stdout.trim();

    expect(provisional, `no provisional baseline. out: ${out.slice(0, 300)}`).not.toBe('');
    expect(e.g(e.work, 'log', '-1', '--format=%s').stdout.trim(),
      'the branch was never reset — this proves nothing').not.toBe('prev leg: story complete');
    expect(final, 'the script did not rewrite the baseline after the reset').not.toBe(provisional);
    expect(final, 'the rewritten baseline is not the branch\'s true fork point').toBe(forkPoint);
  });
});
