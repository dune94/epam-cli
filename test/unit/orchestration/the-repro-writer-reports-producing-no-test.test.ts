/**
 * STEP 3.54 WRITES THE TEST THAT STEP 3.55 THEN EXECUTES. IF IT PRODUCES NOTHING, THAT HAS TO BE
 * VISIBLE — AND IT WAS INVISIBLE TWICE OVER.
 *
 * The writer ended in an unconditional `exit 0`, so its "no test file produced" branch logged an
 * error and then reported success. The caller piped it into `tee`, which returns tee's status —
 * always 0 — so even a real exit code would have been discarded. Step 3.55 then blocked the story
 * for shipping no reproducing test, which sends the investigation at the story rather than at the
 * writer that never produced one.
 *
 * The prompt was split across two places for no reason: the ROLE sentence came from
 * templates/repro-role.json while the sentence that actually decides whether the test is
 * acceptable — "it must FAIL against the pre-fix code and PASS with the fix" — was a shell literal
 * in the writer. They vary on exactly the same condition, so they now live in the same file.
 *
 * And the baseline branch defaulted to the literal "develop". Every diff the writer takes is
 * against that ref, so on a project whose trunk is named anything else it resolved nothing and the
 * writer compared against an empty baseline.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const WRITER = join(SCRIPTS, 'brownfield-repro-test-writer.sh');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const ENGINE = join(SCRIPTS, 'lib/engine-prompt.js');

const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** Render one body of repro-role exactly as the writer does. */
function render(bodyKey: string): string {
  const r = spawnSync(process.execPath, ['-e',
    'const {renderEngineTemplate}=require(process.argv[1]);'
    + 'process.stdout.write(renderEngineTemplate("repro-role",{},process.argv[2]));',
    ENGINE, bodyKey,
  ], { encoding: 'utf8' });
  expect(r.status, `repro-role/${bodyKey} did not render: ${r.stderr}`).toBe(0);
  return r.stdout;
}

describe('the repro writer reports producing no test', () => {
  it('does not end in an unconditional exit 0', () => {
    const body = code(WRITER);
    expect(body, 'the writer still reports success whatever happened').not.toMatch(/\nexit 0\s*$/);
    expect(body, 'the exit status no longer reflects whether a test was produced')
      .toMatch(/exit "\$_tw_exit"/);
  });

  it('the "no test produced" branch sets a failing status', () => {
    const src = readFileSync(WRITER, 'utf8');
    const i = src.indexOf('no test file produced at');
    expect(i, 'the no-test branch is gone').toBeGreaterThan(-1);
    expect(src.slice(i, i + 400), 'producing no test still reports success').toMatch(/_tw_exit=1/);
  });

  it('the caller reads the writer’s status through the pipe, not tee’s', () => {
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('brownfield-repro-test-writer.sh" "$_tw_story"');
    expect(i, 'the 3.54 call site is gone').toBeGreaterThan(-1);
    const block = src.slice(i, i + 700);
    expect(block, 'the writer’s exit status is still discarded by tee').toMatch(/PIPESTATUS\[0\]/);
    expect(block, 'a failed writer produces no message').toMatch(/warning .*no test/i);
  });
});

describe('the repro writer takes all its prose from the template layer', () => {
  it('the proof requirement is no longer a literal in the script', () => {
    const body = code(WRITER);
    expect(body, 'the acceptance rule is still written in the shell script')
      .not.toContain('must FAIL against the pre-fix code');
    expect(body, 'the new-capability rule is still written in the shell script')
      .not.toContain('there is no pre-fix failure to reproduce');
  });

  it('both proof variants render, and they say opposite things about failing first', () => {
    // The distinction is the whole point: a defect's test must fail first, a novel story's must
    // not. Rendering both and asserting they differ catches a copy-paste that collapses them.
    const bug = render('proof_reproduces_fixed_bug');
    const novel = render('proof_proves_committed_change');
    expect(bug, 'the defect variant no longer requires a pre-fix failure').toMatch(/FAIL against the pre-fix/);
    expect(novel, 'the novel variant now demands a pre-fix failure that cannot exist')
      .not.toMatch(/FAIL against the pre-fix/);
    expect(bug).not.toBe(novel);
  });

  it('both diff headings render and are distinct', () => {
    const a = render('heading_reproduces_fixed_bug');
    const b = render('heading_proves_committed_change');
    expect(a.trim().length, 'the heading rendered empty').toBeGreaterThan(5);
    expect(a, 'a fix and a novel change are described identically').not.toBe(b);
  });
});

describe('the baseline branch is never guessed', () => {
  it('no branch name is written into the 3.54 call site', () => {
    const body = code(ORCH);
    const i = body.indexOf('_tw_baseline=');
    expect(i, 'the baseline resolution is gone').toBeGreaterThan(-1);
    expect(body.slice(i - 200, i + 900), 'a branch name is hardcoded again')
      .not.toMatch(/JIRA_BASELINE_BRANCH:-(develop|main|master)/);
  });

  it('a detached HEAD is not mistaken for a branch called HEAD', () => {
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('_tw_baseline=');
    expect(src.slice(i, i + 700)).toMatch(/_tw_baseline" = "HEAD" \]/);
  });

  it('an unresolvable baseline skips the writer rather than diffing against nothing', () => {
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('_tw_baseline=');
    const block = src.slice(i, i + 1100);
    expect(block, 'it still runs the writer with no baseline to diff against')
      .toMatch(/skipping the reproducing-test writer/);
  });
});
