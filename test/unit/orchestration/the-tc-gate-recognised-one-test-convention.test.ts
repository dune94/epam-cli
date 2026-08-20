// THE TC WRITER GATE ASKED "IS EVERY FILE .test.ts?" AND ANSWERED "NOTHING TO DO" EVERYWHERE ELSE.
//
// lib/tc-writer-gate.sh selected the stories needing test criteria with an inline jq:
//
//     ($f | map(endswith(".test.ts")) | all)
//
// On a codeline using .spec.ts, test_*.py, __tests__/ or _test.go, that predicate is false for
// every story, `_needs_tc` comes back empty, and the gate returns 0 — reporting that all test
// stories already have criteria, having examined none.
//
// THIS IS THE THIRD COPY OF THE SAME FILTER. Step 10's caller in run-agent-orchestration.sh had it
// and was fixed (its comment records the same finding: "the handler finds 2, this jq found 0").
// tc-story-context.py and tc-stories-needing-criteria.py had it and were fixed. This one was
// missed, so the defect survived in the gate the fixed caller invokes.
//
// THE CONVENTION IS SHARED; THE POLICY IS NOT. _testfile.py is the one definition of "what is a
// test file" — .spec., .test., _spec., _test., test_*, __tests__/ — and the gate now asks it via
// lib/handlers/tc-story-is-pure-test.py.
//
// What does NOT change is the `all`: this gate runs BEFORE execution, and requiring every file to
// be a test file is what stops a combo story (implementation + tests together) being force-gated —
// the SKY-004 finding. tc-stories-needing-criteria.py uses `any(...) or has_vcs` because it answers
// a different question after execution. Substituting one for the other, as a first attempt at this
// fix did, silently swapped the contract and turned three existing tests red.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const GATE = join(ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A PRD with one test story, in whatever convention the codeline uses, and no criteria yet. */
function prdWith(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'tcgate-')); made.push(d);
  const p = join(d, 'prd.json');
  writeFileSync(p, JSON.stringify({
    implementationOrder: { core: ['S-1'] },
    stories: [{
      id: 'S-1',
      status: 'active',
      agentRole: 'test-engineer-x',
      technicalNotes: { files },
      testCriteria: { facts: [] },
    }],
  }));
  return p;
}

/**
 * Ask the GATE ITSELF which stories it thinks need criteria.
 *
 * Sourced and called for real — not a reimplementation of its jq here, which would test this file
 * against itself and pass no matter what the gate does.
 */
function gateSelects(prd: string): { out: string; status: number } {
  const r = spawnSync('bash', ['-c',
    `set -uo pipefail
     SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
     PRD_FILE=${JSON.stringify(prd)}
     LOG_DIR=$(mktemp -d)
     source ${JSON.stringify(GATE)}
     _tc_story_needs_criteria S-1 && echo NEEDS || echo SKIPPED`,
  ], { encoding: 'utf8' });
  return { out: ((r.stdout || '') + (r.stderr || '')).trim(), status: r.status ?? -1 };
}

describe('the gate recognises the codeline\'s own test convention', () => {
  it('.test.ts — the one it always handled', () => {
    expect(gateSelects(prdWith(['src/a.test.ts'])).out).toMatch(/NEEDS/);
  });

  it('.spec.ts — Angular, and this repo\'s own metrolinx codeline', () => {
    expect(gateSelects(prdWith(['src/a.spec.ts'])).out,
      'a .spec.ts test story was reported as needing nothing').toMatch(/NEEDS/);
  });

  it('test_*.py — Python', () => {
    expect(gateSelects(prdWith(['tests/test_a.py'])).out).toMatch(/NEEDS/);
  });

  it('_test.go — Go', () => {
    expect(gateSelects(prdWith(['pkg/a_test.go'])).out).toMatch(/NEEDS/);
  });

  it('__tests__/ — the directory convention', () => {
    expect(gateSelects(prdWith(['src/__tests__/a.ts'])).out).toMatch(/NEEDS/);
  });
});

describe('and still says no when it should', () => {
  it('a story of ordinary source files needs no test criteria', () => {
    expect(gateSelects(prdWith(['src/a.ts', 'src/b.ts'])).out).toMatch(/SKIPPED/);
  });

  it('a story that already HAS criteria is not selected again', () => {
    const d = mkdtempSync(join(tmpdir(), 'tcgate-has-')); made.push(d);
    const p = join(d, 'prd.json');
    writeFileSync(p, JSON.stringify({
      implementationOrder: { core: ['S-1'] },
      stories: [{
        id: 'S-1', status: 'active', agentRole: 'test-engineer-x',
        technicalNotes: { files: ['src/a.spec.ts'] },
        testCriteria: { facts: [{ text: 'already written' }] },
      }],
    }));
    expect(gateSelects(p).out).toMatch(/SKIPPED/);
  });
});

describe('one definition, not a fourth copy', () => {
  it('the gate no longer carries its own test-file predicate', () => {
    // Paired with the behavioural tests above: those prove it works, this proves it works by
    // asking the shared handler rather than by growing a wider literal of its own.
    const src = readFileSync(GATE, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src, 'the inline .test.ts filter is still there').not.toMatch(/endswith\("\.test\.ts"\)/);
  });

  it('and asks a handler that shares the _testfile.py conventions', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).toMatch(/tc-story-is-pure-test\.py/);
  });
});
