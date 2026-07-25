/**
 * INDUCED FAILURE — proof the self-heal loop closes in the REAL retry path.
 *
 * Every other test covers one link. This drives the actual
 * brownfield-repro-test-writer.sh retry loop against an agent that genuinely
 * fails, and asserts the whole chain end to end:
 *
 *   agent fails -> analyst records an EPISODE
 *               -> synthesis produces a validated CONSTRAINT
 *               -> kb_apply_constraints compiles it onto the shell
 *               -> the NEXT attempt is invoked WITH that enforcement
 *               -> and with NO self-heal prose in its prompt
 *
 * The decisive assertion is the last two: it is easy to build a KB that records
 * and synthesises beautifully and never actually changes what the agent is given.
 * That is the failure mode this session kept finding — every layer reporting
 * success while the mechanism does nothing. So the stub runner captures the ENV
 * and PROMPT of each invocation, and the test reads attempt 2's directly.
 *
 * Both attempts are allowed to fail. Success of the writer is irrelevant here;
 * what matters is what attempt 2 was handed. That also keeps the fixture free of
 * a real vitest/tsc validation cycle.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const WRITER = join(SCRIPTS, 'brownfield-repro-test-writer.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STORY = 'IND-1';
const MAX_ITER = '40';

/**
 * One stub serves all three callers. It routes on prompt content and records
 * every invocation's env + prompt so the test can inspect what attempt 2 got.
 */
