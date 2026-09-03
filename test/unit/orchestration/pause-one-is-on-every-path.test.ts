/**
 * PAUSE 1 IS A HUMAN REVIEW POINT ON EVERY PATH, NOT JUST THE INGESTING ONE.
 *
 * The roster pause existed only inline inside _run_jira_pipeline, so it was reachable solely by a
 * project that ingests from a tracker. A project that AUTHORS its PRD takes the other
 * _run_agent_mint call site and ran straight into the spec phase.
 *
 * Live 2026-08-27: mock3 was launched with EPAM_PAUSE_AFTER_AGENT_MINT=1 correctly set — verified
 * present in the running process's own environment — and never stopped. The operator was promised
 * a review point the shape of their project could not reach, and the run spent its way into the
 * spec phase unattended.
 *
 * The pause is about the roster and the assignments. Every path produces those, so every path
 * stops. Asserted by EXECUTING the extracted function, and by deriving the call sites rather than
 * naming line numbers, so a third mint call site added later is covered too.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real function, lifted from the script. */
function pauseFn(): string {
  const at = SRC.indexOf('_pause_after_agent_mint() {');
  expect(at, 'the pause function is gone').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}\n', at);
  return SRC.slice(at, end + 3);
}

/** Run it for real, with the surrounding script's helpers stubbed. */
function runPause(env: Record<string, string>): { out: string; checkpointed: boolean } {
  const d = mkdtempSync(join(tmpdir(), 'pause1-')); dirs.push(d);
  const logDir = join(d, 'logs'); mkdirSync(logDir, { recursive: true });
  const marker = join(d, 'checkpoint-was-saved');

  const sh = join(d, 'run.sh');
  writeFileSync(sh,
    '#!/usr/bin/env bash\n'
    + 'info(){ echo "[info] $*"; }\nwarning(){ echo "[warn] $*"; }\n'
    + `save_run_checkpoint(){ echo "saved" > ${JSON.stringify(marker)}; echo "${d}/ckpt"; }\n`
    + 'is_truthy(){ case "$(printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]")" in 1|true|yes|on) return 0;; *) return 1;; esac; }\n'
    + 'should_pause_after_agent_mint(){ is_truthy "${EPAM_PAUSE_AFTER_AGENT_MINT:-}"; }\n'
    + `GREEN=""; RED=""; NC=""; LOG_DIR=${JSON.stringify(logDir)}; EPAM_AGENTS_DIR=${JSON.stringify(d)};\n`
    + 'ORCH_RUN_ID="TEST-RUN"; PHASE="core";\n'
    + pauseFn() + '\n_pause_after_agent_mint\n');

  const r = spawnSync('bash', [sh], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  return { out: (r.stdout || '') + (r.stderr || ''), checkpointed: existsSync(marker) };
}

describe('the pause function actually pauses', () => {
  it('with EPAM_PAUSE_AFTER_AGENT_MINT=1 it announces the pause and saves a checkpoint', () => {
    const { out, checkpointed } = runPause({ EPAM_PAUSE_AFTER_AGENT_MINT: '1' });
    expect(out, 'no pause banner — the operator is not told the run stopped')
      .toMatch(/agents minted and assigned, spec NOT started/);
    expect(checkpointed, 'no post-roster checkpoint, so the run could not be resumed').toBe(true);
  });

  it('with the flag unset it does nothing at all', () => {
    const { out, checkpointed } = runPause({ EPAM_PAUSE_AFTER_AGENT_MINT: '' });
    expect(out).not.toMatch(/spec NOT started/);
    expect(checkpointed).toBe(false);
  });
});

describe('THE DEFECT: the authored-PRD path could not reach the pause', () => {
  it('EVERY _run_agent_mint call site is followed by the pause', () => {
    // Derived, not line numbers: a mint call added later is covered by this too.
    const lines = SRC.split('\n');
    const callSites: number[] = [];
    lines.forEach((l, i) => {
      if (/^\s*_run_agent_mint\s+"/.test(l)) callSites.push(i);
    });
    expect(callSites.length, 'no mint call sites found — the scan is broken').toBeGreaterThan(1);

    const unguarded = callSites.filter((i) => {
      // the pause must appear within a few lines of the mint returning
      const window = lines.slice(i, i + 8).join('\n');
      return !/_pause_after_agent_mint/.test(window);
    });
    expect(unguarded.map((i) => `line ${i + 1}: ${lines[i].trim()}`),
      'a path mints a roster and assigns stories, then runs on without offering the review point')
      .toEqual([]);
  });

  it('the pause is defined once, not copied per path', () => {
    const defs = (SRC.match(/^_pause_after_agent_mint\(\) \{/gm) || []).length;
    expect(defs, 'two copies of the pause is how the two paths drifted apart before').toBe(1);
  });
});
