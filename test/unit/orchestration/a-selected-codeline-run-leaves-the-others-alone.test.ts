/**
 * RUNNING ONE CODELINE MUST NOT DESTROY ANOTHER CODELINE'S FINISHED WORK.
 *
 * A story spanning three repositories currently runs all three in one launch. Scoping a launch to
 * one codeline gives a natural pause between them: a failure blasts one lane instead of three,
 * each pause is an inspection point, and spend is bounded per launch.
 *
 * Two seams must honour the selection, and the SECOND is the dangerous one.
 *
 *  1. The lane list, built once from project.outputDirs. Every downstream path — parallel,
 *     sequential, and the post-run merges — reads that one array, so filtering it there is
 *     sufficient for the run itself.
 *
 *  2. The pre-run reset, which sweeps EVERY repository under the codeline root:
 *
 *         for _cl_dir in "$JIRA_CODELINE_ROOT"/*\/; do
 *           bash brownfield-preflight-reset.sh "${_cl_dir%/}"
 *         done
 *
 *     and each reset is `git reset --hard <baseline>` + `clean -fd`. `reset --hard` moves the
 *     BRANCH POINTER, so it discards commits, not just working-tree edits. Without this filter,
 *     finishing gotransit and then launching metrolinx would silently destroy gotransit —
 *     committed work included — and the second run's log would look completely normal.
 *
 *     The sweep is deliberate today: codeline discovery picks its target dynamically, so every
 *     candidate must be clean beforehand. That reasoning does not hold when the operator names the
 *     codelines, because nothing is being discovered.
 *
 * NO HARDCODING. No codeline name, repository path or count appears here or in the implementation.
 * The selection is an operator-supplied list matched against whatever the PRD declares; an empty
 * or unset selection means "all", so today's behaviour is untouched when the feature is not used.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const TIER3 = join(ROOT, 'orchestrations/scripts/tier3-metrolinx-run.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * The lane-selection filter, lifted from run-agent-orchestration.sh and run over a fixture list.
 * Executing the real code rather than matching source: a filter that is present but never applied
 * is exactly the defect class this repo keeps producing.
 */