function makeStub(captureDir: string) {
  const d = mkdtempSync(join(tmpdir(), 'ind-stub-')); dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash
prompt="$(cat)"
n=$(( $(ls "${captureDir}" 2>/dev/null | grep -c '^env-' ) + 1 ))
printenv > "${captureDir}/env-\${n}"
printf '%s' "$prompt" > "${captureDir}/prompt-\${n}"

if printf '%s' "$prompt" | grep -q 'PREVENT a repeated agent failure'; then
  # synthesis: propose a real, schema-valid constraint
  cat <<'J'
{"enforcement":{"kind":"param","name":"EPAM_MAX_ITERATIONS","value":"${MAX_ITER}"},"reason":"agent never wrote the file"}
J
  exit 0
fi
if printf '%s' "$prompt" | grep -q 'FAILURE CLASS'; then
  echo "Write the file as your first action."   # analyst diagnosis
  exit 0
fi
# the writer agent itself: FAIL — write no file. The output carries a real tsc
# error so the failure has a DERIVABLE SIGNATURE; without one the episode is
# unkeyed and synthesis correctly refuses to build a rule it could never look up.
echo "src/discount.ts(1,14): error TS2532: Object is possibly 'undefined'."
echo "I explored the repository but did not write anything."
exit 0
`);
  chmodSync(p, 0o755);
  return p;
}

function sandboxRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ind-repo-')); dirs.push(root);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=develop');
  git('config', 'user.email', 't@t.com');
  git('config', 'user.name', 'T');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'discount.ts'), 'export const apply = (n: number) => n;\n');
  git('add', '-A'); git('commit', '-m', 'baseline', '--quiet');
  // The fix must live on a BRANCH off the baseline, or `git diff develop..HEAD`
  // is empty and the writer exits with "no fix files in the diff".
  git('checkout', '-q', '-b', `AI-${STORY}`);
  writeFileSync(join(root, 'src', 'discount.ts'), 'export const apply = (n: number) => n * 0.5;\n');
  git('add', '-A'); git('commit', '-m', 'fix', '--quiet');
  return root;
}

function runInducedFailure() {
  const kbRoot = mkdtempSync(join(tmpdir(), 'ind-kb-')); dirs.push(kbRoot);
  const capture = mkdtempSync(join(tmpdir(), 'ind-cap-')); dirs.push(capture);
  const logDir = mkdtempSync(join(tmpdir(), 'ind-logs-')); dirs.push(logDir);
  const repo = sandboxRepo();

  const prd = join(logDir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{
    id: STORY, title: 'discount not applied on return legs',
    technicalNotes: { files: ['src/discount.ts'] },
  }] }));

  let out = '';
  try {
    out = execFileSync('bash', [WRITER, STORY], {
      encoding: 'utf8', timeout: 120000,
      env: {
        ...process.env,
        EPAM_BROWNFIELD: '1',
        PROJECT_ROOT: repo,
        PRD_FILE: prd,
        LOG_DIR: logDir,
        JIRA_BASELINE_BRANCH: 'develop',
        KB_ROOT: kbRoot,
        NODE_BIN: NODE20,
        AI_RUNNER_CMD: makeStub(capture),
        STORY_ROLE: 'repro-test-writer',
      },
    });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }

  const readJsonl = (f: string) => existsSync(join(kbRoot, f))
    ? readFileSync(join(kbRoot, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const constraintsFile = join(kbRoot, 'constraints.json');

  const envs = readdirSync(capture).filter(f => f.startsWith('env-')).sort()
    .map(f => readFileSync(join(capture, f), 'utf8'));
  const prompts = readdirSync(capture).filter(f => f.startsWith('prompt-')).sort()
    .map(f => readFileSync(join(capture, f), 'utf8'));

  return {
    out, kbRoot, envs, prompts,
    episodes: readJsonl('healing-events.jsonl'),
    quarantine: readJsonl('unmapped-rules.jsonl'),
    constraints: existsSync(constraintsFile) ? JSON.parse(readFileSync(constraintsFile, 'utf8')) : [],
  };
}

describe('induced failure — the self-heal loop closes in the real retry path', () => {
  const r = runInducedFailure();

  it('the writer agent was actually invoked more than once (a retry happened)', () => {
    // Writer invocations are the ones that are neither analyst nor synthesis.
    const writerCalls = r.prompts.filter(p =>
      !/FAILURE CLASS/.test(p) && !/PREVENT a repeated agent failure/.test(p));
    expect(writerCalls.length, `fixture did not retry; captured ${r.prompts.length} prompts`)
      .toBeGreaterThan(1);
  });

  it('records an episode from the real failure', () => {
    expect(r.episodes.length, 'no episode — the diagnosis died with the attempt').toBeGreaterThan(0);
  });

  it('synthesises an enforceable constraint from that single failure', () => {
    expect(r.constraints.length,
      `no constraint built. quarantine: ${JSON.stringify(r.quarantine.map(q => q.outcome))}`)
      .toBeGreaterThan(0);
    expect(r.constraints[0].enforcement.kind).toBe('param');
    expect(r.constraints[0].enforcement.value).toBe(MAX_ITER);
  });

  it('THE PROOF: the retry is invoked WITH the enforcement applied', () => {
    const writerEnvs = r.envs.filter((_, i) =>
      !/FAILURE CLASS/.test(r.prompts[i] || '') &&
      !/PREVENT a repeated agent failure/.test(r.prompts[i] || ''));
    const retryEnv = writerEnvs[writerEnvs.length - 1] || '';
    expect(retryEnv.length, 'no env captured — the assertion below would be vacuous')
      .toBeGreaterThan(100);
    expect(retryEnv,
      'the constraint was stored but never reached the agent — every layer reports ' +
      'success while the mechanism does nothing')
      .toMatch(new RegExp(`EPAM_MAX_ITERATIONS=${MAX_ITER}`));
  });

  it('and with NO self-heal prose in its prompt', () => {
    const writerPrompts = r.prompts.filter(p =>
      !/FAILURE CLASS/.test(p) && !/PREVENT a repeated agent failure/.test(p));
    for (const p of writerPrompts) {
      expect(p, 'self-heal prose reached the prompt — the banned channel is open')
        .not.toMatch(/CORRECTIVE GUIDANCE FROM SELF-HEAL/);
    }
  });
});
