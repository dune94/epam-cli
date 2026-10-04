/**
 * A PRE-EXISTING FAILURE IS SUBTRACTED WHEN THE INVALIDATED-TESTS AGENT REPORTS A REGRESSION.
 *
 * AMSD-2974 live, 2026-10-04: cx-shared's suite was red after the fix only because of DatePicker /
 * AdvancedDatePicker, which the baseline cache already listed. The invalidated-tests agent answered
 * REGRESSION ("unrelated pre-existing ... defect"); the step exited non-zero having printed only its
 * own messages. Step 3.545 then ran baseline_new_failures on the phase log the step's output is
 * tee'd into — which held no suite output on that path — so nothing was subtracted, suiteState=red
 * was recorded, Step 3.55 blocked, the retry blocked identically and the phase aborted.
 *
 * EXECUTED as run-agent-orchestration.sh Step 3.545 does it: the real update-invalidated-tests.sh
 * (stub agent answering REGRESSION) piped through `tee -a` into the phase log, then the real
 * baseline_new_failures on that log, against a baseline it builds itself from the fixture's baseline
 * commit with the project's declared suite.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const SCRIPTS = join(ORCH, 'scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

/**
 * A codeline whose suite reports one failure per line `FAIL <file>`: legacy.spec.js fails at the
 * baseline and after the fix (pre-existing); with `introduce`, the fix also breaks greeting.spec.js.
 */
function codeline(introduce: boolean) {
  const base = mkdtempSync(join(tmpdir(), 'uit-baseline-')); dirs.push(base);
  const repo = join(base, 'repo'); const logs = join(base, 'logs'); mkdirSync(logs);
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(base, ['init', '-q', '-b', 'develop', repo]);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'src', 'hello.js'), "module.exports = 'hello world';\n");
  writeFileSync(join(repo, 'suite.js'), [
    "const fs = require('fs'); let red = 0;",
    "console.log('FAIL src/legacy.spec.js'); red = 1;",
    "if (fs.readFileSync('src/hello.js', 'utf8').includes('BROKEN')) { console.log('FAIL src/greeting.spec.js'); }",
    "process.exit(red);",
  ].join('\n') + '\n');
  writeFileSync(join(repo, 'src', 'greeting.spec.js'), '// asserts the greeting\n');
  writeFileSync(join(repo, 'src', 'legacy.spec.js'), '// fails on the baseline already\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  const baselineSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'AI-MOCK-1']);
  writeFileSync(join(repo, 'src', 'hello.js'), introduce ? "module.exports = 'BROKEN';\n" : "module.exports = 'hello dolly';\n");
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);
  // The project's declaration, as provisioning writes it: the suite and how a failure reads.
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({ test: { command: 'node suite.js', failurePattern: '^FAIL\\s+(\\S+)' } }));
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), baselineSha + '\n');
  return { repo, logs };
}

/** Step 3.545 as the orchestrator runs it, then the subtraction. */
function step3545(repo: string, logs: string) {
  const stub = join(logs, 'stub-agent.sh');
  writeFileSync(stub, '#!/usr/bin/env bash\necho "REGRESSION: the failing suite is unrelated to the fix — a pre-existing defect"\n');
  chmodSync(stub, 0o755);
  const phaseLog = join(logs, 'update-invalidated-tests-core.log');
  const env = { ...process.env, PROJECT_ROOT: repo, LOG_DIR: logs, JIRA_BASELINE_BRANCH: 'develop', EPAM_BROWNFIELD: '1',
    AI_RUNNER_CMD: stub, STORY_VERIFICATION_CRITERIA: 'The greeting reads "hello dolly".', NODE_BIN: process.execPath,
    AUTOMATION_DIR: ORCH };
  const step = spawnSync('bash', ['-c', `bash ${JSON.stringify(join(SCRIPTS, 'update-invalidated-tests.sh'))} MOCK-1 2>&1 | tee -a ${JSON.stringify(phaseLog)}; exit \${PIPESTATUS[0]}`],
    { encoding: 'utf8', env });
  const sub = spawnSync('bash', ['-c', `
log(){ :; }; warning(){ :; }; info(){ :; }; error(){ :; }
source ${JSON.stringify(join(SCRIPTS, 'lib/tsc-baseline-gate.sh'))}
baseline_new_failures ${JSON.stringify(repo)} ${JSON.stringify(process.execPath)} ${JSON.stringify(logs)} test ${JSON.stringify(phaseLog)}`],
    { encoding: 'utf8', env });
  return { step, sub, phaseLog: readFileSync(phaseLog, 'utf8') };
}

describe('a pre-existing failure is subtracted when the invalidated-tests agent reports a regression', () => {
  it('the suite is red only with a failure the baseline already had — no new failure', () => {
    const { repo, logs } = codeline(false);
    const { step, sub } = step3545(repo, logs);
    // Not vacuous: the step took the REGRESSION path and failed, as live.
    expect(step.stdout, 'the step never reached the agent').toMatch(/REGRESSION/);
    expect(step.status, 'the step did not report the suite as unreconciled').not.toBe(0);
    expect(sub.status, `a pre-existing failure was charged to the fix:\n${sub.stdout}${sub.stderr}`).toBe(0);
  });

  it('a failure the fix introduced is still new', () => {
    const { repo, logs } = codeline(true);
    const { step, sub } = step3545(repo, logs);
    expect(step.status).not.toBe(0);
    expect(sub.status, 'a failure the fix introduced was subtracted').not.toBe(0);
    expect(sub.stdout + sub.stderr).toMatch(/greeting\.spec\.js/);
  });
});
