/**
 * run_relative_import_check — when the broken import lives in a file the
 * current story does NOT own, it must never block the current story's turn
 * — whether or not an owning sibling story can be identified.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run):
 * SKY-003-test burned all 8 attempts (exhausting the full model-escalation
 * ladder, $0.28, 8.45 min) on the exact same diagnosis: "src/cli.ts: imports
 * './skyscanner/client.js' which does not exist." cli.ts belongs to
 * SKY-003-impl (a different, already-completed story) — scope-guard
 * correctly locks it read-only for SKY-003-test, so "fix the import path"
 * was structurally impossible for that story to do, guaranteeing every one
 * of the 8 attempts failed identically.
 *
 * UPDATED 2026-08-02 (found live, Writer Retest run): the FIRST fix here
 * only wrote a sibling-escalation file when an owning story could be
 * found — but even then, the function still fell through to `return 1`
 * regardless, so out-of-scope breakage blocked the current story either
 * way. A single-story PRD has no sibling to attribute an out-of-scope
 * import to at all, so a totally unrelated, pre-existing broken import
 * (nothing to do with the story) blocked a genuinely correct fix for 3
 * straight attempts. The escalation file is still written (real value,
 * resolve_escalation() still consumes it) when an owner can be found — but
 * it is now purely informational: out-of-scope findings NEVER block this
 * story's own turn, matching the pattern already proven in
 * run_named_import_check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('run_relative_import_check — sibling escalation wiring (static)', () => {
  const body = extractFunctionBody('run_relative_import_check');

  it('checks whether the current story owns the importer file', () => {
    expect(body).toMatch(/technicalNotes\.files \/\/ \[\]\) \| map\(\. == \$f or endswith/);
  });

  it('looks up an owning sibling story when the current story does not own the file', () => {
    expect(body).toMatch(/select\(\.id != \$self\)/);
  });

  it('writes to .epam/escalations/<story_id>.json — the same file resolve_escalation() reads', () => {
    expect(body).toMatch(/\.epam\/escalations\/\$\{story_id\}\.json/);
  });

  it('the escalation JSON has targetFile, diagnosis, and requiredFix — matching resolve_escalation()\'s expected schema', () => {
    expect(body).toMatch(/'\{targetFile: \$tf, diagnosis: \$diag, requiredFix: \$fix\}'/);
  });
});

describe('run_relative_import_check — REAL execution: sibling escalation', () => {
  function runCheck(opts: {
    files: Record<string, string>;
    storyId: string;
    prdStories: any[];
  }): { rc: number; output: string; escalation: any | null } {
    const dir = mkdtempSync(join(tmpdir(), 'rel-import-escalation-'));
    try {
      for (const [relPath, content] of Object.entries(opts.files)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }, null, 2));

      const fnBody = extractFunctionBody('run_relative_import_check');
      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(
        scriptPath,
        [
          'VERIFICATION_FAILURE=""',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          'log() { echo "LOG: $*" >&2; }',
          'warning() { echo "WARN: $*" >&2; }',
          fnBody,
          `run_relative_import_check ${JSON.stringify(dir)} ${JSON.stringify(outLog)} ${JSON.stringify(opts.storyId)}`,
          'echo "RC=$?"',
        ].join('\n'),
      );
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      const output = (result.stdout || '') + (result.stderr || '');
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      let escalation: any = null;
      try {
        escalation = JSON.parse(readFileSync(join(dir, '.epam/escalations', `${opts.storyId}.json`), 'utf8'));
      } catch {
        /* no escalation written */
      }
      return { rc, output, escalation };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: a broken import in a SIBLING-owned file registers an escalation AND does not block this story', () => {
    const { rc, output, escalation } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      },
      storyId: 'SKY-003-test',
      prdStories: [
        { id: 'SKY-003-impl', status: 'completed', technicalNotes: { files: ['src/cli.ts'] } },
        { id: 'SKY-003-test', status: 'pending', technicalNotes: { files: ['src/cli.test.ts'] } },
      ],
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/outside this story's scope \(not blocking\)/);
    expect(escalation).not.toBeNull();
    expect(escalation.targetFile).toBe('src/cli.ts');
    expect(escalation.requiredFix).toContain("imports './skyscanner-client.js' which does not exist");
    expect(escalation.diagnosis).toContain('SKY-003-test');
  });

  it('still blocks (rc=1) and does NOT register an escalation when the current story itself owns the broken file (no regression)', () => {
    const { rc, escalation } = runCheck({
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      },
      storyId: 'SKY-003-impl',
      prdStories: [
        { id: 'SKY-003-impl', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } },
        { id: 'SKY-003-test', status: 'pending', technicalNotes: { files: ['src/cli.test.ts'] } },
      ],
    });
    expect(rc).toBe(1);
    expect(escalation).toBeNull();
  });

  it('REPRODUCES the exact live Writer Retest defect: no escalation possible (single-story PRD) still must NOT block', () => {
    const { rc, output, escalation } = runCheck({
      files: {
        'src/index.ts': "import { z } from './totally-nonexistent-module';",
      },
      storyId: 'SKY-003-test',
      prdStories: [{ id: 'SKY-003-test', status: 'pending', technicalNotes: { files: ['src/cli.test.ts'] } }],
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/outside this story's scope \(not blocking\)/);
    expect(escalation).toBeNull();
  });

  it('sets VERIFICATION_FAILURE and blocks only when the broken import is genuinely in-scope (owned by this story)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-import-escalation-vf-'));
    try {
      const files = {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client.js';",
      };
      for (const [relPath, content] of Object.entries(files)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{ id: 'SKY-003-impl', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } }],
        }),
      );
      const fnBody = extractFunctionBody('run_relative_import_check');
      const scriptPath = join(dir, 'run.sh');
      const outLog = join(dir, 'out.log');
      writeFileSync(
        scriptPath,
        [
          'VERIFICATION_FAILURE=""',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          'log() { :; }',
          fnBody,
          `run_relative_import_check ${JSON.stringify(dir)} ${JSON.stringify(outLog)} "SKY-003-impl"`,
          'echo "RC=$?"',
          'echo "VF=$VERIFICATION_FAILURE"',
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(output).toMatch(/RC=1/);
      expect(output).toMatch(/VF=[\s\S]*does not resolve to a real file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
