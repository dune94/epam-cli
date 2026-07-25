/**
 * The writer should be able to fix its own type errors — before burning attempts.
 *
 * The typecheck gate rejects a spec that runs but does not compile. Rejection alone
 * costs an attempt and tells the agent nothing: the retry re-runs the same prompt
 * and can make the same mistake, and with 3 attempts that is expensive.
 *
 * Two changes, deliberately belt-and-braces:
 *   1. The prompt INSTRUCTS the agent to typecheck before finishing. It already has
 *      bash (AI_GATE_ALLOW_TOOLS=1 + skip-approval), so it can actually do this.
 *   2. On a typecheck rejection, the next attempt receives the ACTUAL tsc errors.
 *
 * (2) is the one that matters, because an instruction can be ignored and a
 * deterministic feedback loop cannot. That has been the recurring lesson all day.
 *
 * IS THIS THE BANNED PROSE CHANNEL? No, and the distinction is worth stating
 * because it is easy to get wrong. What is banned is self-heal KB knowledge —
 * accumulated cross-run history injected as advice, silently trimmed, unverifiable.
 * This is the compiler's own output about the file THIS agent just wrote, in THIS
 * attempt: in-band, deterministic, tied to the exact action, and identical in kind
 * to the gate rejection returned as a tool result. Withholding it would make the
 * agent guess at an error the toolchain already knows exactly.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const WRITER = join(REPO, 'orchestrations/scripts/brownfield-repro-test-writer.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STORY = 'TCF-1';
const TARGET = 'src/discount.test.ts';   // the convention the writer derives for this repo

/** Writes a spec that RUNS but does not COMPILE — the live TS2352 shape. */
function makeStub(captureDir: string, repo: string) {
  const d = mkdtempSync(join(tmpdir(), 'tcf-stub-')); dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash
prompt="$(cat)"
n=$(( $(ls "${captureDir}" 2>/dev/null | grep -c '^prompt-') + 1 ))
printf '%s' "$prompt" > "${captureDir}/prompt-\${n}"
if printf '%s' "$prompt" | grep -qE 'FAILURE CLASS|PREVENT a repeated agent failure'; then
  echo '{"enforcement":{"kind":"param","name":"EPAM_MAX_ITERATIONS","value":"40"},"reason":"r"}'
  exit 0
fi
cat > "${repo}/${TARGET}" <<'SPEC'
import { describe, it, expect } from 'vitest';
interface OrderLineItem { id: string; product: string; quantity: number; }
describe('discount', () => {
  it('applies', () => {
    const item = { id: 'a', quantity: 1, prices: [{ quantity: 1, discounts: [] }] } as OrderLineItem;
    expect(item.id).toBe('a');
  });
});
SPEC
echo "wrote the test"
exit 0
`);
  chmodSync(p, 0o755);
  return p;
}

function run() {
  const repo = mkdtempSync(join(tmpdir(), 'tcf-repo-')); dirs.push(repo);
  const capture = mkdtempSync(join(tmpdir(), 'tcf-cap-')); dirs.push(capture);
  const logDir = mkdtempSync(join(tmpdir(), 'tcf-log-')); dirs.push(logDir);
  const kbRoot = mkdtempSync(join(tmpdir(), 'tcf-kb-')); dirs.push(kbRoot);

  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"t","private":true}');
  writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'ESNext',
      moduleResolution: 'node', skipLibCheck: true, types: [] },
    include: ['src/**/*.ts'],
  }));
  execFileSync('ln', ['-s', join(REPO, 'node_modules'), join(repo, 'node_modules')]);
  writeFileSync(join(repo, 'src', 'discount.ts'), 'export const apply = (n: number) => n;\n');
  git('init', '--quiet', '--initial-branch=develop');
  git('config', 'user.email', 't@t.com'); git('config', 'user.name', 'T');
  git('add', '-A'); git('commit', '-m', 'baseline', '--quiet');
  git('checkout', '-q', '-b', `AI-${STORY}`);
  writeFileSync(join(repo, 'src', 'discount.ts'), 'export const apply = (n: number) => n * 0.5;\n');
  git('add', '-A'); git('commit', '-m', 'fix', '--quiet');

  const prd = join(logDir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: STORY, title: 'discount',
    technicalNotes: { files: ['src/discount.ts'] } }] }));

  try {
    execFileSync('bash', [WRITER, STORY], {
      encoding: 'utf8', timeout: 180000,
      env: { ...process.env, EPAM_BROWNFIELD: '1', PROJECT_ROOT: repo, PRD_FILE: prd,
             LOG_DIR: logDir, JIRA_BASELINE_BRANCH: 'develop', KB_ROOT: kbRoot,
             NODE_BIN: NODE20, AI_RUNNER_CMD: makeStub(capture, repo),
             STORY_ROLE: 'repro-test-writer' },
    });
  } catch { /* the writer is expected to end blocked — we assert on prompts */ }

  const prompts = readdirSync(capture).filter(f => f.startsWith('prompt-')).sort()
    .map(f => readFileSync(join(capture, f), 'utf8'))
    .filter(p => !/FAILURE CLASS|PREVENT a repeated agent failure/.test(p));
  return { prompts, repo };
}

describe('the writer can fix its own type errors', () => {
  const r = run();

  it('is told to typecheck before finishing', () => {
    expect(r.prompts.length, 'no writer prompt captured').toBeGreaterThan(0);
    expect(r.prompts[0],
      'the agent has bash but is never asked to verify its own output compiles')
      .toMatch(/tsc|typecheck|type-check/i);
  });

  it('receives the ACTUAL compiler errors on the retry', () => {
    expect(r.prompts.length, 'no retry happened — cannot check feedback').toBeGreaterThan(1);
    const retry = r.prompts[1];
    expect(retry,
      'the retry repeats the same prompt with no compiler feedback, so the agent ' +
      'can make the identical mistake and burn another attempt')
      .toMatch(/TS2352|error TS\d{4}/);
    expect(retry, 'the failing file is not named in the feedback').toMatch(/discount\.test\.ts/);
  });
});
