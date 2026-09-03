/**
 * team-lead-review.sh must review the ACTUAL project under test, not
 * epam-cli's own repo.
 *
 * Bug found 2026-07-22 while wiring a real full-pipeline integration test:
 * team-lead-review.sh unconditionally set `PROJECT_ROOT="$(dirname
 * "$AUTOMATION_DIR")"` and `PRD_FILE="$AUTOMATION_DIR/prd.json"` — both
 * always resolving to epam-cli's OWN repo root and PRD, no matter what
 * PROJECT_ROOT/PRD_FILE the enclosing run-agent-orchestration.sh invocation
 * was actually using. Every run against an external test-app/codeline (tier1
 * hello-world, tier3 metrolinx/skyscanner) silently had Step 3.6 review the
 * wrong project. run-agent-orchestration.sh also never exported PRD_FILE, so
 * even a fixed team-lead-review.sh would have had nothing to inherit.
 *
 * Fix: run-agent-orchestration.sh now `export`s PRD_FILE once resolved, and
 * team-lead-review.sh reads `${PROJECT_ROOT:-...}` / `${PRD_FILE:-...}` —
 * falling back to its own repo's paths only when invoked standalone with
 * neither set (preserving old behavior for that case).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const RUN_AGENT_ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const TEAM_LEAD_REVIEW = join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh');

describe('run-agent-orchestration.sh exports PRD_FILE', () => {
  it('exports PRD_FILE after resolving it to an absolute path', () => {
    const src = execFileSync('bash', ['-c', `cat ${JSON.stringify(RUN_AGENT_ORCH)}`], { encoding: 'utf8' });
    const idx = src.indexOf('PRD_FILE="$(cd "$(dirname "$PRD_FILE")"');
    expect(idx).toBeGreaterThan(-1);
    const after = src.slice(idx, idx + 400);
    expect(after).toMatch(/^\s*export PRD_FILE\s*$/m);
  });
});

describe('team-lead-review.sh resolves PROJECT_ROOT/PRD_FILE from the caller when set', () => {
  it('falls back to its own repo paths when PROJECT_ROOT/PRD_FILE are unset', () => {
    const src = execFileSync('cat', [TEAM_LEAD_REVIEW], { encoding: 'utf8' });
    expect(src).toMatch(/PROJECT_ROOT="\$\{PROJECT_ROOT:-\$\(dirname "\$AUTOMATION_DIR"\)\}"/);
    expect(src).toMatch(/PRD_FILE="\$\{PRD_FILE:-\$AUTOMATION_DIR\/prd\.json\}"/);
  });

  it('REAL execution: an externally-set PROJECT_ROOT/PRD_FILE survive through to the script body, not just its own repo defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlr-project-root-'));
    try {
      const mockPrd = join(dir, 'mock-prd.json');
      writeFileSync(mockPrd, JSON.stringify({ implementationOrder: { p: [] }, stories: [] }));

      // Extract just the variable-resolution header (through AI_RUNNER_CMD line)
      // and echo the resolved values — proves the REAL script's own resolution
      // logic (not a hand-copied approximation of it) picks up externally-set vars.
      const src = execFileSync('cat', [TEAM_LEAD_REVIEW], { encoding: 'utf8' });
      const startMarker = 'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"';
      const endMarker = 'AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"';
      const startIdx = src.indexOf(startMarker);
      const endIdx = src.indexOf(endMarker, startIdx) + endMarker.length;
      expect(startIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeGreaterThan(startIdx);
      const header = src.slice(startIdx, endIdx);

      const scriptPath = join(dir, 'probe.sh');
      writeFileSync(
        scriptPath,
        ['#!/usr/bin/env bash', 'set -euo pipefail', header, 'echo "PROJECT_ROOT=$PROJECT_ROOT"', 'echo "PRD_FILE=$PRD_FILE"'].join(
          '\n'
        )
      );

      const externalProjectRoot = join(dir, 'external-project');
      mkdirSync(externalProjectRoot, { recursive: true });

      const out = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PROJECT_ROOT: externalProjectRoot, PRD_FILE: mockPrd },
      });

      expect(out).toContain(`PROJECT_ROOT=${externalProjectRoot}`);
      expect(out).toContain(`PRD_FILE=${mockPrd}`);
      expect(out).not.toContain('PROJECT_ROOT=' + REPO_ROOT.replace(/\/$/, ''));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
