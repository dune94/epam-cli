/**
 * record_story_outputs() — the story loop tells the gates what it produced.
 *
 * Step 20 used to rediscover its own scope by linting the whole tree, which is
 * why it failed on files no agent touched. The gate should be HANDED the
 * writers' outputs. Nothing recorded them: verify_story_deliverables computed
 * exactly this set (claude.sh, the zero-declared-files fallback) and threw it
 * away, and technicalNotes.files is not a substitute — on the live metrolinx
 * PRD shape it is empty, which is the whole reason that fallback exists.
 *
 * So the producer is the story loop, the record is a per-phase manifest, and
 * the consumer is lib/eslint-baseline-gate.sh. Contract pinned here:
 * accumulates across stories, never lists pipeline noise as story output, and
 * stays silent-and-harmless where it has nothing true to say (greenfield),
 * because a manifest that lies is worse than one that is absent — the gate
 * treats absence as "fall back and say so", but treats presence as authority.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const m = defRe.exec(claudeSrc);
  if (!m) throw new Error(`No function definition found for ${name}()`);
  const start = m.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixture(opts: { baseline?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'story-outputs-'));
  cleanupDirs.push(root);
  const projectRoot = join(root, 'repo');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectRoot });
  writeFileSync(join(projectRoot, 'src/existing.ts'), 'export const a = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: projectRoot });

  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  if (opts.baseline !== false) {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(logDir, 'phase-baseline-sha.txt'), sha + '\n');
  }
  return { projectRoot, logDir };
}

function write(projectRoot: string, rel: string, content: string) {
  const abs = join(projectRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function record(fx: { projectRoot: string; logDir: string }, storyId: string) {
  const script = join(fx.logDir, `rec-${storyId}.sh`);
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      // record_story_outputs delegates to lib/story-outputs.sh — one
      // implementation, because the repro-test-writer is a second producer that
      // finishes later and a copy would drift. It resolves the lib from
      // SCRIPT_DIR, so the harness must supply it exactly as claude.sh does.
      `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
      `PROJECT_ROOT=${JSON.stringify(fx.projectRoot)}`,
      `LOG_DIR=${JSON.stringify(fx.logDir)}`,
      'PHASE=core',
      'JIRA_BASELINE_BRANCH=develop',
      'info()    { echo "INFO: $*"; }',
      'warning() { echo "WARNING: $*"; }',
      extractFunctionBody('record_story_outputs'),
      `record_story_outputs ${JSON.stringify(storyId)}`,
      'echo "RC=$?"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  const output = (r.stdout || '') + (r.stderr || '');
  const manifest = join(fx.logDir, 'story-outputs-core.txt');
  return {
    rc: (output.match(/RC=(\d+)/) || [])[1],
    output,
    lines: existsSync(manifest)
      ? readFileSync(manifest, 'utf8').split('\n').filter(Boolean)
      : null,
  };
}

describe('the manifest names what the writers produced', () => {
  it('records a modified file', () => {
    const fx = makeFixture();
    write(fx.projectRoot, 'src/existing.ts', 'export const a = 2;\n');
    expect(record(fx, 'S-1').lines).toEqual(['src/existing.ts']);
  });

  it('records a brand-new file the writer created but has not committed', () => {
    // The repro-test-writer commits separately from the impl agent; a manifest
    // that only sees committed work would hand the gate half the story.
    const fx = makeFixture();
    write(fx.projectRoot, 'src/new.spec.ts', 'describe();\n');
    expect(record(fx, 'S-1').lines,
      'untracked writer output is invisible to the gate').toEqual(['src/new.spec.ts']);
  });

  it('accumulates across stories without duplicating a shared file', () => {
    const fx = makeFixture();
    write(fx.projectRoot, 'src/existing.ts', 'export const a = 2;\n');
    record(fx, 'S-1');
    write(fx.projectRoot, 'src/other.ts', 'export const b = 1;\n');
    const { lines } = record(fx, 'S-2');

    expect(lines).toEqual(['src/existing.ts', 'src/other.ts']);
  });

  it('never lists pipeline noise as story output', () => {
    const fx = makeFixture();
    write(fx.projectRoot, '.codegraph/codegraph.db', 'index\n');
    write(fx.projectRoot, '.epam/dependency-check.json', '{}\n');
    write(fx.projectRoot, 'src/existing.ts', 'export const a = 2;\n');

    expect(record(fx, 'S-1').lines,
      'the CodeGraph index and .epam manifests were reported as writer output — ' +
      'the same incidental paths that once got committed as a story deliverable')
      .toEqual(['src/existing.ts']);
  });
});

describe('it says nothing rather than something false', () => {
  it('writes no manifest when there is no baseline to diff against', () => {
    // Greenfield. The gate reads an absent manifest as "fall back, and say so";
    // it reads a present one as authoritative. An empty file would mean
    // "the writers produced nothing", silently disabling the gate.
    const fx = makeFixture({ baseline: false });
    write(fx.projectRoot, 'src/new.ts', 'export const a = 1;\n');
    const { lines, rc } = record(fx, 'S-1');

    expect(rc, 'a missing baseline was treated as a story failure').toBe('0');
    expect(lines, 'an empty manifest was written, which the gate would trust as "nothing produced"').toBeNull();
  });

  it('does not fail the story when the project is not a git repo at all', () => {
    const fx = makeFixture();
    rmSync(join(fx.projectRoot, '.git'), { recursive: true, force: true });
    expect(record(fx, 'S-1').rc).toBe('0');
  });
});
