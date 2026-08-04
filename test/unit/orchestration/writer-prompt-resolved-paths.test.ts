/**
 * The writer must be shown ONE filename per file: the one that exists on disk.
 *
 * THE BUG (live, call AMSD-2041_20260804_024915, metrolinx lane, ~2M input tokens).
 * The prompt contained BOTH spellings of the same file, nine times each:
 *
 *     ContentstackContext.tsx   9   <- as declared in the manifest
 *     contentstackContext.tsx   9   <- the real file on disk
 *
 * One file, two names, presented as though both were real. The writer did the rational
 * thing with contradictory input: it assumed two files existed, created the capital-C
 * one, deleted it as a duplicate, then declared the real one OUT OF SCOPE and escalated
 * to a sibling story — in its own words, "duplicate capital-C file removed". Its edits in
 * useContent.ts depended on fields defined in that very file, so tsc then failed with
 * exactly the errors its own change required:
 *
 *     TS2339: Property 'isLivePreview' does not exist on type 'IContentstackContext'
 *
 * Every retry reproduced the same reasoning and the same failure: 120 iterations (the
 * cap), 130 tool calls, 4 writes, ~2M input tokens billed with no prompt caching.
 *
 * _resolve_deliverable_path() ALREADY resolves the real path — the call's first log line
 * is "resolved case-insensitively to ...". But only `existing_file_contents` passes
 * through it. The `files` list and the raw `technicalNotes` dump carry the DECLARED
 * spelling, so both reach the prompt. Resolution happens and the unresolved value leaks
 * anyway — the same shape as the per-codeline manifest leak.
 *
 * GENERIC. Nothing here names a project, codeline, vendor or real filename; the fixture
 * invents its own case variant. The rule is structural: a path shown to the writer must
 * be one the filesystem agrees exists.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extractFn(name: string): string {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${name}()`));
  expect(i, `${name}() not found in claude.sh`).toBeGreaterThan(-1);
  const j = lines.findIndex((l, k) => k > i && l === '}');
  return lines.slice(i, j + 1).join('\n');
}

const REAL_FNS = [
  'get_story_details',
  '_current_lane',
  '_render_technical_notes',
  '_resolve_deliverable_path',
  '_resolve_declared_files',
  'build_implementation_prompt',
];

/**
 * A project whose file on disk uses a DIFFERENT case than the manifest declares —
 * the live condition, with invented names so nothing here is client-specific.
 */
function renderWithCaseVariant() {
  const dir = mkdtempSync(join(tmpdir(), 'resolved-paths-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src/widget'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });

  // ON DISK: lowercase leading letter.
  writeFileSync(
    join(dir, 'src/widget/gadgetContext.tsx'),
    'export interface IGadgetContext { existing: string }\n',
  );

  // DECLARED: uppercase leading letter. Same file, different spelling.
  const prd = join(dir, 'prd.json');
  writeFileSync(
    prd,
    JSON.stringify({
      project: { name: 'demo' },
      stories: [
        {
          id: 'ST-1',
          title: 'Wire the gadget',
          description: 'Add a field to the gadget context.',
          acceptanceCriteria: ['The field exists'],
          codeline: 'alpha',
          technicalNotes: { files: ['src/widget/GadgetContext.tsx'] },
        },
      ],
    }),
  );

  const runner = join(dir, 'run.sh');
  writeFileSync(join(dir, 'fn.sh'), REAL_FNS.map(extractFn).join('\n\n'));
  writeFileSync(
    runner,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'log(){ :; }; warning(){ :; }; success(){ :; }; error(){ :; }',
      'run_dependency_check(){ :; }; _discover_vendor_packages(){ :; }',
      '_generate_vendor_contract(){ :; }; _module_resolution_context(){ echo "[[STUB]]"; }',
      `source ${JSON.stringify(join(dir, 'fn.sh'))}`,
      'build_implementation_prompt ST-1',
    ].join('\n'),
  );

  const r = spawnSync('bash', [runner], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PRD_FILE: prd,
      PROJECT_ROOT: dir,
      LOG_DIR: join(dir, 'logs'),
      SCRIPT_DIR: join(REPO_ROOT, 'orchestrations/scripts'),
      AGENT_PROFILES_FILE: '',
    },
  });
  const out = r.stdout || '';
  expect(r.status, `prompt builder exited ${r.status}: ${r.stderr}`).toBe(0);
  expect(out.length, 'HARNESS FAILURE: empty prompt').toBeGreaterThan(400);
  return out;
}

describe('a path shown to the writer exists on disk', () => {
  it('REPRODUCES THE LIVE BUG: the DECLARED spelling must not appear', () => {
    const out = renderWithCaseVariant();
    expect(
      out,
      'the prompt names a file that does not exist on disk. Live 2026-08-04 the writer ' +
        'saw both spellings 9 times each, concluded there were two files, created the ' +
        'phantom one, deleted it, declared the real one out of scope, and every retry ' +
        'then failed tsc on fields its own edits required — 120 iterations, ~2M tokens.',
    ).not.toContain('GadgetContext.tsx');
  });

  it('shows the REAL on-disk spelling instead', () => {
    expect(renderWithCaseVariant()).toContain('gadgetContext.tsx');
  });

  it('never shows BOTH spellings — one file, one name', () => {
    const out = renderWithCaseVariant();
    const declared = (out.match(/GadgetContext\.tsx/g) || []).length;
    const real = (out.match(/gadgetContext\.tsx/g) || []).length;
    expect(
      declared,
      `the prompt carries ${declared} declared and ${real} real references to one file — ` +
        'contradictory input the agent cannot resolve',
    ).toBe(0);
    expect(real).toBeGreaterThan(0);
  });

  it('an already-correct declaration is untouched', () => {
    // Regression guard: resolution must not rewrite paths that were right to begin with.
    const dir = mkdtempSync(join(tmpdir(), 'exact-paths-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'src/plain.ts'), 'export const a = 1;\n');
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories: [{
        id: 'ST-1', title: 'T', description: 'D', acceptanceCriteria: ['A'],
        codeline: 'alpha', technicalNotes: { files: ['src/plain.ts'] },
      }],
    }));
    writeFileSync(join(dir, 'fn.sh'), REAL_FNS.map(extractFn).join('\n\n'));
    const runner = join(dir, 'run.sh');
    writeFileSync(runner, [
      '#!/usr/bin/env bash', 'set -uo pipefail',
      'log(){ :; }; warning(){ :; }; success(){ :; }; error(){ :; }',
      'run_dependency_check(){ :; }; _discover_vendor_packages(){ :; }',
      '_generate_vendor_contract(){ :; }; _module_resolution_context(){ echo "[[STUB]]"; }',
      `source ${JSON.stringify(join(dir, 'fn.sh'))}`,
      'build_implementation_prompt ST-1',
    ].join('\n'));
    const r = spawnSync('bash', [runner], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PRD_FILE: prd, PROJECT_ROOT: dir, LOG_DIR: join(dir, 'logs'),
             SCRIPT_DIR: join(REPO_ROOT, 'orchestrations/scripts'), AGENT_PROFILES_FILE: '' },
    });
    expect(r.stdout).toContain('src/plain.ts');
  });

  it('carries no client, vendor or project vocabulary in the rule itself', () => {
    // The engine must run on the next unknown project unmodified.
    // Comment-only lines are exempt, matching engine-is-generic.test.ts: provenance
    // notes naming the incident are documentation, not behaviour.
    const code = extractFn('_resolve_deliverable_path')
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});
