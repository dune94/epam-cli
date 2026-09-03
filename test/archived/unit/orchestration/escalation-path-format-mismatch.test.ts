/**
 * resolve_escalation() must actually be able to consume the escalation file
 * run_relative_import_check() writes — the sibling-escalation mechanism has
 * been COMPLETELY NON-FUNCTIONAL since it was built (2026-07-11), and this
 * caused SKY-003-test to burn its full retry ladder and fail the whole
 * 'core' phase TWICE across two separate live tier3-travel-app runs
 * (2026-07-11 and 2026-07-12) on the exact same underlying defect the
 * escalation mechanism was specifically built to solve.
 *
 * ROOT CAUSE — two distinct, compounding bugs, both in claude.sh:
 *
 * BUG A (fatal — the escalation NEVER resolves, for ANY story, ever):
 * run_relative_import_check()'s escalation-registration path writes
 * `targetFile` as a RELATIVE path (Python's `os.path.relpath(fpath,
 * project_root)`, e.g. "src/cli.ts") into .epam/escalations/<id>.json.
 * resolve_escalation() (the function that reads this file back on the next
 * retry to actually find the owning sibling and apply a scoped fix) does an
 * EXACT STRING match: `.technicalNotes.files[]? == $file`. But the REAL PRD
 * always stores ABSOLUTE paths in technicalNotes.files (confirmed live:
 * "/home/.../skyscanner-app/src/cli.ts") — "src/cli.ts" can never equal
 * that string. The match ALWAYS fails, resolve_escalation() ALWAYS warns
 * "Could not resolve an owning story... no story declares it" and deletes
 * the escalation file, and the calling story falls through to a normal
 * (doomed) retry — every single time this path fires, regardless of
 * whether the owning sibling is correctly identified or not.
 *
 * BUG B (secondary — misattributes the owner even before Bug A ever runs):
 * The INITIAL owner lookup inside run_relative_import_check() (the query
 * that decides whether to write an escalation at all, and logs "owned by
 * X") scans ALL stories with no deprecated-status filter and takes the
 * FIRST array match: `[.stories[] | select(.id != $self) | select(...)][0]`.
 * A split PARENT that's been marked deprecated (but still carries its
 * ORIGINAL pre-split combined technicalNotes.files, e.g. SKY-003 listing
 * both cli.ts AND cli.test.ts) commonly appears BEFORE its active child
 * (SKY-003-impl) in the stories array — so the log incorrectly says
 * "owned by SKY-003" (deprecated, wrong) instead of "owned by SKY-003-impl"
 * (active, correct, already-completed).
 *
 * WHY THIS WAS MISSED (found while doing this RCA): the ORIGINAL test file
 * for this mechanism (relative-import-sibling-escalation.test.ts, written
 * 2026-07-11 alongside the fix) only exercises run_relative_import_check()
 * — the WRITE side. It never calls resolve_escalation() — the READ/consume
 * side — at all, despite the fix's own design intent being explicitly to
 * plug into that existing consumer. Worse: that test's OWN fixture data
 * uses a RELATIVE path for technicalNotes.files ('src/cli.ts'), which
 * happens to exactly equal the relative targetFile the write side produces
 * — so even a naive "does the written file look right" sanity check would
 * never have surfaced the mismatch, because the fixture doesn't reflect
 * production's actual data shape (always absolute paths). A shared
 * file-based contract between two functions was tested on only one side,
 * with unrealistic fixture data that coincidentally avoided the exact
 * defect it needed to catch.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  // Match the REAL definition line (`name() {` at start of line, optionally
  // indented) -- a bare indexOf(`${name}()`) can match an earlier IN-COMMENT
  // mention of the function name (e.g. a docstring saying "resolve_escalation()
  // already knows how to consume...") and silently extract the wrong span,
  // producing a syntactically broken comment-fragment "function body".
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('BUG A — resolve_escalation() cannot consume a relative targetFile against absolute technicalNotes.files', () => {
  function runResolveEscalation(opts: {
    escalatingStoryId: string;
    targetFileRelative: string;
    prdStories: any[];
  }): { rc: number; output: string; prdAfter: any } {
    const dir = mkdtempSync(join(tmpdir(), 'escalation-resolve-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }, null, 2));
      mkdirSync(join(dir, '.epam/escalations'), { recursive: true });
      writeFileSync(
        join(dir, '.epam/escalations', `${opts.escalatingStoryId}.json`),
        JSON.stringify({
          targetFile: opts.targetFileRelative,
          diagnosis: `Relative import in ${opts.targetFileRelative} does not resolve to a real file.`,
          requiredFix: `${opts.targetFileRelative}: imports './skyscanner-client.js' which does not exist.`,
        }),
      );

      const fnBody = extractFunctionBody('resolve_escalation');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          'ESCALATION_FIX_MAX_RETRIES=1',
          'MAX_RETRIES=8',
          'log() { echo "LOG: $*" >&2; }',
          'warning() { echo "WARN: $*" >&2; }',
          'success() { echo "SUCCESS: $*" >&2; }',
          'error() { echo "ERROR: $*" >&2; }',
          // Stub the actual fix-application call so this test isolates the
          // OWNER-RESOLUTION logic (the part that's actually broken) from the
          // real implement_story machinery, which needs a live AI provider.
          'implement_story() { echo "STUB: implement_story called for $1"; return 0; }',
          fnBody,
          `resolve_escalation ${JSON.stringify(opts.escalatingStoryId)}`,
          'echo "RC=$?"',
        ].join('\n'),
      );
      // log()/warning()/success() all write to stderr, not stdout -- merge
      // streams via a single execution (resolve_escalation has side effects,
      // e.g. deleting the escalation file, so it must run exactly ONCE, not
      // twice to separately capture stdout then stderr).
      const stderrPath = join(dir, 'stderr.log');
      const wrapperPath = join(dir, 'run-wrapper.sh');
      writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
      let output = '';
      try {
        output = execFileSync('bash', [wrapperPath], { encoding: 'utf8' });
      } catch (e: any) {
        output = (e.stdout ?? '').toString();
      }
      output += readFileSync(stderrPath, 'utf8');
      const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
      const prdAfter = JSON.parse(readFileSync(prdPath, 'utf8'));
      return { rc, output, prdAfter };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect: a realistic escalation (relative targetFile) against a realistic PRD (absolute technicalNotes.files) fails to resolve — the owning sibling is never found', () => {
    const { rc, output } = runResolveEscalation({
      escalatingStoryId: 'SKY-003-test',
      targetFileRelative: 'src/cli.ts',
      prdStories: [
        {
          id: 'SKY-003-impl',
          status: 'completed',
          specification: { createdFrom: 'SKY-003' },
          technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/cli.ts'] },
        },
        {
          id: 'SKY-003-test',
          status: 'pending',
          specification: { createdFrom: 'SKY-003' },
          technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts'] },
        },
      ],
    });
    // THIS is the bug: it currently returns 1 (unresolved) and logs "Could not
    // resolve an owning story" even though SKY-003-impl clearly owns the file
    // — the desired, correct behavior is rc === 0 (resolved, sibling found).
    expect(rc).toBe(0);
    expect(output).toMatch(/escalated a defect in .*cli\.ts \(owned by SKY-003-impl\)/);
  });

  it('once fixed, a bare filename escalation still resolves against a sibling with an absolute path ending in that filename', () => {
    const { rc } = runResolveEscalation({
      escalatingStoryId: 'SKY-004-test',
      targetFileRelative: 'src/server.ts',
      prdStories: [
        {
          id: 'SKY-004-impl',
          status: 'completed',
          specification: { createdFrom: 'SKY-004' },
          technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/server.ts'] },
        },
        {
          id: 'SKY-004-test',
          status: 'pending',
          specification: { createdFrom: 'SKY-004' },
          technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/server.test.ts'] },
        },
      ],
    });
    expect(rc).toBe(0);
  });
});

describe('BUG B — the initial owner lookup in run_relative_import_check() misattributes ownership to a deprecated parent instead of the active split child', () => {
  function runCheck(opts: { storyId: string; prdStories: any[] }): { escalation: any | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'escalation-owner-lookup-'));
    try {
      mkdirSync(join(dir, 'src/skyscanner'), { recursive: true });
      writeFileSync(join(dir, 'src/skyscanner/client.ts'), 'export class SkyscannerClient {}');
      writeFileSync(join(dir, 'src/cli.ts'), "import { SkyscannerClient } from './skyscanner-client.js';");

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
          `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          'log() { echo "LOG: $*" >&2; }',
          fnBody,
          `run_relative_import_check ${JSON.stringify(dir)} ${JSON.stringify(outLog)} ${JSON.stringify(opts.storyId)}`,
          'echo "RC=$?"',
        ].join('\n'),
      );
      // log()/warning() both write to stderr, not stdout -- merge streams so
      // the returned `output` actually contains what a real run would show.
      let output = '';
      try {
        output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      } catch (e: any) {
        output = (e.stdout ?? '').toString();
      }
      const stderrPath = join(dir, 'stderr.log');
      writeFileSync(
        join(dir, 'run-2.sh'),
        `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`,
      );
      execFileSync('bash', [join(dir, 'run-2.sh')], { encoding: 'utf8' });
      output += readFileSync(stderrPath, 'utf8');
      let escalation: any = null;
      try {
        escalation = JSON.parse(readFileSync(join(dir, '.epam/escalations', `${opts.storyId}.json`), 'utf8'));
      } catch {
        /* no escalation written */
      }
      return { escalation, output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect: with a deprecated parent AND its active child both declaring the same file, the log/escalation attributes ownership to the ACTIVE CHILD, not the deprecated parent', () => {
    // Matches the real live PRD shape exactly: the deprecated parent still
    // carries BOTH files from before the split (cli.ts + cli.test.ts), and
    // appears BEFORE its active child in stories[] array order.
    const { output } = runCheck({
      storyId: 'SKY-003-test',
      prdStories: [
        {
          id: 'SKY-003',
          status: 'deprecated',
          technicalNotes: { files: ['src/cli.ts', 'src/cli.test.ts'] },
        },
        {
          id: 'SKY-003-impl',
          status: 'completed',
          specification: { createdFrom: 'SKY-003' },
          technicalNotes: { files: ['src/cli.ts'] },
        },
        {
          id: 'SKY-003-test',
          status: 'pending',
          specification: { createdFrom: 'SKY-003' },
          technicalNotes: { files: ['src/cli.test.ts'] },
        },
      ],
    });
    // Currently logs "owned by SKY-003" (the deprecated parent) -- desired
    // behavior is "owned by SKY-003-impl" (the real, active owner).
    expect(output).toMatch(/owned by SKY-003-impl/);
    expect(output).not.toMatch(/owned by SKY-003 /);
  });
});
