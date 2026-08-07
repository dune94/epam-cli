/**
 * Structural tests for orchestrations/scripts/orchestrate.sh.
 *
 * Three live bugs were caught only during a real run instead of here:
 *
 *  Bug 1 — $@ emptied by shift before setsid re-exec:
 *    The arg-parsing while loop shifts all positional params. When the setsid
 *    block then runs `exec setsid bash "$0" "$@"`, $@ is empty and the re-exec
 *    receives no arguments → "Usage:" error, run never starts.
 *
 *  Bug 2 — secrets file sourced AFTER project config:
 *    orchestrations/jira/.env contained JIRA_URL=bradjerome.atlassian.net which
 *    was loaded AFTER config.env, clobbering the project's JIRA_URL. Run posted
 *    AC-sufficiency comments to the wrong Jira project (KAN instead of AMSD).
 *
 *  Bug 3 — run-agent-orchestration.sh unconditionally re-sources jira/.env:
 *    Even with orchestrate.sh loading the correct JIRA_URL, the orch engine
 *    sourced orchestrations/jira/.env again when JIRA_PIPELINE=1, overwriting
 *    JIRA_URL with the stale value. Fix: skip the auto-source when JIRA_URL
 *    is already set in the environment.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../../');
const LAUNCHER = join(REPO_ROOT, 'orchestrations/scripts/orchestrate.sh');
const ORCH_SH  = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const launcherSrc = readFileSync(LAUNCHER, 'utf8');
const orchSrc     = readFileSync(ORCH_SH,  'utf8');

// ── Bug 1: $@ must be saved before the shift loop ────────────────────────────
describe('orchestrate.sh — arg preservation across setsid re-exec (Bug 1)', () => {
  it('saves original args to _ORIG_ARGS before the shift loop', () => {
    // _ORIG_ARGS must be assigned before the while [[ $# -gt 0 ]] loop so that
    // setsid re-exec still has all original positional params.
    const origArgsIdx = launcherSrc.indexOf('_ORIG_ARGS=("$@")');
    const shiftLoopIdx = launcherSrc.indexOf('while [[ $# -gt 0 ]]');
    expect(origArgsIdx).toBeGreaterThan(-1);
    expect(shiftLoopIdx).toBeGreaterThan(-1);
    expect(origArgsIdx).toBeLessThan(shiftLoopIdx);
  });

  it('setsid re-exec uses _ORIG_ARGS not $@', () => {
    // If $@ were used the re-exec would receive no arguments (all consumed by shift).
    const setsidExec = launcherSrc.match(/exec setsid bash "\$0" (.+)/)?.[1] ?? '';
    expect(setsidExec).toContain('_ORIG_ARGS');
    expect(setsidExec).not.toContain('"$@"');
  });
});

// ── Bug 2: project config must win over secrets file ─────────────────────────
describe('orchestrate.sh — project config load order (Bug 2)', () => {
  it('sources project config AFTER secrets file so project values always win', () => {
    // Correct order: global .env → secrets file → project config (re-source).
    // The secrets file (e.g. orchestrations/jira/.env) may contain stale
    // JIRA_URL/JIRA_PROJECT_KEY for a different project; project config must
    // be sourced last to override those values.
    const secretsSourceIdx = launcherSrc.indexOf('load_env_file_safe "$_secrets_abs"');
    // Final source of CONFIG must come after secrets sourcing
    // 2026-08-06: config files are loaded as DATA (load_env_file_safe), never
    // `source`d — a config file must not be able to execute anything. The
    // ORDERING property this test exists for is unchanged and still asserted.
    const configSources = [...launcherSrc.matchAll(/load_env_file_safe "\$CONFIG"/g)].map(m => m.index ?? -1);
    expect(secretsSourceIdx).toBeGreaterThan(-1);
    expect(configSources.length).toBeGreaterThanOrEqual(2); // sourced at least twice
    const lastConfigSource = Math.max(...configSources);
    expect(lastConfigSource).toBeGreaterThan(secretsSourceIdx);
  });

  it('secrets file is sourced via SECRETS_FILE variable (declared in project config)', () => {
    // SECRETS_FILE is declared in config.env, not hardcoded in orchestrate.sh,
    // so each project controls which secrets file to load.
    expect(launcherSrc).toMatch(/SECRETS_FILE/);
    expect(launcherSrc).not.toMatch(/source.*orchestrations\/jira\/\.env/);
  });
});

// ── Bug 3: orch engine must not re-clobber JIRA_URL when caller already set it
describe('run-agent-orchestration.sh — jira/.env auto-source guard (Bug 3)', () => {
  it('skips auto-sourcing jira/.env when JIRA_URL is already set in the environment', () => {
    // When JIRA_PIPELINE=1 the orch engine used to unconditionally source
    // orchestrations/jira/.env, overwriting the caller's JIRA_URL with whatever
    // stale project was last stored there.
    // Fix: only source when JIRA_URL is absent (caller has not already configured it).
    const autoSourceBlock = (() => {
      const start = orchSrc.indexOf('Only auto-source jira/.env when the caller');
      if (start !== -1) return orchSrc.slice(start, start + 400);
      // Fallback: find the if-block guarding the jira/.env source
      const ifIdx = orchSrc.indexOf('[ -f "$AUTOMATION_DIR/jira/.env" ]');
      expect(ifIdx).toBeGreaterThan(-1);
      return orchSrc.slice(Math.max(0, ifIdx - 200), ifIdx + 200);
    })();
    expect(autoSourceBlock).toMatch(/JIRA_URL/);
    expect(autoSourceBlock).toMatch(/-z.*JIRA_URL/);
  });

  it('still auto-sources jira/.env when JIRA_URL is not set (backward compat for direct invocations)', () => {
    // The guard must be a "skip if ALREADY set" check, not an unconditional skip.
    // Direct invocations of run-agent-orchestration.sh without orchestrate.sh
    // still rely on the auto-source to pick up Jira connection config.
    const ifBlock = (() => {
      const idx = orchSrc.indexOf('[ -f "$AUTOMATION_DIR/jira/.env" ]');
      return orchSrc.slice(Math.max(0, idx - 300), idx + 50);
    })();
    // The condition must check JIRA_PIPELINE=1, JIRA_CODELINE_RUN absent, AND
    // JIRA_URL absent — all three must be present in the same if-block.
    expect(ifBlock).toMatch(/JIRA_PIPELINE.*1/);
    expect(ifBlock).toMatch(/JIRA_CODELINE_RUN/);
    expect(ifBlock).toMatch(/JIRA_URL/);
  });
});

// ── Bug 4: Jira ingest failure must hard-abort, never fall through to stale PRD
// Bug 4b (live incident 2026-07-21): ingest-jira-tickets.sh exited 1 (wrong workspace)
// but _run_jira_pipeline continued with the old travel-app-prd.json because
// `|| _ingest_exit=${PIPESTATUS[0]}` only fires when tee fails (almost never).
// Without pipefail, PIPESTATUS[0] must be captured UNCONDITIONALLY after the pipeline.
describe('run-agent-orchestration.sh — Jira ingest failure aborts the run (Bug 4)', () => {
  it('_run_jira_pipeline captures _ingest_exit from PIPESTATUS[0] unconditionally (not via ||)', () => {
    // Root cause of 2026-07-21 incident: `... | tee ... || _ingest_exit=${PIPESTATUS[0]}`
    // Without `set -o pipefail`, the pipeline exit code is tee's (always 0), so the
    // || NEVER fires. ingest exits 1, tee exits 0, _ingest_exit stays 0, run continues
    // with stale PRD.
    // Fix: capture PIPESTATUS[0] on the line AFTER the pipeline (not in ||).
    const pipelineFn = (() => {
      const start = orchSrc.indexOf('_run_jira_pipeline()');
      expect(start).toBeGreaterThan(-1);
      let depth = 0; let i = start;
      while (i < orchSrc.length) {
        if (orchSrc[i] === '{') depth++;
        else if (orchSrc[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      return orchSrc.slice(start, i + 1);
    })();
    // Must NOT use the `|| _ingest_exit=` pattern (only fires on tee failure)
    expect(pipelineFn).not.toMatch(/\| tee.*\|\| _ingest_exit=\$\{PIPESTATUS/);
    // Must assign _ingest_exit AFTER the pipeline (next line)
    // i.e., `... | tee ...\n  _ingest_exit="${PIPESTATUS[0]}"`
    expect(pipelineFn).toMatch(/_ingest_exit="\$\{PIPESTATUS\[0\]\}"/);
  });

  it('_run_jira_pipeline returns non-zero when ingest exits non-zero', () => {
    // ingest-jira-tickets.sh exits 1 on 403 / no issues / bad token.
    // _run_jira_pipeline must propagate that exit — never continue with the
    // stale travel-app-prd.json left from a prior run.
    const pipelineFn = (() => {
      const start = orchSrc.indexOf('_run_jira_pipeline()');
      expect(start).toBeGreaterThan(-1);
      let depth = 0; let i = start;
      while (i < orchSrc.length) {
        if (orchSrc[i] === '{') depth++;
        else if (orchSrc[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      return orchSrc.slice(start, i + 1);
    })();
    // Must check _ingest_exit and return/exit non-zero on failure
    expect(pipelineFn).toMatch(/_ingest_exit/);
    expect(pipelineFn).toMatch(/return 1|exit 1/);
    // Must NOT fall through to _run_codeline_loop on non-zero ingest exit
    const ingestFailBlock = pipelineFn.slice(
      pipelineFn.indexOf('_ingest_exit'),
      pipelineFn.indexOf('_run_codeline_loop')
    );
    expect(ingestFailBlock).toMatch(/return 1|exit 1/);
  });

  it('ingest-jira-tickets.sh exits 1 when the Jira API returns 0 issues (e.g. 403 empties the list)', () => {
    const ingestSrc = readFileSync(
      join(REPO_ROOT, 'orchestrations/scripts/ingest-jira-tickets.sh'), 'utf8'
    );
    // When ISSUE_COUNT=0, the script must exit 1 — not continue silently
    const zeroBlock = (() => {
      const idx = ingestSrc.indexOf('ISSUE_COUNT" = "0"');
      expect(idx).toBeGreaterThan(-1);
      return ingestSrc.slice(idx, idx + 200);
    })();
    expect(zeroBlock).toMatch(/exit 1/);
  });

  it('ingest-jira-tickets.sh node catch block writes [] to issues file AND exits 1 (no silent fallback)', () => {
    const ingestSrc = readFileSync(
      join(REPO_ROOT, 'orchestrations/scripts/ingest-jira-tickets.sh'), 'utf8'
    );
    // The node catch handler must call process.exit(1) — not just log and continue —
    // so bash sees a non-zero exit code from the node invocation.
    const catchBlock = (() => {
      const idx = ingestSrc.indexOf('.catch(e =>');
      expect(idx).toBeGreaterThan(-1);
      return ingestSrc.slice(idx, idx + 200);
    })();
    expect(catchBlock).toMatch(/process\.exit\(1\)/);
  });
});

// ── Bug 5: orchestrate.sh must pre-validate Jira connectivity before launch ───
describe('orchestrate.sh — brownfield Jira pre-flight (Bug 5)', () => {
  it('validates JIRA_URL, JIRA_PROJECT_KEY, and JIRA_TOKEN are all set before launching pipeline', () => {
    // The required-keys check (REQUIRED_KEYS=...,JIRA_TOKEN) catches a missing
    // token. Verify all three Jira essentials flow through REQUIRED_KEYS for
    // the metrolinx project so a missing token aborts before spending credits.
    const metrolinxConfig = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
    );
    expect(metrolinxConfig).toMatch(/REQUIRED_KEYS=.*JIRA_TOKEN/);
    // JIRA_URL and JIRA_PROJECT_KEY must be set in the config (not just inherited
    // from a secrets file that might have the wrong values)
    expect(metrolinxConfig).toMatch(/^JIRA_URL=https:\/\/metrolinx\.atlassian\.net/m);
    expect(metrolinxConfig).toMatch(/^JIRA_PROJECT_KEY=AMSD/m);
  });

  it('REQUIRED_KEYS validation loop uses indirect expansion to check each key', () => {
    // Ensure the validation loop actually checks whether the variable is set,
    // not just whether the key name exists in the string.
    const validationBlock = (() => {
      const idx = launcherSrc.indexOf('REQUIRED_KEYS');
      const loopIdx = launcherSrc.indexOf('for _key in', idx);
      expect(loopIdx).toBeGreaterThan(-1);
      return launcherSrc.slice(loopIdx, loopIdx + 300);
    })();
    // Must use indirect expansion ${!_key:-} to resolve the variable by name
    expect(validationBlock).toMatch(/\$\{!_key/);
    expect(validationBlock).toMatch(/fail/);
  });
});

// ── Bug 6: brownfield must never run scaffold phase ───────────────────────────
describe('orchestrate.sh — brownfield runs core only, never scaffold (Bug 6)', () => {
  it('EPAM_PHASES=core in metrolinx config', () => {
    const metrolinxConfig = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
    );
    expect(metrolinxConfig).toMatch(/^EPAM_PHASES="?core"?$/m);
    expect(metrolinxConfig).not.toMatch(/scaffold/);
  });

  it('orchestrate.sh iterates only the phases declared in EPAM_PHASES (no hardcoded scaffold)', () => {
    // The phase loop must use $PHASES (sourced from config), not hardcode phase names.
    const phaseLoop = (() => {
      const idx = launcherSrc.indexOf('Execute phases');
      expect(idx).toBeGreaterThan(-1);
      return launcherSrc.slice(idx, idx + 300);
    })();
    expect(phaseLoop).toMatch(/for _phase in \$PHASES/);
    expect(phaseLoop).toMatch(/run_phase "\$_phase"/);
    // Must NOT hardcode "scaffold" or "core" in the phase loop
    expect(phaseLoop).not.toMatch(/run_phase "scaffold"/);
    expect(phaseLoop).not.toMatch(/run_phase "core"/);
  });

  it('EPAM_PHASES=scaffold core in skyscanner config', () => {
    const skyscanner = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/skyscanner/config.env'), 'utf8'
    );
    expect(skyscanner).toMatch(/^EPAM_PHASES="scaffold core"$/m);
  });
});

// ── Bug 7: JIRA_BOARD_ID must NOT be set for Metrolinx — agile API 403 ──────────
// The Metrolinx Atlassian admin has restricted API token access to the Jira
// Software agile API (/rest/agile/1.0/board/...).  When JIRA_BOARD_ID is set,
// jira-client.js::getProjectIssues() routes to getBoardIssues() which calls that
// endpoint → 403 → catch block writes [] → ISSUE_COUNT=0 → exit 1.
// The JQL path (/rest/api/3/search/jql) is not admin-restricted and is correct.
describe('jira-client.js — JIRA_BOARD_ID routing (Bug 7)', () => {
  const jiraClientSrc = readFileSync(
    join(REPO_ROOT, 'orchestrations/scripts/lib/jira-client.js'), 'utf8'
  );

  it('metrolinx config explicitly clears JIRA_BOARD_ID to override the value in jira/.env', () => {
    const metrolinxConfig = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
    );
    // orchestrations/jira/.env sets JIRA_BOARD_ID=2 (for the KAN project).
    // Without an explicit override, that value leaks into the metrolinx run and
    // routes getProjectIssues() to /rest/agile/1.0/board/2/issue → 403.
    // The metrolinx config MUST set JIRA_BOARD_ID= (empty) to clear it.
    const lines = metrolinxConfig.split('\n').filter(l => !l.trimStart().startsWith('#'));
    const boardIdLine = lines.find(l => /^JIRA_BOARD_ID=/.test(l.trim()));
    expect(boardIdLine).toBeDefined();
    // Value must be empty — any non-empty value routes to the agile API
    expect(boardIdLine!.trim()).toBe('JIRA_BOARD_ID=');
  });

  it('jira-client.js routes to agile API when JIRA_BOARD_ID is set', () => {
    // When boardId is set, getProjectIssues() calls getBoardIssues() unconditionally.
    // getBoardIssues hits /rest/agile/1.0/board/${boardId}/issue — NOT /rest/api/3/...
    // Note: JIRA_JQL custom-query block precedes boardId block; use a larger slice.
    const routingBlock = (() => {
      const idx = jiraClientSrc.indexOf('getProjectIssues(projectKey');
      expect(idx).toBeGreaterThan(-1);
      return jiraClientSrc.slice(idx, idx + 800);
    })();
    expect(routingBlock).toMatch(/JIRA_BOARD_ID/);
    expect(routingBlock).toMatch(/getBoardIssues/);
    // When JIRA_BOARD_ID is absent, the function must NOT call getBoardIssues
    // (the if-boardId block is the only place it's called from getProjectIssues)
    const afterBoardIdCheck = routingBlock.slice(routingBlock.indexOf('if (boardId)'));
    // The early-return inside the if block means the JQL path is the fallback
    expect(afterBoardIdCheck).toMatch(/return getBoardIssues/);
  });

  it('jira-client.js falls back to JQL search (/rest/api/3/search/jql) when JIRA_BOARD_ID absent', () => {
    // JQL search is the correct path for Metrolinx — standard REST API,
    // not admin-restricted, works with a basic API token.
    // Endpoint changed from deprecated /rest/api/3/search to /rest/api/3/search/jql.
    expect(jiraClientSrc).toMatch(/rest\/api\/3\/search\/jql/);
    // JQL is constructed inside getProjectIssues with project key + issuetype filter
    const jqlFn = (() => {
      const idx = jiraClientSrc.indexOf('getProjectIssues(projectKey');
      expect(idx).toBeGreaterThan(-1);
      return jiraClientSrc.slice(idx, idx + 800);
    })();
    expect(jqlFn).toMatch(/issuetype/);
    expect(jqlFn).toMatch(/project/);
  });

  it('getBoardIssues uses /rest/agile/1.0/board path (the restricted endpoint)', () => {
    const boardFn = (() => {
      const idx = jiraClientSrc.indexOf('getBoardIssues(boardId');
      expect(idx).toBeGreaterThan(-1);
      return jiraClientSrc.slice(idx, idx + 300);
    })();
    expect(boardFn).toMatch(/rest\/agile\/1\.0\/board/);
  });
});

// ── Structural: ingest-jira-tickets.sh failure modes ─────────────────────────
describe('ingest-jira-tickets.sh — all failure paths exit non-zero', () => {
  const ingestSrc = readFileSync(
    join(REPO_ROOT, 'orchestrations/scripts/ingest-jira-tickets.sh'), 'utf8'
  );

  it('exits 1 when JIRA_URL, JIRA_EMAIL, or JIRA_TOKEN is unset', () => {
    // The validation block must be present and exit 1 — not just warn.
    const validationBlock = (() => {
      const idx = ingestSrc.indexOf('JIRA_URL:-}') !== -1
        ? ingestSrc.indexOf('JIRA_URL:-}')
        : ingestSrc.indexOf('JIRA_URL:-');
      const blockStart = ingestSrc.lastIndexOf('if', idx);
      expect(blockStart).toBeGreaterThan(-1);
      return ingestSrc.slice(blockStart, blockStart + 300);
    })();
    expect(validationBlock).toMatch(/exit 1/);
    expect(validationBlock).toMatch(/JIRA_URL/);
    expect(validationBlock).toMatch(/JIRA_TOKEN/);
  });

  it('brownfield: exits 1 when EPAM_BROWNFIELD=1 but JIRA_CODELINE_ROOT is unset', () => {
    // codeline-discovery.js needs JIRA_CODELINE_ROOT — must abort cleanly, not segfault.
    const brownfieldBlock = (() => {
      const idx = ingestSrc.indexOf('EPAM_BROWNFIELD:-0}" = "1"');
      expect(idx).toBeGreaterThan(-1);
      return ingestSrc.slice(idx, idx + 400);
    })();
    expect(brownfieldBlock).toMatch(/JIRA_CODELINE_ROOT/);
    expect(brownfieldBlock).toMatch(/exit 1/);
  });

  it('brownfield: exits 1 when JIRA_CODELINE_ROOT path does not exist on disk', () => {
    const diskCheckBlock = (() => {
      const idx = ingestSrc.indexOf('! -d.*JIRA_CODELINE_ROOT') !== -1
        ? ingestSrc.indexOf('! -d')
        : ingestSrc.indexOf('-d "${JIRA_CODELINE_ROOT');
      if (idx === -1) return ingestSrc.slice(ingestSrc.indexOf('JIRA_CODELINE_ROOT'), ingestSrc.indexOf('JIRA_CODELINE_ROOT') + 500);
      return ingestSrc.slice(Math.max(0, idx - 50), idx + 300);
    })();
    expect(diskCheckBlock).toMatch(/JIRA_CODELINE_ROOT/);
    expect(diskCheckBlock).toMatch(/exit 1/);
  });

  it('codeline discovery failure exits 1 (codeline-discovery.js non-zero → ingest aborts)', () => {
    const discoveryBlock = (() => {
      const idx = ingestSrc.indexOf('DISCOVERY_EXIT');
      expect(idx).toBeGreaterThan(-1);
      return ingestSrc.slice(idx, idx + 500);
    })();
    expect(discoveryBlock).toMatch(/exit 1/);
    expect(discoveryBlock).toMatch(/DISCOVERY_EXIT/);
  });

  it('AC gate unexpected failure (exit != 0 and != 2) exits 1 immediately', () => {
    // Only exit 2 (insufficient ACs) is a managed halt. Any other non-zero exit
    // is unexpected and must abort the run rather than continue to PRD synthesis.
    const gateBlock = (() => {
      const idx = ingestSrc.indexOf('GATE_EXIT');
      expect(idx).toBeGreaterThan(-1);
      return ingestSrc.slice(idx, idx + 500);
    })();
    expect(gateBlock).toMatch(/GATE_EXIT.*2|2.*GATE_EXIT/);
    expect(gateBlock).toMatch(/exit 1/);
  });

  it('exit 2 on insufficient ACs (pipeline-halt, not an error)', () => {
    // exit 2 is the signal to the caller that human approval is needed —
    // _run_jira_pipeline returns 2, orchestrate.sh must not retry this.
    // Anchor on the if-block that gates on INSUFFICIENT_COUNT, not the var assignment.
    const insufficientBlock = (() => {
      const idx = ingestSrc.indexOf('INSUFFICIENT_COUNT" -gt "0"');
      expect(idx).toBeGreaterThan(-1);
      return ingestSrc.slice(idx, idx + 600);
    })();
    expect(insufficientBlock).toMatch(/exit 2/);
  });
});

// ── Structural: _run_jira_pipeline error propagation ─────────────────────────
describe('run-agent-orchestration.sh — _run_jira_pipeline AC gate exit-2 propagation', () => {
  it('returns exit 2 when ingest exits 2 (insufficient ACs — human approval needed)', () => {
    // The pipeline function must propagate exit 2 cleanly, not map it to exit 1.
    // Caller (orchestrate.sh run_phase) currently falls through on exit 2 — the
    // top-level `_run_jira_pipeline; exit $?` propagates it to the setsid group.
    const pipelineFn = (() => {
      const start = orchSrc.indexOf('_run_jira_pipeline()');
      expect(start).toBeGreaterThan(-1);
      let depth = 0, i = start;
      while (i < orchSrc.length) {
        if (orchSrc[i] === '{') depth++;
        else if (orchSrc[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      return orchSrc.slice(start, i + 1);
    })();
    const acGateBlock = pipelineFn.slice(
      pipelineFn.indexOf('_ingest_exit.*2|= "2"') !== -1
        ? pipelineFn.indexOf('_ingest_exit.*2')
        : pipelineFn.indexOf('"2"')
    );
    expect(pipelineFn).toMatch(/return 2/);
    expect(pipelineFn).toMatch(/_ingest_exit.*=.*"2"|"2".*_ingest_exit/);
  });

  it('validates JIRA_CODELINE_ROOT required for brownfield before calling ingest', () => {
    const pipelineFn = (() => {
      const start = orchSrc.indexOf('_run_jira_pipeline()');
      let depth = 0, i = start;
      while (i < orchSrc.length) {
        if (orchSrc[i] === '{') depth++;
        else if (orchSrc[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      return orchSrc.slice(start, i + 1);
    })();
    expect(pipelineFn).toMatch(/JIRA_CODELINE_ROOT/);
    expect(pipelineFn).toMatch(/EPAM_BROWNFIELD/);
    expect(pipelineFn).toMatch(/_missing/);
  });

  it('_run_jira_pipeline injects scaffold:[] into synthesized PRD so skill assessment fires before core', () => {
    // The tier3 launcher always calls run_phase "scaffold" then run_phase "core".
    // Jira ingest only writes implementationOrder.core — scaffold is absent.
    // Without the injection: run_phase "scaffold" → "Phase not found" → exit 1.
    // With the injection: scaffold phase runs Step 3 (pre-phase skill assessment)
    // over ALL AMSD stories, assessing and injecting project-specific skills into
    // each agent's profile BEFORE implementation begins. Agent identities (profiles)
    // come from profiles.json.original; only skills are project-specific.
    const pipelineFn = (() => {
      const start = orchSrc.indexOf('_run_jira_pipeline()');
      let depth = 0, i = start;
      while (i < orchSrc.length) {
        if (orchSrc[i] === '{') depth++;
        else if (orchSrc[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      return orchSrc.slice(start, i + 1);
    })();
    // Must inject scaffold key into implementationOrder
    expect(pipelineFn).toMatch(/scaffold.*\[\]|implementationOrder.*scaffold/);
    // Must happen AFTER successful ingest (after the _ingest_exit check) and BEFORE
    // _run_codeline_loop. Asserted by ORDER, not by a fixed-size window: the window was 1000
    // characters, so inserting the agent-mint step between the injection and the loop moved
    // 'scaffold' out of view and failed a test whose stated requirement still held.
    const idxIngest = pipelineFn.indexOf('_ingest_exit');
    const idxScaffold = pipelineFn.indexOf('scaffold');
    const idxLoop = pipelineFn.indexOf('_run_codeline_loop');
    expect(idxIngest, 'the ingest exit check is gone').toBeGreaterThan(-1);
    expect(idxScaffold, 'the scaffold phase is never injected').toBeGreaterThan(idxIngest);
    expect(idxLoop, 'the codeline loop is gone').toBeGreaterThan(idxScaffold);
  });
});

// ── Two scaffold flows: greenfield (builds project) vs brownfield (skill assessment only) ─────
//
// Both flows share:
//   - run_pre_phase_assessment() (Step 3) — same function, same call site (line ~3280)
//   - story execution loop — same code, 0 stories for brownfield scaffold
//   - gate checks, PRD remediation
//
// Divergent paths:
//   - Worktree setup: greenfield tears down + git init; brownfield skips (EPAM_BROWNFIELD guard)
//   - PRD source: greenfield reads canonical; brownfield reads Jira-synthesized PRD
//   - Story content: greenfield has INIT-001/INIT-002 stories; brownfield has scaffold:[]
describe('scaffold phase — greenfield vs brownfield two-flow design', () => {
  it('run_pre_phase_assessment is defined once and shared by both flows', () => {
    // Single definition, called in the shared phase execution path.
    // Both greenfield (INIT stories) and brownfield (0 stories) hit this same code.
    const defCount = (orchSrc.match(/^run_pre_phase_assessment\(\)/gm) || []).length;
    expect(defCount).toBe(1);
    // Called in the shared phase body (not inside a brownfield/greenfield branch)
    const callIdx = orchSrc.indexOf('run_pre_phase_assessment "$PHASE"');
    expect(callIdx).toBeGreaterThan(-1);
  });

  it('greenfield: worktree teardown + git init only runs when EPAM_BROWNFIELD != 1', () => {
    // rm -rf + git init are inside `if [ "${EPAM_BROWNFIELD:-0}" != "1" ]` so
    // brownfield never destroys the existing Metrolinx repository.
    const teardownGuard = orchSrc.indexOf('EPAM_BROWNFIELD:-0}" != "1"');
    expect(teardownGuard).toBeGreaterThan(-1);
    // Teardown must be INSIDE that guard (not before it)
    const guardBlock = orchSrc.slice(teardownGuard, teardownGuard + 600);
    expect(guardBlock).toMatch(/rm -rf|git.*init/);
  });

  it('brownfield: scaffold phase injected as empty array — no project creation, skill assessment only', () => {
    // _run_jira_pipeline injects scaffold:[] so the tier3 scaffold phase call
    // fires run_pre_phase_assessment but runs 0 implementation stories.
    // This is how brownfield gets project-specific skills without building a new project.
    const pipelineFn = orchSrc.slice(orchSrc.indexOf('_run_jira_pipeline()'));
    expect(pipelineFn).toMatch(/scaffold.*\[\]/);
  });

  it('greenfield: JIRA_PIPELINE is NOT set so _run_jira_pipeline never executes', () => {
    // Greenfield projects (skyscanner config.env) do not set JIRA_PIPELINE=1.
    // The entry-point guard fires _run_jira_pipeline only when JIRA_PIPELINE=1.
    const skycfg = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/skyscanner/config.env'), 'utf8'
    );
    // Must not set JIRA_PIPELINE to 1
    expect(skycfg).not.toMatch(/^JIRA_PIPELINE=1$/m);
  });

  it('brownfield: JIRA_PIPELINE=1 is set so ingest → skill-assess → core runs', () => {
    const metrocfg = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
    );
    expect(metrocfg).toMatch(/^JIRA_PIPELINE=1$/m);
    expect(metrocfg).toMatch(/^EPAM_BROWNFIELD=1$/m);
  });
});

// ── Structural: orchestrate.sh API key aliasing ───────────────────────────────
describe('orchestrate.sh — API key aliasing and export', () => {
  it('exports EPAM_API_KEY_MINIMAX from MINIMAX_API_KEY', () => {
    // run-agent-orchestration.sh and ai-run.sh read EPAM_API_KEY_MINIMAX.
    // The project config declares MINIMAX_API_KEY (user-facing name).
    // orchestrate.sh bridges them so both names work in subprocesses.
    expect(launcherSrc).toMatch(/EPAM_API_KEY_MINIMAX.*MINIMAX_API_KEY|MINIMAX_API_KEY.*EPAM_API_KEY_MINIMAX/);
  });

  it('exports EPAM_API_KEY_OPENROUTER from OPENROUTER_API_KEY', () => {
    expect(launcherSrc).toMatch(/EPAM_API_KEY_OPENROUTER.*OPENROUTER_API_KEY|OPENROUTER_API_KEY.*EPAM_API_KEY_OPENROUTER/);
  });

  it('exports using set -a so all config vars flow to run-agent-orchestration.sh subprocesses', () => {
    // Without set -a around the alias block, subprocesses inherit nothing.
    const aliasBlock = (() => {
      const idx = launcherSrc.indexOf('EPAM_API_KEY_MINIMAX');
      const setaIdx = launcherSrc.lastIndexOf('set -a', idx);
      const setplusIdx = launcherSrc.indexOf('set +a', idx);
      return launcherSrc.slice(setaIdx, setplusIdx + 6);
    })();
    expect(aliasBlock).toMatch(/^set -a/m);
    expect(aliasBlock).toMatch(/EPAM_API_KEY_MINIMAX/);
    expect(aliasBlock).toMatch(/^set \+a/m);
  });
});

// ── Structural: orchestrate.sh run_phase self-heal ────────────────────────────
describe('orchestrate.sh — run_phase exit-2 self-heal retry', () => {
  it('re-runs the phase with SKIP_GATE_REMEDIATION=1 on exit 2', () => {
    // exit 2 from run-agent-orchestration.sh means "gate remediation applied,
    // please reset and retry." orchestrate.sh must:
    //   (a) detect exit 2 from the phase
    //   (b) call prd-remediate.sh with --mid-phase-retry (greenfield only)
    //   (c) re-invoke run-agent-orchestration.sh with SKIP_GATE_REMEDIATION=1
    const runPhaseFn = (() => {
      const idx = launcherSrc.indexOf('run_phase()');
      expect(idx).toBeGreaterThan(-1);
      return launcherSrc.slice(idx, idx + 1200);
    })();
    expect(runPhaseFn).toMatch(/phase_exit.*2|2.*phase_exit/);
    expect(runPhaseFn).toMatch(/SKIP_GATE_REMEDIATION=1/);
    expect(runPhaseFn).toMatch(/self-heal/i);
  });

  it('fails the run if self-heal retry also fails (no infinite loop)', () => {
    const runPhaseFn = launcherSrc.slice(
      launcherSrc.indexOf('run_phase()'),
      launcherSrc.indexOf('run_phase()') + 1800
    );
    // After the self-heal retry, a non-zero exit must abort — not loop again.
    expect(runPhaseFn).toMatch(/fail.*after self-heal|self-heal.*fail/i);
  });

  it('phase loop calls run_phase for each phase in $PHASES, never hardcodes phase names', () => {
    const phaseLoop = (() => {
      const idx = launcherSrc.indexOf('Execute phases');
      expect(idx).toBeGreaterThan(-1);
      return launcherSrc.slice(idx, idx + 400);
    })();
    expect(phaseLoop).toMatch(/for _phase in \$PHASES/);
    expect(phaseLoop).not.toMatch(/"scaffold"/);
    expect(phaseLoop).not.toMatch(/"core"/);
  });
});

// ── Structural: orchestrate.sh PHASE_OVERRIDE ────────────────────────────────
describe('orchestrate.sh — PHASE_OVERRIDE takes priority over EPAM_PHASES', () => {
  it('PHASES resolves to PHASE_OVERRIDE when --phase flag was passed', () => {
    // The --phase CLI flag lets a developer re-run a single phase without editing config.
    const phasesLine = (() => {
      const idx = launcherSrc.indexOf('PHASES=');
      expect(idx).toBeGreaterThan(-1);
      return launcherSrc.slice(idx, idx + 100);
    })();
    // Must be: PHASES="${PHASE_OVERRIDE:-${EPAM_PHASES:-core}}"
    // i.e., PHASE_OVERRIDE wins, then EPAM_PHASES, then "core" as ultimate default.
    expect(phasesLine).toMatch(/PHASE_OVERRIDE/);
    expect(phasesLine).toMatch(/EPAM_PHASES/);
    expect(phasesLine).toMatch(/core/); // default when neither is set
  });
});

// ── Structural: orchestrate.sh greenfield invariants ─────────────────────────
describe('orchestrate.sh — greenfield required config validation', () => {
  it('fails immediately when OUTPUT_DIR is unset in greenfield mode', () => {
    const greenfieldGuard = (() => {
      const idx = launcherSrc.indexOf('OUTPUT_DIR.*fail|fail.*OUTPUT_DIR');
      if (idx !== -1) return launcherSrc.slice(idx, idx + 200);
      // Search for the actual guard pattern
      const checkIdx = launcherSrc.indexOf('OUTPUT_DIR:-}') !== -1
        ? launcherSrc.indexOf('OUTPUT_DIR:-}')
        : launcherSrc.indexOf('"${OUTPUT_DIR:-}"');
      expect(checkIdx).toBeGreaterThan(-1);
      return launcherSrc.slice(Math.max(0, checkIdx - 50), checkIdx + 300);
    })();
    expect(greenfieldGuard).toMatch(/OUTPUT_DIR/);
    expect(greenfieldGuard).toMatch(/fail/);
  });

  it('fails immediately when PRD_CANONICAL is unset in greenfield mode', () => {
    expect(launcherSrc).toMatch(/PRD_CANONICAL/);
    // Must be guarded for greenfield before teardown begins
    const canonicalGuard = (() => {
      const idx = launcherSrc.indexOf('PRD_CANONICAL');
      return launcherSrc.slice(idx, idx + 400);
    })();
    expect(canonicalGuard).toMatch(/fail/);
  });

  it('copies dep-check, contract-gen, and known-fixes manifests from project dir to OUTPUT_DIR/.epam', () => {
    // These manifests are consumed by scaffold phase agents to know what stack
    // to generate. They must come from the project config dir, not be hardcoded.
    const manifestBlock = (() => {
      // Search for the copy loop, not the header comment
      const idx = launcherSrc.indexOf('Copy stack manifests');
      expect(idx).toBeGreaterThan(-1);
      return launcherSrc.slice(idx, idx + 600);
    })();
    expect(manifestBlock).toMatch(/dep-check/);
    expect(manifestBlock).toMatch(/contract-gen/);
    expect(manifestBlock).toMatch(/known-fixes/);
    expect(manifestBlock).toMatch(/\.epam/);
  });

  it('skyscanner/dep-check.json exists for greenfield stack manifests', () => {
    const depCheck = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/skyscanner/dep-check.json'), 'utf8'
    );
    const parsed = JSON.parse(depCheck);
    expect(parsed).toBeTruthy();
  });
});

// ── Bug 8: every run must reset PRD canonical + profiles.json ────────────────
// Live incident 2026-07-21: brownfield run used the old Skyscanner PRD because
// (a) Jira ingest failed silently (Bug 4b) and (b) there was no canonical restore
// before launch. Fix: EVERY run — greenfield and brownfield — restores PRD and
// profiles.json before calling run-agent-orchestration.sh.
describe('orchestrate.sh — pre-launch canonical restore for every run (Bug 8)', () => {
  it('profiles.json restore block exists and is outside any mode guard (runs for all modes)', () => {
    // profiles.json must be restored on every run — not gated on EPAM_BROWNFIELD.
    const profilesRestoreIdx = launcherSrc.indexOf('profiles.json restored from canonical');
    const runPhaseLoopIdx    = launcherSrc.indexOf('for _phase in $PHASES');
    expect(profilesRestoreIdx).toBeGreaterThan(-1);
    expect(runPhaseLoopIdx).toBeGreaterThan(-1);
    // Must happen before the phase loop
    expect(profilesRestoreIdx).toBeLessThan(runPhaseLoopIdx);
  });

  it('brownfield writes empty sentinel PRD (not greenfield canonical) before Jira ingest', () => {
    // Brownfield must write an empty {stories:[]} sentinel — never the greenfield
    // canonical (which belongs to a different project and would be "old data").
    // Jira ingest then overwrites this with the real AMSD stories.
    // The sentinel MUST include project.outputDir=JIRA_CODELINE_ROOT so PROJECT_ROOT
    // resolves to the existing codeline repo and not the epam-cli repo (safety guard).
    const anchor = 'Jira ingest will write the live PRD';
    const idx = launcherSrc.indexOf(anchor);
    expect(idx).toBeGreaterThan(-1); // anchor must exist
    const brownfieldBlock = launcherSrc.slice(Math.max(0, idx - 500), Math.min(launcherSrc.length, idx + 100));
    expect(brownfieldBlock).toMatch(/PRD_FILE/);
    // Must write an empty stories array, not copy from canonical
    expect(brownfieldBlock).toMatch(/"stories":\[\]/);
    // Must include outputDir so PROJECT_ROOT guard doesn't fire
    expect(brownfieldBlock).toMatch(/outputDir.*JIRA_CODELINE_ROOT|JIRA_CODELINE_ROOT.*outputDir/);
    // Must NOT copy the greenfield canonical (that belongs to skyscanner, not metrolinx)
    expect(brownfieldBlock).not.toMatch(/cp.*PRD_CANONICAL/);
  });

  it('brownfield PRD clear happens before the phase loop', () => {
    const brownfieldRestoreIdx = launcherSrc.indexOf('Jira ingest will write the live PRD');
    const runPhaseLoopIdx      = launcherSrc.indexOf('for _phase in $PHASES');
    expect(brownfieldRestoreIdx).toBeGreaterThan(-1);
    expect(runPhaseLoopIdx).toBeGreaterThan(-1);
    expect(brownfieldRestoreIdx).toBeLessThan(runPhaseLoopIdx);
  });
});

// ── Live: PIPESTATUS propagation from ingest-jira-tickets.sh ─────────────────
// Verifies that a failing bash subprocess's exit code actually reaches
// _ingest_exit even when piped through tee (no pipefail set in orch script).
describe('_run_jira_pipeline — live PIPESTATUS capture test', () => {
  it('PIPESTATUS[0] after a pipeline captures the left-hand exit code, not tee exit code', () => {
    // Simulate: cmd_that_exits_1 | tee /dev/null; echo PIPESTATUS=$?
    // Without pipefail: PIPESTATUS[0] on the line AFTER the pipeline captures the
    // exit code of the LEFT-HAND command (bash ingest.sh), not tee.
    const result = execSync(
      // Escape $ so JS template literal doesn't interpolate it — bash evaluates it.
      `bash -c 'false | tee /dev/null; echo "PS=\${PIPESTATUS[0]}"'`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    expect(result).toBe('PS=1');
  });

  it('old pattern `false | tee ... || VAR=...` leaves VAR=0 WITHOUT pipefail (the bug)', () => {
    // Without pipefail, tee exits 0, the pipeline exits 0, so the || never fires.
    // VAR stays at 0 even though false exited 1. This was the root cause of the
    // 2026-07-21 incident where _ingest_exit stayed 0 after ingest failed.
    const result = execSync(
      `bash -c 'VAR=0; false | tee /dev/null || VAR=FIRED; echo "VAR=\$VAR"'`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    // MUST be VAR=0 — the || never fires because tee exits 0
    expect(result).toBe('VAR=0');
  });

  it('orch script does NOT use the || capture pattern for _ingest_exit', () => {
    // Verify the fix is in place: no `| tee ... || _ingest_exit=` in the source.
    expect(orchSrc).not.toMatch(/tee.*\|\|.*_ingest_exit/);
    // And the safe pattern IS present
    expect(orchSrc).toMatch(/_ingest_exit="\$\{PIPESTATUS\[0\]\}"/);
  });
});

// ── Sanity: project configs are well-formed ───────────────────────────────────
describe('project configs — required fields present', () => {
  const projects = ['skyscanner', 'metrolinx'];

  for (const project of projects) {
    const configPath = join(REPO_ROOT, `orchestrations/projects/${project}/config.env`);
    const configSrc = readFileSync(configPath, 'utf8');

    it(`${project}/config.env declares PROJECT_NAME`, () => {
      expect(configSrc).toMatch(new RegExp(`^PROJECT_NAME=${project}`, 'm'));
    });

    it(`${project}/config.env declares EPAM_BROWNFIELD`, () => {
      expect(configSrc).toMatch(/^EPAM_BROWNFIELD=/m);
    });

    it(`${project}/config.env declares EPAM_PHASES`, () => {
      expect(configSrc).toMatch(/^EPAM_PHASES=/m);
    });

    it(`${project}/config.env declares REQUIRED_KEYS`, () => {
      expect(configSrc).toMatch(/^REQUIRED_KEYS=/m);
    });
  }

  it('metrolinx/config.env declares SECRETS_FILE pointing at jira/.env', () => {
    const metrolinxConfig = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
    );
    expect(metrolinxConfig).toMatch(/^SECRETS_FILE=.*jira.*\.env/m);
  });

  it('metrolinx/config.env has EPAM_BROWNFIELD=1', () => {
    const metrolinxConfig = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
    );
    expect(metrolinxConfig).toMatch(/^EPAM_BROWNFIELD=1/m);
  });

  it('skyscanner/config.env has EPAM_BROWNFIELD=0', () => {
    const skyscanner = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/skyscanner/config.env'), 'utf8'
    );
    expect(skyscanner).toMatch(/^EPAM_BROWNFIELD=0/m);
  });

  it('skyscanner/config.env has EPAM_PHASES including scaffold', () => {
    const skyscanner = readFileSync(
      join(REPO_ROOT, 'orchestrations/projects/skyscanner/config.env'), 'utf8'
    );
    expect(skyscanner).toMatch(/^EPAM_PHASES=.*scaffold/m);
  });
});
