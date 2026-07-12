/**
 * Real, computed bash line-coverage for the two escalation-mechanism
 * functions at the center of the 2026-07-11/12 sibling-escalation RCA
 * (resolve_escalation, run_relative_import_check in claude.sh).
 *
 * Uses orchestrations/scripts/tools/bash-coverage.js (`bash -x` +
 * BASH_XTRACEFD line tracing via direct script invocation) to measure what
 * fraction of each function's executable bash lines are actually exercised
 * by the test scenarios in this file -- a real number, not an estimate, and
 * not "function was mentioned in a test" (the earlier, cruder proxy metric).
 *
 * Each `it()` below is a real correctness test for one previously-untested
 * branch (found by an earlier coverage measurement pass that only exercised
 * the two "happy path" scenarios from the original RCA reproduction). The
 * final test reports aggregate coverage across every scenario in this file.
 *
 * This file does not assert a fixed coverage threshold -- picking a required
 * % is a project policy decision, not something to hardcode here. It exists
 * so real coverage numbers are computed on every test run instead of only
 * when someone manually asks, and so newly-added scenarios show up as
 * coverage gains instead of being invisible.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSourceWithCoverage, reportCoverage } from '../../../orchestrations/scripts/tools/bash-coverage';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

// Accumulated across every scenario run in this file so the final report
// reflects the union of everything this file actually exercises.
const resolveHits = new Set<string>();
const checkHits = new Set<string>();

function runResolveEscalation(opts: {
  escalatingStoryId: string;
  targetFileRelative?: string;
  escalationOverride?: Record<string, unknown>;
  prdStories: any[];
  implementStoryExit?: number;
}): { rc: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'linecov-resolve-'));
  try {
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }, null, 2));
    mkdirSync(join(dir, '.epam/escalations'), { recursive: true });
    const escalationBody =
      opts.escalationOverride ??
      {
        targetFile: opts.targetFileRelative,
        diagnosis: `Relative import in ${opts.targetFileRelative} does not resolve to a real file.`,
        requiredFix: `${opts.targetFileRelative}: imports './skyscanner/client.js' which does not exist.`,
      };
    writeFileSync(join(dir, '.epam/escalations', `${opts.escalatingStoryId}.json`), JSON.stringify(escalationBody));
    const fnBody = extractFunctionBody('resolve_escalation');
    const source = [
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
      `implement_story() { echo "STUB: implement_story called for $1"; return ${opts.implementStoryExit ?? 0}; }`,
      fnBody,
      `resolve_escalation ${JSON.stringify(opts.escalatingStoryId)}`,
      'echo "RC=$?"',
      '',
    ].join('\n');
    const { hits, stdout, stderr } = runSourceWithCoverage({ source, sourcePath: CLAUDE_SH, measureFragment: fnBody });
    for (const h of hits) resolveHits.add(h);
    const output = (stdout ?? '') + (stderr ?? '');
    const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
    return { rc, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCheck(opts: {
  storyId?: string;
  prdStories: any[];
  autoFix?: boolean;
  files?: Record<string, string>;
}): { rc: number; output: string; escalation: any | null; finalFiles: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'linecov-check-'));
  try {
    const files = opts.files ?? {
      'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
      'src/cli.ts': "import { SkyscannerClient } from './skyscanner/client.js';",
    };
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }, null, 2));
    const fnBody = extractFunctionBody('run_relative_import_check');
    const outLog = join(dir, 'out.log');
    const source = [
      '#!/usr/bin/env bash',
      'VERIFICATION_FAILURE=""',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
      `PROJECT_ROOT=${JSON.stringify(dir)}`,
      `EPAM_AUTO_FIX_RELATIVE_IMPORTS=${opts.autoFix ? 'true' : 'false'}`,
      'log() { echo "LOG: $*" >&2; }',
      fnBody,
      `run_relative_import_check ${JSON.stringify(dir)} ${JSON.stringify(outLog)} ${JSON.stringify(opts.storyId ?? '')}`,
      'echo "RC=$?"',
      '',
    ].join('\n');
    const { hits, stdout, stderr } = runSourceWithCoverage({ source, sourcePath: CLAUDE_SH, measureFragment: fnBody });
    for (const h of hits) checkHits.add(h);
    const output = (stdout ?? '') + (stderr ?? '');
    const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
    let escalation: any = null;
    try {
      escalation = JSON.parse(readFileSync(join(dir, '.epam/escalations', `${opts.storyId}.json`), 'utf8'));
    } catch {
      /* no escalation written */
    }
    const finalFiles: Record<string, string> = {};
    for (const rel of Object.keys(files)) {
      finalFiles[rel] = readFileSync(join(dir, rel), 'utf8');
    }
    return { rc, output, escalation, finalFiles };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolve_escalation() — branch coverage', () => {
  it('resolves via a split-sibling match (existing happy path)', () => {
    const { rc, output } = runResolveEscalation({
      escalatingStoryId: 'SKY-003-test',
      targetFileRelative: 'src/cli.ts',
      prdStories: [
        { id: 'SKY-003-impl', status: 'completed', specification: { createdFrom: 'SKY-003' }, technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/cli.ts'] } },
        { id: 'SKY-003-test', status: 'pending', specification: { createdFrom: 'SKY-003' }, technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/cli.test.ts'] } },
      ],
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/escalated a defect in .*cli\.ts \(owned by SKY-003-impl\)/);
  });

  it('a bare filename escalation still resolves against a sibling with an absolute path ending in that filename', () => {
    const { rc } = runResolveEscalation({
      escalatingStoryId: 'SKY-004-test',
      targetFileRelative: 'src/server.ts',
      prdStories: [
        { id: 'SKY-004-impl', status: 'completed', specification: { createdFrom: 'SKY-004' }, technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/server.ts'] } },
        { id: 'SKY-004-test', status: 'pending', specification: { createdFrom: 'SKY-004' }, technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/server.test.ts'] } },
      ],
    });
    expect(rc).toBe(0);
  });

  it('warns and gives up when no story declares the target file at all', () => {
    const { rc, output } = runResolveEscalation({
      escalatingStoryId: 'SKY-999-test',
      targetFileRelative: 'src/nonexistent.ts',
      prdStories: [{ id: 'SKY-999-impl', status: 'completed', specification: { createdFrom: 'SKY-999' }, technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/other.ts'] } }],
    });
    expect(rc).toBe(1);
    expect(output).toMatch(/Could not resolve an owning story/);
  });

  it('[NEW] falls back to a project-wide owner search when the escalating story has no split parent (createdFrom empty)', () => {
    // The FIRST jq query requires ($parent != ""), so a story with no
    // specification.createdFrom at all must fall through to the SECOND,
    // project-wide query -- this path was never exercised before.
    const { rc, output } = runResolveEscalation({
      escalatingStoryId: 'SKY-777-test',
      targetFileRelative: 'src/lonely.ts',
      prdStories: [
        { id: 'SKY-777-owner', status: 'completed', technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/lonely.ts'] } },
        { id: 'SKY-777-test', status: 'pending', technicalNotes: { files: ['/home/bradleyjerome/projects/skyscanner-app/src/lonely.test.ts'] } },
      ],
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/owned by SKY-777-owner/);
  });

  it('[NEW] treats a malformed escalation file (missing requiredFix) as unresolvable and deletes it', () => {
    const { rc, output } = runResolveEscalation({
      escalatingStoryId: 'SKY-888-test',
      escalationOverride: { targetFile: 'src/cli.ts', diagnosis: 'incomplete' },
      prdStories: [{ id: 'SKY-888-impl', status: 'completed', technicalNotes: { files: ['/x/src/cli.ts'] } }],
    });
    expect(rc).toBe(1);
    expect(output).toMatch(/Malformed escalation file/);
  });

  it('[NEW] reports non-convergence (does not crash) when the scoped fix attempt fails', () => {
    const { rc, output } = runResolveEscalation({
      escalatingStoryId: 'SKY-666-test',
      targetFileRelative: 'src/flaky.ts',
      implementStoryExit: 1,
      prdStories: [{ id: 'SKY-666-impl', status: 'completed', technicalNotes: { files: ['/x/src/flaky.ts'] } }],
    });
    expect(rc).toBe(1);
    expect(output).toMatch(/did not converge/);
  });
});

describe('run_relative_import_check() — branch coverage', () => {
  it('misattributes-fix regression guard: escalates to the active split child, not the deprecated parent', () => {
    const { output, escalation } = runCheck({
      storyId: 'SKY-003-test',
      prdStories: [
        { id: 'SKY-003', status: 'deprecated', technicalNotes: { files: ['src/cli.ts', 'src/cli.test.ts'] } },
        { id: 'SKY-003-impl', status: 'completed', specification: { createdFrom: 'SKY-003' }, technicalNotes: { files: ['src/cli.ts'] } },
        { id: 'SKY-003-test', status: 'pending', specification: { createdFrom: 'SKY-003' }, technicalNotes: { files: ['src/cli.test.ts'] } },
      ],
    });
    expect(output).toMatch(/owned by SKY-003-impl/);
    expect(output).not.toMatch(/owned by SKY-003 /);
    expect(escalation?.targetFile).toBe('src/cli.ts');
  });

  it('[NEW] the "OK" path: no broken imports at all returns 0 and writes no escalation', () => {
    const { rc, output, escalation } = runCheck({
      storyId: 'SKY-777-test',
      files: {
        'src/skyscanner/client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner/client';",
      },
      prdStories: [{ id: 'SKY-777-impl', status: 'completed', technicalNotes: { files: ['src/cli.ts'] } }],
    });
    expect(rc).toBe(0);
    expect(output).not.toMatch(/Broken import/);
    expect(escalation).toBeNull();
  });

  it('[NEW] the "story owns the broken file itself" path: no sibling escalation is registered', () => {
    const { rc, output, escalation } = runCheck({
      storyId: 'SKY-777-test',
      prdStories: [{ id: 'SKY-777-test', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } }],
    });
    expect(rc).toBe(1);
    expect(escalation).toBeNull();
    expect(output).not.toMatch(/registered sibling escalation/);
  });

  it('[NEW] the auto-fix path: EPAM_AUTO_FIX_RELATIVE_IMPORTS=true rewrites an owned file\'s broken import in place', () => {
    const { rc, output, finalFiles } = runCheck({
      storyId: 'SKY-777-test',
      autoFix: true,
      files: {
        'src/skyscanner-client.ts': 'export class SkyscannerClient {}',
        'src/cli.ts': "import { SkyscannerClient } from './skyscanner-client-typo';",
      },
      prdStories: [{ id: 'SKY-777-test', status: 'pending', technicalNotes: { files: ['src/cli.ts'] } }],
    });
    expect(output).toMatch(/Auto-corrected/);
    expect(rc).toBe(0);
    expect(finalFiles['src/cli.ts']).toContain("./skyscanner-client'");
  });
});

describe('bash line coverage — escalation mechanism (computed, not estimated)', () => {
  afterAll(() => {
    const resolveReport = reportCoverage(extractFunctionBody('resolve_escalation'), resolveHits, {
      isSource: true,
      logicalPath: CLAUDE_SH,
    });
    const checkReport = reportCoverage(extractFunctionBody('run_relative_import_check'), checkHits, {
      isSource: true,
      logicalPath: CLAUDE_SH,
    });
    const resolveBodyLines = extractFunctionBody('resolve_escalation').split('\n');
    const checkBodyLines = extractFunctionBody('run_relative_import_check').split('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\n[bash-line-coverage] resolve_escalation(): ${resolveReport.covered}/${resolveReport.total} lines (${resolveReport.percent.toFixed(1)}%)` +
        `\nUncovered:\n` +
        resolveReport.uncoveredLines.map((l) => `  L${l}: ${resolveBodyLines[l - 1]?.trim()}`).join('\n') +
        `\n[bash-line-coverage] run_relative_import_check(): ${checkReport.covered}/${checkReport.total} lines (${checkReport.percent.toFixed(1)}%)` +
        `\nUncovered:\n` +
        checkReport.uncoveredLines.map((l) => `  L${l}: ${checkBodyLines[l - 1]?.trim()}`).join('\n'),
    );
  });

  it('measurement mechanism is working (sanity, not a policy threshold)', () => {
    expect(resolveHits.size).toBeGreaterThan(0);
    expect(checkHits.size).toBeGreaterThan(0);
  });
});
