/**
 * B15 — the repro-test-writer wrote its test to `package-lock.test.ts`.
 *
 * Caught by the mock1 re-run (2026-07-24 17:09), NOT by a metrolinx run:
 *
 *   [repro-test-writer] writing reproducing test for MOCK-HW-1 -> package-lock.test.ts
 *   [repro-test-writer] committed reproducing test: package-lock.test.ts
 *
 * `_primary_fix="${FIX_FILES[0]}"` takes the FIRST changed non-test file, and
 * FIX_FILES accepts anything that is not a test — including package-lock.json,
 * package.json, README.md, CI yaml. The target path is derived from it, so a lock
 * file leading the diff sends the test to a nonsense location. (The metrolinx story
 * one line earlier resolved correctly, so this only bites when a non-source file
 * happens to sort first.)
 *
 * The validation added earlier that day did NOT catch it: `package-lock.test.ts`
 * parses and runs, so "can this execute?" answered yes. It was never asked whether
 * the location made sense — validating that an artifact is RUNNABLE is not the same
 * as validating it is RIGHT.
 *
 * Authority order for the target: the detective's fixSiteAnalysis (it identified the
 * causal site), then a genuinely testable source file, and if neither exists there is
 * nothing sensible to test — skip rather than commit garbage.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRITER = join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (r: string, a: string[]) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' });

/** Repo whose fix commit touches `changed` (in that order). */
function makeRepo(changed: string[], opts: { fixSite?: string } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'tw-target-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'seed.spec.ts'), "import {it,expect} from 'vitest';\nit('x',()=>expect(1).toBe(1));\n");
  for (const f of changed) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), '{}\n');
  }
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-S1']);
  for (const f of changed) writeFileSync(join(repo, f), '{"changed":true}\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);

  const prd = join(repo, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{
    id: 'S1', title: 't', verificationCriteria: ['vc'],
    ...(opts.fixSite ? { fixSiteAnalysis: [{ file: opts.fixSite, function: 'f', reason: 'r', fix: 'x' }] } : {}),
  }] }));
  return { repo, prd };
}

/** Agent stub that records the target path it was scoped to. */
function stubAgent(repo: string) {
  const p = join(repo, 'stub.sh');
  writeFileSync(p, `#!/usr/bin/env bash
if [ -n "\${EPAM_ALLOWED_WRITE_PATHS:-}" ]; then
  echo "\$EPAM_ALLOWED_WRITE_PATHS" >> "$repo/.targets"
  t="\$PROJECT_ROOT/\$EPAM_ALLOWED_WRITE_PATHS"; mkdir -p "\$(dirname "\$t")"
  printf "import {it,expect} from 'vitest';\\nit('repro',()=>expect(1).toBe(1));\\n" > "\$t"
fi
`);
  chmodSync(p, 0o755);
  return p;
}

function run(changed: string[], opts: { fixSite?: string } = {}) {
  const { repo, prd } = makeRepo(changed, opts);
  const agent = stubAgent(repo);
  let out = '';
  try {
    out = execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} S1 2>&1`], {
      encoding: 'utf8',
      env: { ...process.env, PROJECT_ROOT: repo, PRD_FILE: prd, JIRA_BASELINE_BRANCH: 'develop',
             EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: agent, REPRO_TEST_WRITER_MAX_ATTEMPTS: '1' },
    });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }
  return { out, committed: git(repo, ['log', '--oneline', '--name-only', 'develop..HEAD']) };
}

describe('B15 — repro-test-writer target selection', () => {
  it('never targets a lockfile, even when it leads the diff', () => {
    const { out, committed } = run(['package-lock.json', 'src/hello.ts']);
    expect(out).not.toMatch(/package-lock\.test/);
    // NOT `not.toMatch(/package-lock/)`: the FIX commit legitimately touches
    // package-lock.json and is inside develop..HEAD. What must never exist is a
    // TEST file derived from it. (Third time today I scoped a git range wrongly —
    // the range includes commits this step is not responsible for.)
    expect(committed).not.toMatch(/package-lock\.(test|spec)\./);
  });

  it('picks the real source file when a lockfile sorts first', () => {
    const { out } = run(['package-lock.json', 'src/hello.ts']);
    expect(out).toMatch(/src\/hello\.(test|spec)\.ts/);
  });

  it('prefers the detective fix site over diff order', () => {
    const { out } = run(['src/aaa.ts', 'src/zzz.ts'], { fixSite: 'src/zzz.ts' });
    expect(out).toMatch(/src\/zzz\.(test|spec)\.ts/);
  });

  it('skips entirely when only non-source files changed (nothing sensible to test)', () => {
    const { out, committed } = run(['package-lock.json', 'README.md']);
    expect(committed).not.toMatch(/add bug-reproducing test/);
    expect(out).toMatch(/no (testable )?(source|fix) file|nothing to test/i);
  });

  it('never targets package.json, markdown or yaml', () => {
    for (const f of ['package.json', 'README.md', '.github/workflows/ci.yml']) {
      const { out } = run([f, 'src/hello.ts']);
      expect(out, `targeted ${f}`).not.toMatch(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\.\w+$/, '') + '\\.(test|spec)'));
    }
  });

  it('unchanged behaviour: a single source file is still chosen', () => {
    const { out } = run(['src/hello.ts']);
    expect(out).toMatch(/src\/hello\.(test|spec)\.ts/);
  });
});
