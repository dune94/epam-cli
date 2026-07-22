/**
 * semble integration: codeline discovery + spec context injection.
 *
 * Guards three contracts:
 *  1. semble-context.js exports correct API surface
 *  2. codeline-discovery.js routes through scoreRepos() (semble-aware)
 *  3. spec-mode-runner.js injects semble context into spec prompts
 *  4. SEMBLE_ENABLED is metrolinx-only — not in greenfield jira/.env
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT     = join(__dirname, '../../../');
const SEMBLE_SRC    = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/semble-context.js'), 'utf8');
const DISCOVERY_SRC = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'), 'utf8');
const SPEC_SRC      = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const METRO_ENV     = readFileSync(join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8');
const JIRA_ENV      = readFileSync(join(REPO_ROOT, 'orchestrations/jira/.env'), 'utf8');

// ── semble-context.js API ──────────────────────────────────────────────────

describe('semble-context.js: module API', () => {
  it('exports sembleSearch', () => {
    expect(SEMBLE_SRC).toContain('module.exports = { sembleSearch');
  });

  it('exports formatAsText', () => {
    expect(SEMBLE_SRC).toContain('formatAsText');
  });

  it('exports resolveSembleBin', () => {
    expect(SEMBLE_SRC).toContain('resolveSembleBin');
  });

  it('gates live calls behind SEMBLE_ENABLED === "1"', () => {
    expect(SEMBLE_SRC).toContain("SEMBLE_ENABLED === '1'");
  });

  it('handles missing semble binary gracefully (returns empty results)', () => {
    expect(SEMBLE_SRC).toContain("results: []");
    expect(SEMBLE_SRC).toContain('semble not found in PATH');
  });

  it('caps query length to avoid oversized CLI args', () => {
    expect(SEMBLE_SRC).toMatch(/slice\(0,\s*\d+\)/);
  });

  it('formats results as code blocks with file path and line range', () => {
    expect(SEMBLE_SRC).toContain('file_path');
    expect(SEMBLE_SRC).toContain('start_line');
    expect(SEMBLE_SRC).toContain('end_line');
  });
});

// ── codeline-discovery.js: CodeGraph scoring (Semble removed from discovery) ──
// grep -ril removed first (O(repo-size), ETIMEDOUT on large repos).
// Semble semantic search replaced grep but was brittle (1-pt cosine margins).
// All 31 Metrolinx repos are now CodeGraph-indexed — Semble removed from scoring.
// Semble remains in spec-mode-runner.js as brownfield context fallback only.

describe('codeline-discovery.js: discovery scoring uses CodeGraph, not grep or Semble', () => {
  it('defines scoreRepos() with CodeGraph tier', () => {
    expect(DISCOVERY_SRC).toMatch(/function scoreRepos\s*\(/);
    expect(DISCOVERY_SRC).toMatch(/queryCodeGraph/);
  });

  it('does NOT use grep -ril for source scanning', () => {
    expect(DISCOVERY_SRC).not.toContain('grep -ril');
  });

  it('does NOT use Semble in scoring (all repos indexed; removed as noise)', () => {
    const scoreIdx = DISCOVERY_SRC.indexOf('function scoreRepos');
    const scoreFn  = DISCOVERY_SRC.slice(scoreIdx, scoreIdx + 2000);
    expect(scoreFn).not.toMatch(/sembleSearch|SEMBLE_ENABLED/);
  });

  it('calls scoreRepos before DRY_RUN branch', () => {
    const scoringCallIdx  = DISCOVERY_SRC.indexOf('const candidates = scoreRepos');
    const dryRunBranchIdx = DISCOVERY_SRC.indexOf('if (DRY_RUN)');
    expect(scoringCallIdx).toBeGreaterThan(-1);
    expect(scoringCallIdx).toBeLessThan(dryRunBranchIdx);
  });

  it('does NOT import semble-context (removed from discovery)', () => {
    expect(DISCOVERY_SRC).not.toContain("require('./semble-context')");
  });

  it('logs repo scoring results', () => {
    expect(DISCOVERY_SRC).toContain('Repo scoring: top');
  });
});

// ── spec-mode-runner.js: semble context injection ─────────────────────────

describe('spec-mode-runner.js: semble context injected into spec prompt', () => {
  it('imports semble-context lazily', () => {
    expect(SPEC_SRC).toContain("require('./lib/semble-context')");
  });

  it('defines fetchSembleContext(story)', () => {
    expect(SPEC_SRC).toMatch(/function fetchSembleContext\s*\(\s*story\s*\)/);
  });

  it('injects semble block into runSpecAgent prompt', () => {
    expect(SPEC_SRC).toContain('sembleContext');
    expect(SPEC_SRC).toContain('fetchSembleContext(story)');
  });

  it('resolves codeline path from JIRA_WORKTREE_<UPPER> env convention', () => {
    expect(SPEC_SRC).toContain('JIRA_WORKTREE_');
    expect(SPEC_SRC).toContain('.toUpperCase()');
  });

  it('returns empty string when SEMBLE_ENABLED is not "1" (no-op for greenfield)', () => {
    expect(SPEC_SRC).toContain("process.env.SEMBLE_ENABLED !== '1'");
    expect(SPEC_SRC).toMatch(/return\s*''/);
  });

  it('returns empty string when repo path does not exist', () => {
    expect(SPEC_SRC).toContain('fs.existsSync(repoPath)');
  });

  it('prompt label tells the agent context source ("semble semantic search")', () => {
    expect(SPEC_SRC).toContain('semble semantic search');
  });
});

// ── Greenfield isolation ───────────────────────────────────────────────────

describe('greenfield isolation: SEMBLE_ENABLED must not appear in shared jira/.env', () => {
  it('orchestrations/jira/.env does not set SEMBLE_ENABLED', () => {
    expect(JIRA_ENV).not.toMatch(/^SEMBLE_ENABLED=/m);
  });
});

describe('metrolinx/config.env: semble enabled for brownfield project', () => {
  it('sets SEMBLE_ENABLED=1', () => {
    expect(METRO_ENV).toMatch(/^SEMBLE_ENABLED=1$/m);
  });
});
