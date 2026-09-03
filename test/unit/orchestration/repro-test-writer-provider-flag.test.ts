// THE WRITE-CAPABLE AGENT INVOCATION USED TO FORCE "openrouter" WHEN NO PROVIDER WAS DECLARED.
//
// TIER 2 in change-log/SEAM-CONSISTENCY-ANALYSIS.md: AI_RUNNER_CMD is ai-run.sh -> llm-handler.sh,
// which already re-derives PRIMARY_PROVIDER from the active set when no --provider flag is given
// — so the hardcoded literal was redundant, not unsafe on its own. Fixed to make the flag
// CONDITIONAL: passing --provider "" would be WORSE than omitting it, because llm-handler.sh's
// own arg parsing overwrites its already-correctly-resolved PRIMARY_PROVIDER with an explicit
// empty string (the same risk already found and fixed for run-agent-orchestration.sh's
// epam run --provider).
//
// Setup mirrors repro-test-writer-target-selection.test.ts's proven-working invocation
// (`bash WRITER <storyId>`, a real git repo, a real stub agent) rather than guessing a CLI shape.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const WRITER = join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (r: string, a: string[]) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' });

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'srw-flag-'));
  dirs.push(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/hello.ts'), 'export const x = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  git(repo, ['branch', 'develop']);
  writeFileSync(join(repo, 'src/hello.ts'), 'export const x = 2;\n');
  git(repo, ['commit', '-q', '-am', 'fix']);

  const prd = join(repo, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{
    id: 'S1', title: 't', verificationCriteria: ['vc'],
    fixSiteAnalysis: [{ file: 'src/hello.ts', function: 'f', reason: 'r', fix: 'x' }],
  }] }));
  return { repo, prd };
}

/** Records its real argv, so the test can see whether --provider was passed. */
function stubAgentRecordingArgv(repo: string) {
  const p = join(repo, 'stub.sh');
  writeFileSync(p, `#!/usr/bin/env bash
echo "ARGV: $*" >> "${repo}/.argv"
if [ -n "\${EPAM_ALLOWED_WRITE_PATHS:-}" ]; then
  t="\$PROJECT_ROOT/\$EPAM_ALLOWED_WRITE_PATHS"; mkdir -p "\$(dirname "\$t")"
  printf "import {it,expect} from 'vitest';\\nit('repro',()=>expect(1).toBe(1));\\n" > "\$t"
fi
`);
  chmodSync(p, 0o755);
  return p;
}

function run(env: Record<string, string>) {
  const { repo, prd } = makeRepo();
  const agent = stubAgentRecordingArgv(repo);
  try {
    execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} S1 2>&1`], {
      encoding: 'utf8',
      env: {
        ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(),
        PROJECT_ROOT: repo, PRD_FILE: prd, JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: agent, REPRO_TEST_WRITER_MAX_ATTEMPTS: '1',
        SPEC_MODE_PROVIDER: '', EPAM_ORCHESTRATION_PROVIDER: '',
        ...env,
      },
    });
  } catch { /* the writer's own exit status is not what this test checks */ }
  let argv = '';
  try { argv = require('node:fs').readFileSync(join(repo, '.argv'), 'utf8'); } catch { /* never invoked */ }
  return argv;
}

describe('brownfield-repro-test-writer.sh — the --provider flag on the write invocation', () => {
  it('is OMITTED when no provider is declared — never passed as ""', () => {
    const argv = run({});
    expect(argv, `agent was never invoked:\n${argv}`).toMatch(/ARGV:/);
    expect(argv).not.toMatch(/--provider/);
  });

  it('is INCLUDED with the real value when SPEC_MODE_PROVIDER is set', () => {
    const argv = run({ SPEC_MODE_PROVIDER: 'openrouter' });
    expect(argv, `agent was never invoked:\n${argv}`).toMatch(/--provider openrouter/);
  });
});
