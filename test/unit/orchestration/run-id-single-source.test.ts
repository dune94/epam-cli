/**
 * B5 — one run must have ONE run id.
 *
 * Found live 2026-07-24: `guarded-step-retries.jsonl` from a single run carried TWO
 * different ids —
 *     "runId":"20260724T153635Z"   (ORCH_RUN_ID, exported by run-agent-orchestration.sh)
 *     "runId":"20260724T193720Z"   (minted independently inside spec-mode-runner.js)
 *
 * Anything joining on runId (cost roll-ups, retry history, the Langfuse per-run
 * session grouping shipped the same day) silently splits one run into two. That is
 * the same class of defect as the null sessionId it was meant to fix.
 *
 * Two distinct causes, both covered here:
 *   1. spec-mode-runner.js:670 built a runId from `new Date()` without consulting
 *      ORCH_RUN_ID, while :3772 correctly preferred it — so the same file used two
 *      different identities depending on which code path ran.
 *   2. ORCH_RUN_ID was generated with `date +%Y%m%dT%H%M%SZ` — LOCAL time with a
 *      literal "Z" suffix, which asserts UTC. A timestamp that lies about its zone
 *      makes the two ids look like different runs hours apart (15:36 vs 19:37) when
 *      they are the same instant.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('B5 — single source of truth for the run id', () => {
  it('spec-mode-runner never mints a runId without first consulting ORCH_RUN_ID', () => {
    // Every `const runId = ...` must reference the env var. A bare new Date()
    // assignment is the bug.
    const assigns = [...SPEC.matchAll(/const\s+runId\s*=\s*([^;]+);/g)].map(m => m[1]);
    expect(assigns.length).toBeGreaterThan(0);
    for (const a of assigns) {
      expect(a, `runId assigned without ORCH_RUN_ID: ${a}`).toMatch(/ORCH_RUN_ID/);
    }
  });

  it('ORCH_RUN_ID is generated in UTC, matching the Z it advertises', () => {
    const m = ORCH.match(/export ORCH_RUN_ID="\$\{ORCH_RUN_ID:-\$\(date([^)]*)\)\}"/);
    expect(m, 'ORCH_RUN_ID assignment not found').toBeTruthy();
    // `date -u` (or an explicit UTC form) — a local-time value labelled Z is a lie
    // that makes one run look like two, hours apart.
    expect(m![1]).toMatch(/-u\b/);
  });

  it('ORCH_RUN_ID is still exported so children inherit the one id', () => {
    expect(ORCH).toMatch(/export\s+ORCH_RUN_ID=/);
  });
});
