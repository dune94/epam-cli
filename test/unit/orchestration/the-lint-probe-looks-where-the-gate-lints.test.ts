/**
 * STEP 3.8 DECIDED WHETHER TO RUN ESLINT BY ASKING A NARROWER QUESTION THAN THE GATE ITSELF ASKS.
 *
 * eslint_baseline_gate is handed $PROJECT_ROOT — the whole repository. But the probe that decides
 * whether to call it searched only `$PROJECT_ROOT/src`. So a repository laying its code out any
 * other way (lib/, app/, packages/, or flat at the root) found no probe file, took the "nothing to
 * lint" branch, and eslint was SKIPPED on a codebase it would have linted perfectly well — while
 * the log said "no lintable source files", which reads like a fact about the repository rather
 * than a fact about where the probe looked.
 *
 * The probe exists for a real reason (ESLint 6.x cannot load .cjs/.mjs configs even when the file
 * is present, so file-existence checks are insufficient and --print-config is used as a dry run).
 * That reason is unaffected by WHERE it looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const src = () => readFileSync(ORCH, 'utf8');
const code = () => src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'lint-probe-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** Run the probe loop exactly as the step runs it. */
function probe(repo: string): string {
  const body = src();
  const i = body.indexOf('_probe_file="$(find');
  expect(i, 'the eslint probe is gone — this test is measuring nothing').toBeGreaterThan(-1);
  const findCmd = body.slice(i, body.indexOf('\n', body.indexOf('-print -quit', i)));

  const r = spawnSync('bash', ['-c',
    `PROJECT_ROOT=${JSON.stringify(repo)}
     for _ext in js jsx mjs cjs ts tsx mts cts vue svelte; do
       ${findCmd}
       [ -n "$_probe_file" ] && break
     done
     printf '%s' "$_probe_file"`,
  ], { encoding: 'utf8' });
  return r.stdout.trim();
}

function repo(layout: Record<string, string>): string {
  const dir = join(work, 'repo');
  for (const [f, c] of Object.entries(layout)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return dir;
}

describe('the lint probe looks where the gate lints', () => {
  it('finds source that lives outside src/', () => {
    // The defect, in the layouts that actually hit it.
    for (const path of ['lib/a.ts', 'app/main.js', 'packages/core/index.tsx', 'index.mjs']) {
      expect(probe(repo({ [path]: 'x\n' })), `${path} would not have been linted`).toContain(path);
      rmSync(join(work, 'repo'), { recursive: true, force: true });
    }
  });

  it('still finds source under src/', () => {
    expect(probe(repo({ 'src/a.ts': 'x\n' })), 'the common layout regressed').toContain('src/a.ts');
  });

  it('does not probe vendored dependencies', () => {
    // Probing node_modules would make eslint run against a repo with no source of its own, and
    // --print-config would be answered by somebody else's config.
    const dir = repo({ 'node_modules/dep/i.js': 'x\n', 'README.md': '# r\n' });
    expect(probe(dir), 'the probe matched a vendored file').toBe('');
  });

  it('does not probe inside .git', () => {
    expect(probe(repo({ '.git/hooks/sample.js': 'x\n' })), 'the probe matched a git internal').toBe('');
  });

  it('a repository with genuinely no lintable source still probes empty', () => {
    // The skip branch must survive: reporting FAIL here would push an empty finding into
    // remediation, which can only answer "could not map lint output to a file".
    expect(probe(repo({ 'README.md': '# r\n', 'data.csv': 'a,b\n' }))).toBe('');
  });

  it('the skip message no longer blames src/ for where the probe looked', () => {
    const body = code();
    expect(body, 'the message still describes the probe’s old scope as the repository’s')
      .not.toContain('no lintable source files under src/');
  });

  it('the probe and the gate now share a scope', () => {
    const body = code();
    const probeAt = body.indexOf('_probe_file="$(find');
    const gateAt = body.indexOf('eslint_baseline_gate "$PROJECT_ROOT"');
    expect(gateAt, 'the eslint gate is gone').toBeGreaterThan(-1);
    expect(body.slice(probeAt, probeAt + 300), 'the probe still searches a subdirectory of the repo')
      .not.toMatch(/\$PROJECT_ROOT\/src/);
  });
});
