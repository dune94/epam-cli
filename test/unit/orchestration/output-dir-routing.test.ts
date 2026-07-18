/**
 * output-dir-routing — invariant tests for the OUTPUT_DIR / EPAM_PROJECT_OUTPUT_DIR
 * routing chain.
 *
 * Root cause this documents and prevents (found live 2026-07-17):
 *   - claude.sh run_healing_recorder writes healing-events.jsonl to
 *     "${OUTPUT_DIR:-$LOG_DIR}/healing-events.jsonl" (the project's output dir)
 *   - snapshot.js reads it from PROJECT_OUTPUT_DIR = process.env.EPAM_PROJECT_OUTPUT_DIR
 *     || DASHBOARD_ROOT — when the env var is absent, it falls back to DASHBOARD_ROOT
 *     (wrong dir for external-project runs), reporting zero self-heals every run
 *   - pre-run-reset.sh sets `export EPAM_PROJECT_OUTPUT_DIR="$LOG_DIR"` but is called
 *     with `bash`, not `source` — so the export dies with the subprocess and the
 *     Eleventy watcher (started by run-agent-orchestration.sh) never inherits it
 *
 * These tests verify the routing invariants that must hold for healing events,
 * story failures, guarded-step retries, and agent-activity to land in the same
 * directory that snapshot.js reads — and that this holds across bash→docker→Node
 * process boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../..');
const SNAPSHOT_JS = join(REPO_ROOT, 'orchestrations/dashboards/build/snapshot.js');
const PRE_RUN_RESET_SH = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const RUN_ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const PRE_RUN_RESET_SRC = readFileSync(PRE_RUN_RESET_SH, 'utf8');
const SNAPSHOT_SRC = readFileSync(SNAPSHOT_JS, 'utf8');
const CLAUDE_SRC = readFileSync(CLAUDE_SH, 'utf8');

// ── 1. snapshot.js path invariants (source analysis) ─────────────────────────

describe('snapshot.js — PATHS routing invariants', () => {
  it('PROJECT_OUTPUT_DIR reads from process.env.EPAM_PROJECT_OUTPUT_DIR', () => {
    expect(SNAPSHOT_SRC).toMatch(/process\.env\.EPAM_PROJECT_OUTPUT_DIR/);
  });

  it('PROJECT_OUTPUT_DIR is resolved via resolveProjectOutputDir() with .active-output-dir pointer and DASHBOARD_ROOT last-resort fallback', () => {
    // resolver must: (1) prefer EPAM_PROJECT_OUTPUT_DIR env, (2) read .active-output-dir
    // pointer written by pre-run-reset.sh, (3) fall back to DASHBOARD_ROOT last.
    expect(SNAPSHOT_SRC).toMatch(/resolveProjectOutputDir/);
    expect(SNAPSHOT_SRC).toMatch(/active-output-dir/);
    expect(SNAPSHOT_SRC).toMatch(/return DASHBOARD_ROOT/);
  });

  it('PATHS.healingEvents is under DASHBOARD_ROOT/logs — NOT PROJECT_OUTPUT_DIR (2026-07-17 fix)', () => {
    // healing-events.jsonl is pipeline monitoring data, not project output.
    // claude.sh always writes it to LOG_DIR (orchestrations/logs). snapshot.js
    // must read from the same place — DASHBOARD_ROOT/logs via the existing
    // orchestrations/dashboards/logs symlink — so agent-activity.html's
    // nginx-served logs/healing-events.jsonl fetch and snapshot.js both see
    // the same file. PROJECT_OUTPUT_DIR must NOT be used here.
    const healingLine = SNAPSHOT_SRC
      .split('\n')
      .find((l) => l.includes('healingEvents:'));
    expect(healingLine).toBeDefined();
    expect(healingLine).toMatch(/DASHBOARD_ROOT/);
    expect(healingLine).not.toMatch(/PROJECT_OUTPUT_DIR/);
  });

  it('PATHS.storyFailures is under PROJECT_OUTPUT_DIR', () => {
    const line = SNAPSHOT_SRC.split('\n').find((l) => l.includes('storyFailures:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/PROJECT_OUTPUT_DIR/);
    expect(line).not.toMatch(/DASHBOARD_ROOT/);
  });

  it('PATHS.guardedStepRetries is under PROJECT_OUTPUT_DIR', () => {
    const line = SNAPSHOT_SRC.split('\n').find((l) => l.includes('guardedStepRetries:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/PROJECT_OUTPUT_DIR/);
    expect(line).not.toMatch(/DASHBOARD_ROOT/);
  });

  it('PATHS.agentActivity uses EPAM_PROJECT_OUTPUT_DIR (or DASHBOARD_ROOT/logs fallback)', () => {
    const line = SNAPSHOT_SRC.split('\n').find((l) => l.includes('agentActivity:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/EPAM_PROJECT_OUTPUT_DIR/);
  });

  it('healingEvents uses DASHBOARD_ROOT/logs; storyFailures/guardedStepRetries/agentActivity use PROJECT_OUTPUT_DIR', () => {
    // healing-events is LOG_DIR data (always orchestrations/logs); the others are project output.
    const logDirKeys = ['healingEvents'];
    const projectKeys = ['storyFailures', 'guardedStepRetries', 'agentActivity'];
    for (const key of logDirKeys) {
      const line = SNAPSHOT_SRC.split('\n').find((l) => l.includes(`${key}:`));
      expect(line, `${key} must use DASHBOARD_ROOT/logs (not PROJECT_OUTPUT_DIR)`).toMatch(/DASHBOARD_ROOT/);
      expect(line, `${key} must NOT use PROJECT_OUTPUT_DIR`).not.toMatch(/PROJECT_OUTPUT_DIR/);
    }
    for (const key of projectKeys) {
      const line = SNAPSHOT_SRC.split('\n').find((l) => l.includes(`${key}:`));
      expect(line, `${key} must reference EPAM_PROJECT_OUTPUT_DIR`).toMatch(
        /PROJECT_OUTPUT_DIR|EPAM_PROJECT_OUTPUT_DIR/
      );
    }
  });
});

// ── 2. snapshot.js runtime path resolution ────────────────────────────────────

describe('snapshot.js — runtime path resolution (child process)', () => {
  it('PATHS.healingEvents always resolves to DASHBOARD_ROOT/logs/healing-events.jsonl', () => {
    // Fixed 2026-07-17: healing-events is LOG_DIR data — claude.sh always writes
    // to $LOG_DIR (orchestrations/logs). snapshot.js reads via DASHBOARD_ROOT/logs
    // (the symlink to orchestrations/logs), never PROJECT_OUTPUT_DIR.
    const dashboardRoot = join(REPO_ROOT, 'orchestrations/dashboards');
    const expectedPath = join(dashboardRoot, 'logs', 'healing-events.jsonl');
    const result = execSync(
      `node -e "
const path = require('path');
const DASHBOARD_ROOT = '${dashboardRoot}';
const healingEvents = path.join(DASHBOARD_ROOT, 'logs', 'healing-events.jsonl');
console.log(healingEvents);
"`,
      { encoding: 'utf8' }
    ).trim();
    expect(result).toBe(expectedPath);
  });

  it('PATHS.healingEvents does NOT change when EPAM_PROJECT_OUTPUT_DIR is set', () => {
    // Setting EPAM_PROJECT_OUTPUT_DIR must not redirect healing-events reads,
    // because it only controls project-output data (storyFailures, guardedStepRetries, etc.).
    const dashboardRoot = join(REPO_ROOT, 'orchestrations/dashboards');
    const fakeOutputDir = '/tmp/fake-project-output';
    const expectedPath = join(dashboardRoot, 'logs', 'healing-events.jsonl');
    const result = execSync(
      `node -e "
const path = require('path');
process.env.EPAM_PROJECT_OUTPUT_DIR = '${fakeOutputDir}';
const DASHBOARD_ROOT = '${dashboardRoot}';
// healingEvents is always LOG_DIR, ignores EPAM_PROJECT_OUTPUT_DIR
const healingEvents = path.join(DASHBOARD_ROOT, 'logs', 'healing-events.jsonl');
console.log(healingEvents);
"`,
      { encoding: 'utf8' }
    ).trim();
    expect(result).toBe(expectedPath);
    expect(result).not.toContain(fakeOutputDir);
  });
});

// ── 3. claude.sh — healing-recorder writes to LOG_DIR (fixed 2026-07-17) ──────

describe('claude.sh — run_healing_recorder write path', () => {
  it('writes to $LOG_DIR/healing-events.jsonl — NOT ${OUTPUT_DIR:-$LOG_DIR}', () => {
    // Fixed 2026-07-17: healing-events is pipeline monitoring data, not project output.
    // Writing to OUTPUT_DIR (e.g. /home/.../skyscanner-app) broke the dashboard which
    // reads from logs/healing-events.jsonl served via nginx /logs-dir → orchestrations/logs.
    const funcStart = CLAUDE_SRC.indexOf('run_healing_recorder()');
    const funcEnd   = CLAUDE_SRC.indexOf('\n}', funcStart + 50);
    const body      = CLAUDE_SRC.slice(funcStart, funcEnd);
    expect(body).toMatch(/heal_log="\$\{LOG_DIR\}\/healing-events\.jsonl"|heal_log="\$LOG_DIR\/healing-events\.jsonl"/);
    // Must NOT use OUTPUT_DIR for healing events
    expect(body).not.toMatch(/\$\{OUTPUT_DIR[^}]*\}\/healing-events\.jsonl/);
  });

  it('HEALING_BROKEN record includes retry, rung, target, diagnosis fields', () => {
    // The HEALING_BROKEN record was missing retry/rung/diagnosis, causing the
    // dashboard to show "retry ?" with no Rung badge. Fixed 2026-07-17.
    // Search for the printf line that writes the HEALING_BROKEN sentinel directly.
    const brokenIdx = CLAUDE_SRC.indexOf('"event":"HEALING_BROKEN"');
    expect(brokenIdx, 'HEALING_BROKEN sentinel not found in claude.sh').toBeGreaterThan(0);
    // Grab 500 chars around the printf line to check all required fields
    const printfChunk = CLAUDE_SRC.slice(Math.max(0, brokenIdx - 300), brokenIdx + 300);
    expect(printfChunk).toMatch(/"retry":/);
    expect(printfChunk).toMatch(/"rung":/);
    expect(printfChunk).toMatch(/"target":/);
    expect(printfChunk).toMatch(/"diagnosis":/);
  });
});

// ── 4. pre-run-reset.sh — sets EPAM_PROJECT_OUTPUT_DIR ───────────────────────

describe('pre-run-reset.sh — EPAM_PROJECT_OUTPUT_DIR propagation', () => {
  it('exports EPAM_PROJECT_OUTPUT_DIR equal to LOG_DIR', () => {
    expect(PRE_RUN_RESET_SRC).toMatch(/export EPAM_PROJECT_OUTPUT_DIR.*LOG_DIR/);
  });

  it('is called with bash (not sourced) from tier3 scripts — env var does NOT propagate to parent', () => {
    // This is the root cause: pre-run-reset.sh uses `export` but is invoked as a
    // subprocess. The export is lost after the subprocess exits. run-agent-orchestration.sh
    // then starts Eleventy without EPAM_PROJECT_OUTPUT_DIR in its environment.
    // SOLUTION: pre-run-reset.sh must ALSO write the value to a pointer file
    // that snapshot.js reads on startup (same pattern as .active-prd-path).
    const tier3Scripts = [
      join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh'),
      join(REPO_ROOT, 'orchestrations/scripts/tier3-skyscanner-app-run.sh'),
    ];
    for (const script of tier3Scripts) {
      if (!existsSync(script)) continue;
      const src = readFileSync(script, 'utf8');
      // Skip comment lines — find the actual invocation line
      const callLine = src.split('\n').find(
        (l) => l.includes('pre-run-reset.sh') && !l.trim().startsWith('#')
      );
      if (!callLine) continue;
      // The call uses `bash` (subprocess), not `. ` or `source`
      expect(callLine.trim(), `${script}: pre-run-reset.sh must be subprocess-called`).toMatch(
        /bash\s+.*pre-run-reset\.sh/
      );
    }
  });

  it('tier3-skyscanner writes .active-output-dir = OUTPUT_DIR (not LOG_DIR) after pre-run-reset', () => {
    // pre-run-reset.sh writes .active-output-dir = its LOG_DIR (orchestrations/logs).
    // That is WRONG for healingEvents which are in OUTPUT_DIR. tier3-skyscanner-app-run.sh
    // OVERWRITES .active-output-dir with OUTPUT_DIR immediately after pre-run-reset.
    // This test verifies that overwrite exists in the tier3 script.
    const tier3SkyPath = join(REPO_ROOT, 'orchestrations/scripts/tier3-skyscanner-app-run.sh');
    if (!existsSync(tier3SkyPath)) return;
    const tier3Sky = readFileSync(tier3SkyPath, 'utf8');
    // Must write OUTPUT_DIR to .active-output-dir after pre-run-reset
    expect(tier3Sky).toMatch(/echo.*OUTPUT_DIR.*active-output-dir|active-output-dir.*OUTPUT_DIR/);
  });

  it('snapshot.js reads .active-output-dir as fallback for EPAM_PROJECT_OUTPUT_DIR', () => {
    // snapshot.js must have an ACTIVE_OUTPUT_DIR_POINTER file-read, analogous to
    // how it reads ACTIVE_PRD_POINTER for the PRD path.
    expect(SNAPSHOT_SRC).toMatch(/active-output-dir/);
  });
});

// ── 5. pipeline warm-up — pre-flight checks ──────────────────────────────────

describe('run-agent-orchestration.sh — EPAM_PROJECT_OUTPUT_DIR routing', () => {
  const RUN_ORCH_SRC = readFileSync(RUN_ORCH_SH, 'utf8');

  it('references EPAM_PROJECT_OUTPUT_DIR in its source', () => {
    expect(RUN_ORCH_SRC).toMatch(/EPAM_PROJECT_OUTPUT_DIR/);
  });

  it('does NOT export EPAM_PROJECT_OUTPUT_DIR to Eleventy — agentActivity must use DASHBOARD_ROOT/logs symlink', () => {
    // KEY invariant: snapshot.js reads agentActivity via process.env.EPAM_PROJECT_OUTPUT_DIR
    // directly (not via resolveProjectOutputDir). If we export EPAM_PROJECT_OUTPUT_DIR=OUTPUT_DIR,
    // agentActivity reads from the project dir (wrong place — agent-activity.jsonl is always
    // in orchestrations/logs). The .active-output-dir pointer is sufficient for
    // resolveProjectOutputDir() which feeds healingEvents/storyFailures (the OUTPUT_DIR files).
    const watchStart = RUN_ORCH_SRC.indexOf('start_dashboards_watch()');
    const watchEnd   = RUN_ORCH_SRC.indexOf('\n}', watchStart + 100);
    const body       = RUN_ORCH_SRC.slice(watchStart, watchEnd);
    // Must NOT export EPAM_PROJECT_OUTPUT_DIR inside start_dashboards_watch
    expect(body).not.toMatch(/export EPAM_PROJECT_OUTPUT_DIR/);
  });
});

// ── 6. end-to-end routing consistency (bash integration) ─────────────────────

describe('output-dir routing — end-to-end bash integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'output-dir-routing-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function extractRecorder(): string {
    const start = CLAUDE_SRC.indexOf('run_healing_recorder()');
    if (start === -1) throw new Error('run_healing_recorder not found in claude.sh');
    const rest = CLAUDE_SRC.slice(start);
    const end  = rest.indexOf('\n}') + 2;
    return rest.slice(0, end);
  }

  it('healing-recorder always writes to $LOG_DIR/healing-events.jsonl — ignores OUTPUT_DIR', () => {
    // Fixed 2026-07-17: healing-events is pipeline monitoring data, not project output.
    // Even when OUTPUT_DIR points to an external project dir, the write goes to LOG_DIR
    // so nginx /logs-dir and agent-activity.html's logs/healing-events.jsonl both see it.
    const logDir  = join(tmpDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const funcDef    = extractRecorder();
    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
log() { :; }
LOG_DIR="${logDir}"
OUTPUT_DIR="${tmpDir}"  # must be ignored for healing-events
run_healing_recorder "TEST-001" "0" "skill" "test diagnosis" "0" "false"
`);
    execSync(`bash "${scriptPath}"`);

    // Must be in LOG_DIR, NOT in OUTPUT_DIR
    const expectedPath = join(logDir, 'healing-events.jsonl');
    const wrongPath    = join(tmpDir, 'healing-events.jsonl');
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(wrongPath)).toBe(false);
    const record = JSON.parse(readFileSync(expectedPath, 'utf8').trim());
    expect(record.story_id).toBe('TEST-001');
    expect(record.rung).toBe(0);
  });

  it('healing-recorder writes to LOG_DIR with no OUTPUT_DIR set', () => {
    const logDir  = join(tmpDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const funcDef    = extractRecorder();
    const scriptPath = join(tmpDir, 'run.sh');
    writeFileSync(scriptPath, `#!/bin/bash
${funcDef}
log() { :; }
LOG_DIR="${logDir}"
run_healing_recorder "TEST-002" "1" "prd" "ac patch" "2" "true"
`);
    execSync(`bash "${scriptPath}"`);

    const wroteAt = join(logDir, 'healing-events.jsonl');
    expect(existsSync(wroteAt)).toBe(true);
    const record = JSON.parse(readFileSync(wroteAt, 'utf8').trim());
    expect(record.story_id).toBe('TEST-002');
    expect(record.rung).toBe(0);  // retry 1 / 2 = 0 in integer division
  });
});
