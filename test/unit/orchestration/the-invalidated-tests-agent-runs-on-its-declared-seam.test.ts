/**
 * THE INVALIDATED-TESTS AGENT RUNS ON ITS DECLARED SEAM.
 *
 * AMSD-2974 live, 2026-10-03: the script declares its seam once (_SEAM_NAME="repro-test-writer", as the
 * template's `seams` does) and then invoked the runner with EPAM_AGENT_NAME="update-invalidated-tests" —
 * a name no profile, cross-reference or seamPattern resolves. llm-handler refused the call, the suite
 * was stamped red, and Step 3.55 blocked the phase over a fix whose repro test had passed.
 *
 * EXECUTED: the real update-invalidated-tests.sh on a git fixture whose suite is red, with a stub runner
 * that records the agent name it was invoked under. That name is then resolved by the real resolver
 * against the shipped registry — the same call llm-handler makes — and must land on the template's seam.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const SCRIPT = join(ORCH, 'scripts/update-invalidated-tests.sh');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam, registryPath } = require(join(ORCH, 'scripts/lib/seam-invocation.js'));
const TEMPLATE = JSON.parse(readFileSync(join(ORCH, 'prompts/templates/update-invalidated-tests.json'), 'utf8'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

/** A fix has landed and a pre-existing test now fails — the state in which the agent is called. */
function redRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'uit-seam-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello world';\n");
  writeFileSync(join(repo, 'suite.js'),
    "const s=require('fs').readFileSync('src/hello.ts','utf8'); if(!s.includes('hello world')){console.log(' FAIL src/hello.test.ts');process.exit(1)} console.log('ok');\n");
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-MOCK-1']);
  writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello dolly';\n");
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({ test: { command: 'node suite.js' } }));
  return repo;
}

describe('the invalidated-tests agent runs on its declared seam', () => {
  it('the agent name the runner receives resolves, through the real registry, to the template\'s seam', () => {
    const repo = redRepo();
    const seen = join(repo, 'agent-name.txt');
    const stub = join(repo, 'stub-runner.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' "$EPAM_AGENT_NAME" > ${JSON.stringify(seen)}\necho "REGRESSION: not explained"\n`);
    chmodSync(stub, 0o755);
    let out = '';
    try {
      out = execFileSync('bash', ['-c', `bash ${JSON.stringify(SCRIPT)} MOCK-1 2>&1`], {
        encoding: 'utf8',
        env: { ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop', EPAM_BROWNFIELD: '1',
          AI_RUNNER_CMD: stub, STORY_VERIFICATION_CRITERIA: 'The greeting reads "hello dolly".',
          NODE_BIN: process.execPath },
      });
    } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }

    // Not vacuous: the suite was red and the agent was actually invoked.
    expect(out, 'the suite never went red, so the agent was never called').toMatch(/suite is RED/);
    expect(existsSync(seen), `the runner was never invoked:\n${out}`).toBe(true);
    const name = readFileSync(seen, 'utf8');
    expect(name, 'the runner was invoked with no agent name').not.toBe('');

    let seam: unknown;
    expect(() => { seam = resolveSeam(name, registryPath(join(ORCH, 'agents'))); },
      `llm-handler would refuse "${name}"`).not.toThrow();
    expect(TEMPLATE.seams, 'the template declares no seam to compare with').toHaveLength(1);
    expect(seam).toBe(TEMPLATE.seams[0]);
  });
});