function selectLanes(entries: string[], selection: string | undefined): string[] {
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('# CODELINE SELECTION');
  const end = src.indexOf('if [ ${#_cl_entries[@]} -eq 0 ]', start);
  if (start === -1 || end === -1) throw new Error('lane-selection anchors not found — extraction stale');
  const block = src.slice(start, end);

  // Wrapped in a function because the block declares `local` — it lives inside one in the real
  // script, and running it at top level fails on that alone rather than on its logic.
  const script = `
set -uo pipefail
${selection === undefined ? '' : `EPAM_ONLY_CODELINES=${JSON.stringify(selection)}`}
warning() { :; }
log() { :; }
error() { :; }
_select() {
  local _cl_entries=(${entries.map((e) => `'${e}'`).join(' ')})
${block}
  printf '%s\\n' "\${_cl_entries[@]:-}"
}
_select
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

const ENTRIES = ['gotransit:/repos/next.gotransit.com',
                 'upexpress:/repos/next.upexpress.com',
                 'metrolinx:/repos/next.metrolinx.com'];

describe('the extraction is live', () => {
  it('the selection block exists and is non-trivial', () => {
    expect(() => selectLanes(ENTRIES, undefined)).not.toThrow();
  });
});

describe('lane selection', () => {
  it('unset selection runs every codeline — today behaviour is untouched', () => {
    expect(selectLanes(ENTRIES, undefined)).toEqual(ENTRIES);
  });

  it('an empty selection also means all, not none', () => {
    // "" must not silently reduce a run to zero lanes and report success.
    expect(selectLanes(ENTRIES, '')).toEqual(ENTRIES);
  });

  it('a single codeline selects only that lane', () => {
    expect(selectLanes(ENTRIES, 'gotransit')).toEqual(['gotransit:/repos/next.gotransit.com']);
  });

  it('several codelines can be selected, and declared order is preserved', () => {
    // Order matters: merges run in declared order, and a reordered run is a different run.
    expect(selectLanes(ENTRIES, 'metrolinx|gotransit'))
      .toEqual(['gotransit:/repos/next.gotransit.com', 'metrolinx:/repos/next.metrolinx.com']);
  });

  it('a codeline the PRD does not declare selects nothing rather than everything', () => {
    // Failing OPEN here would run all three when the operator asked for one — the expensive
    // direction of a typo.
    expect(selectLanes(ENTRIES, 'not-a-codeline')).toEqual([]);
  });

  it('selection matches the codeline name, not a path substring', () => {
    expect(selectLanes(ENTRIES, 'next.gotransit.com')).toEqual([]);
  });
});

describe('THE DANGEROUS SEAM: the pre-run reset honours the same selection', () => {
  const tier3 = readFileSync(TIER3, 'utf8');

  it('the reset loop consults the selection', () => {
    const i = tier3.indexOf('Predictable teardown: resetting codelines');
    const loop = tier3.slice(i, i + 1200);
    expect(
      loop,
      'the reset sweeps every repo under the root with `git reset --hard` + `clean -fd`, which ' +
      'moves the branch pointer and discards COMMITS — running a second codeline would destroy ' +
      'the first one silently',
    ).toContain('EPAM_ONLY_CODELINES');
  });

  it('the reset skip is decided by codeline name, from the same variable as lane selection', () => {
    const i = tier3.indexOf('Predictable teardown: resetting codelines');
    const loop = tier3.slice(i, i + 3000);
    // One variable, two consumers. Two independent selection mechanisms would drift, and the
    // drift would only show as destroyed work.
    expect(loop).toMatch(/EPAM_ONLY_CODELINES/);
    expect(loop).toMatch(/continue/);
  });
});

describe('the reset skip actually skips — executed, not inspected', () => {
  /** Run the real reset loop against fixture repos, with a stubbed reset that just records. */
  function resetCalls(selection: string | undefined, repos: string[]): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'lanes-')); dirs.push(dir);
    const root = join(dir, 'root'); mkdirSync(root, { recursive: true });
    for (const r of repos) mkdirSync(join(root, r, '.git'), { recursive: true });
    const record = join(dir, 'called.txt'); writeFileSync(record, '');

    const tier3 = readFileSync(TIER3, 'utf8');
    const i = tier3.indexOf('for _cl_dir in "$JIRA_CODELINE_ROOT"');
    // Anchor on the loop's LAST line, not the first `done`: the body now contains a nested loop,
    // and stopping at the inner `done` truncated the script into a syntax error.
    const tail = tier3.indexOf('brownfield-preflight-reset.sh" "${_cl_dir%/}" || true', i);
    const j = tier3.indexOf('done', tail);
    if (i === -1 || tail === -1 || j === -1) throw new Error('reset loop anchors not found — extraction stale');
    const loop = tier3.slice(i, j + 4);

    const script = `
set -uo pipefail
JIRA_CODELINE_ROOT=${JSON.stringify(root)}
SCRIPT_DIR=${JSON.stringify(dir)}
${selection === undefined ? '' : `EPAM_ONLY_CODELINES=${JSON.stringify(selection)}`}
info() { :; }
log() { :; }
# Stand in for the real reset: record which repo it was asked to destroy.
cat > ${JSON.stringify(join(dir, 'brownfield-preflight-reset.sh'))} <<'STUB'
#!/usr/bin/env bash
basename "$1" >> "$RECORD"
STUB
chmod +x ${JSON.stringify(join(dir, 'brownfield-preflight-reset.sh'))}
export RECORD=${JSON.stringify(record)}
${loop}
`;
    execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    return readFileSync(record, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).sort();
  }

  const REPOS = ['next.gotransit.com', 'next.metrolinx.com', 'next.upexpress.com', 'some.other.repo'];

  it('with no selection every repo is reset, as today', () => {
    expect(resetCalls(undefined, REPOS)).toEqual([...REPOS].sort());
  });

  it('with a selection, an UNSELECTED codeline is never reset', () => {
    const called = resetCalls('gotransit', REPOS);
    expect(
      called.some((c) => c.includes('metrolinx')),
      'metrolinx was hard-reset during a gotransit-only run — this is how finished work, ' +
      'commits included, disappears between runs',
    ).toBe(false);
    expect(called.some((c) => c.includes('upexpress'))).toBe(false);
  });

  it('the SELECTED codeline is still reset — the run must start from a known state', () => {
    // Skipping the selected one would trade lost work for an unpredictable starting point.
    expect(resetCalls('gotransit', REPOS).some((c) => c.includes('gotransit'))).toBe(true);
  });
});

describe('no hardcoding entered the engine', () => {
  it('neither seam names a codeline or repository', () => {
    for (const f of [ORCH, TIER3]) {
      const code = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      const i = code.indexOf('EPAM_ONLY_CODELINES');
      if (i === -1) continue;
      const near = code.slice(Math.max(0, i - 400), i + 800);
      for (const banned of ['gotransit', 'upexpress', 'metrolinx']) {
        expect(near, `'${banned}' is hardcoded near the selection logic`).not.toContain(banned);
      }
    }
    expect(existsSync(ORCH)).toBe(true);
  });
});
