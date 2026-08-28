/**
 * Canonical PRD multi-codeline flow — prevents double-execution.
 *
 * Covers:
 *   C1 — _run_codeline_loop accepts an optional third arg (_phase_filter)
 *   C2 — phase filter skips non-matching phases (prevents double-execution)
 *   C3 — empty phase filter runs all PRD phases (Jira / direct invocation unaffected)
 *   C4 — entry point pre-parses --phase before multi-codeline routing check
 *   C5 — entry point passes _ep_caller_phase as third arg to _run_codeline_loop
 *   C6 — tier3 launcher tears down secondary worktrees when outputDirs has > 1 entry
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT  = join(__dirname, '../../../');
const ORCH_SH    = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const TIER3_SH   = join(REPO_ROOT, 'orchestrations/scripts/tier3-skyscanner-app-run.sh');
const orchSrc    = readFileSync(ORCH_SH,  'utf8');
const tier3Src   = readFileSync(TIER3_SH, 'utf8');

// ── C1: _run_codeline_loop accepts _phase_filter as third arg ─────────────────

describe('C1: _run_codeline_loop has _phase_filter as third arg', () => {
  it('function signature has local _phase_filter variable', () => {
    const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
    const block   = orchSrc.slice(loopIdx, loopIdx + 500);
    expect(block).toContain('_phase_filter=');
  });

  it('_phase_filter defaults to empty (does not break callers that pass no third arg)', () => {
    const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
    const block   = orchSrc.slice(loopIdx, loopIdx + 500);
    // Must use ${3:-} (empty default) so existing no-arg callers still run all phases
    expect(block).toMatch(/_phase_filter.*\$\{3:-\}/);
  });
});

// ── C2: phase filter skips non-matching phases ────────────────────────────────

describe('C2: phase filter in _run_codeline_loop skips non-matching phases', () => {
  const loopIdx = orchSrc.indexOf('_run_codeline_loop()');
  // Wide enough to include the skip logic after the phases loop starts
  // Bounded by the NEXT top-level function, not a magic character count. A fixed
  // 12000-char window broke when the loop grew by 92 characters — the assertion
  // silently stopped covering the code it was written for. A bare `\n}\n` is no
  // good either: this function embeds JSON heredocs whose closing brace sits at
  // column 0.
  const _next   = orchSrc.slice(loopIdx + 1).search(/\n[a-z_][a-z0-9_]*\(\)\s*\{/i);
  const block   = orchSrc.slice(loopIdx, _next > 0 ? loopIdx + 1 + _next : orchSrc.length);

  it('loop skips phases that do not match _phase_filter', () => {
    expect(block).toMatch(/\$_phase.*!=.*\$_phase_filter|_phase_filter.*!=.*_phase/);
  });

  it('skip is guarded by non-empty _phase_filter (empty = run all)', () => {
    // The guard must be: [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]
    expect(block).toMatch(/-n.*_phase_filter.*&&.*_phase.*!=.*_phase_filter/);
  });

  it('skipped phase emits a log line explaining the filter', () => {
    expect(block).toMatch(/phase filter|caller phase/i);
  });
});

// ── C3: empty _phase_filter runs all phases (existing callers unaffected) ──────

describe('C3: empty _phase_filter does not suppress any phases', () => {
  it('REAL: runs all phases when no filter is supplied', () => {
    // Extract the phases loop including the filter check and run a minimal bash test
    const loopStart = orchSrc.indexOf('for _phase in "${_phases[@]}"');
    expect(loopStart).toBeGreaterThan(-1);
    const phaseFilterGuard = orchSrc.indexOf('_phase_filter', loopStart);
    expect(phaseFilterGuard).toBeGreaterThan(loopStart);

    // Run a minimal bash fragment: set _phase_filter="" and check that all phases pass
    const dir = mkdtempSync(join(tmpdir(), 'cl-phase-filter-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '_phase_filter=""',
        '_skipped=0',
        '_ran=0',
        'for _phase in scaffold core finops; do',
        '  if [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]; then',
        '    _skipped=$((_skipped + 1))',
        '    continue',
        '  fi',
        '  _ran=$((_ran + 1))',
        'done',
        'echo "ran=$_ran skipped=$_skipped"',
      ].join('\n'));
      const out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out.trim()).toBe('ran=3 skipped=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL: phase filter runs only matching phase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-phase-filter2-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '_phase_filter="scaffold"',
        '_ran_phases=""',
        'for _phase in scaffold core finops; do',
        '  if [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]; then',
        '    continue',
        '  fi',
        '  _ran_phases="${_ran_phases:+${_ran_phases}:}${_phase}"',
        'done',
        'echo "$_ran_phases"',
      ].join('\n'));
      const out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out.trim()).toBe('scaffold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── C4: entry point pre-parses --phase before routing ─────────────────────────

describe('C4: entry point pre-parses --phase before the multi-codeline routing check', () => {
  it('_ep_caller_phase pre-parse block exists before the parent-only dispatch guard', () => {
    // The guard reads through is_parent now; what matters is unchanged — --phase must be
    // parsed before routing, or a --phase call runs every phase across every codeline.
    const epGuardIdx     = orchSrc.indexOf('if is_parent; then\n  if [ "${JIRA_PIPELINE:-0}" = "1" ]; then');
    const preParseIdx    = orchSrc.indexOf('_ep_caller_phase');
    expect(preParseIdx,  '_ep_caller_phase must be defined').toBeGreaterThan(-1);
    expect(epGuardIdx, 'the parent-only dispatch guard was not found').toBeGreaterThan(-1);
    expect(preParseIdx,  'pre-parse must come before the dispatch guard').toBeLessThan(epGuardIdx);
  });

  it('pre-parse block iterates over positional args looking for --phase', () => {
    const preParseIdx = orchSrc.indexOf('_ep_caller_phase');
    const block       = orchSrc.slice(preParseIdx, preParseIdx + 400);
    expect(block).toContain('"--phase"');
  });

  it('REAL: --phase value is captured by pre-parse loop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-preparse-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        // Inline the pre-parse logic
        '_ep_caller_phase=""',
        'for (( _ep_i=1; _ep_i<=$#; _ep_i++ )); do',
        '  if [ "${!_ep_i}" = "--phase" ]; then',
        '    _ep_j=$((_ep_i + 1))',
        '    _ep_caller_phase="${!_ep_j:-}"',
        '    break',
        '  fi',
        'done',
        'echo "$_ep_caller_phase"',
      ].join('\n'));
      const out = execFileSync('bash', [script, '--reset', '--phase', 'scaffold'], { encoding: 'utf8' });
      expect(out.trim()).toBe('scaffold');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL: pre-parse returns empty string when --phase is not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-preparse2-'));
    try {
      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '_ep_caller_phase=""',
        'for (( _ep_i=1; _ep_i<=$#; _ep_i++ )); do',
        '  if [ "${!_ep_i}" = "--phase" ]; then',
        '    _ep_j=$((_ep_i + 1))',
        '    _ep_caller_phase="${!_ep_j:-}"',
        '    break',
        '  fi',
        'done',
        'echo "${_ep_caller_phase:-EMPTY}"',
      ].join('\n'));
      const out = execFileSync('bash', [script, '--reset'], { encoding: 'utf8' });
      expect(out.trim()).toBe('EMPTY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── C5: entry point passes _ep_caller_phase to _run_codeline_loop ─────────────

describe('C5: entry point passes caller phase filter to _run_codeline_loop', () => {
  it('_run_codeline_loop call at entry point passes "${_ep_caller_phase}" as third arg', () => {
    const clCountIdx = orchSrc.indexOf('_cl_count:-0');
    expect(clCountIdx).toBeGreaterThan(-1);
    const block      = orchSrc.slice(clCountIdx, clCountIdx + 300);
    expect(block).toContain('_run_codeline_loop');
    expect(block).toContain('_ep_caller_phase');
  });

  it('the _run_codeline_loop call uses "" as second arg (log file) with phase as third', () => {
    const clCountIdx = orchSrc.indexOf('_cl_count:-0');
    const block      = orchSrc.slice(clCountIdx, clCountIdx + 300);
    // Must be: _run_codeline_loop "$PRD_FILE" "" "${_ep_caller_phase}"
    expect(block).toMatch(/_run_codeline_loop.*PRD_FILE.*"".*_ep_caller_phase/);
  });
});

// ── C6: tier3 tears down secondary worktrees for multi-codeline PRDs ──────────

describe('C6: tier3 tears down secondary worktrees', () => {
  it('tier3 reads project.outputDirs and excludes OUTPUT_DIR', () => {
    expect(tier3Src).toContain('_sec_wts');
    expect(tier3Src).toContain('outputDirs');
    // JS strict-inequality used inside the node -e expression
    expect(tier3Src).toContain("!== '$OUTPUT_DIR'");
  });

  it('tier3 tears down secondary worktrees with chmod+rm+mkdir+git init', () => {
    const secIdx = tier3Src.indexOf('_sec_wts');
    const block  = tier3Src.slice(secIdx, secIdx + 1000);
    expect(block).toContain('chmod -R u+w');
    expect(block).toContain('rm -rf');
    expect(block).toContain('mkdir -p');
    expect(block).toContain('git -C "$_sec_wt" init');
  });

  it('secondary teardown is placed after PRD integrity check and before pre-flight', () => {
    const integrityIdx  = tier3Src.indexOf('PRD integrity check failed');
    const secWtIdx      = tier3Src.indexOf('_sec_wts');
    const preflightIdx  = tier3Src.indexOf('Pre-flight validation');
    expect(secWtIdx).toBeGreaterThan(integrityIdx);
    expect(secWtIdx).toBeLessThan(preflightIdx);
  });

  it('REAL: node command extracts secondary worktree paths (excludes primary)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier3-sec-wt-'));
    try {
      const prd = {
        stories: [],
        project: {
          outputDir: '/primary/output',
          outputDirs: [
            { codeline: 'be', path: '/primary/output' },
            { codeline: 'fe', path: '/secondary/output' },
            { codeline: 'mobile', path: '/tertiary/output' },
          ],
        },
      };
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify(prd, null, 2));

      const script = join(dir, 'test.sh');
      const OUTPUT_DIR = '/primary/output';
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `node -e "`,
        `  const p = JSON.parse(require('fs').readFileSync('${prdFile}','utf8'));`,
        `  const dirs = p.project && p.project.outputDirs ? p.project.outputDirs : [];`,
        `  dirs.filter(d => d.path !== '${OUTPUT_DIR}').forEach(d => process.stdout.write(d.path+'\\\\n'));`,
        `" 2>/dev/null || true`,
      ].join('\n'));
      const out = execFileSync('bash', [script], { encoding: 'utf8' });
      const paths = out.trim().split('\n').filter(Boolean);
      expect(paths).toEqual(['/secondary/output', '/tertiary/output']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL: single-codeline PRD produces empty _sec_wts (teardown is a no-op)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier3-sec-wt-single-'));
    try {
      const prd = {
        stories: [],
        project: { outputDir: '/only/output' },
      };
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify(prd, null, 2));

      const script = join(dir, 'test.sh');
      writeFileSync(script, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `_sec_wts=$(node -e "`,
        `  const p = JSON.parse(require('fs').readFileSync('${prdFile}','utf8'));`,
        `  const dirs = p.project && p.project.outputDirs ? p.project.outputDirs : [];`,
        `  dirs.filter(d => d.path !== '/only/output').forEach(d => process.stdout.write(d.path+'\\\\n'));`,
        `" 2>/dev/null || true)`,
        'if [ -n "$_sec_wts" ]; then echo "HAS_SECONDARY"; else echo "NO_SECONDARY"; fi',
      ].join('\n'));
      const out = execFileSync('bash', [script], { encoding: 'utf8' });
      expect(out.trim()).toBe('NO_SECONDARY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
