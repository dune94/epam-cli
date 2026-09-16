/**
 * THE PRE-PHASE ASSESSMENT RUNS, AND ITS SCHEMA STAYS ITS OWN.
 *
 * run_pre_phase_assessment invoked its runner as
 *     export EPAM_ALLOWED_WRITE_PATHS="" EPAM_MAX_TOOL_CALLS=… EPAM_RESPONSE_SCHEMA="…" \
 *     run_orch_prompt_with_tools "$prompt" "phase-assessment"
 * — one command: `export` with the function name, the prompt and "phase-assessment" as further
 * names to export. The assessment never ran ("reverted after 3 attempts … the tool call itself
 * failed"), and EPAM_RESPONSE_SCHEMA — the assessment's storyRoleAssignments/profileAdditions/
 * newProfiles shape — stayed exported to every later seam of the phase. Under a runner that
 * enforces --json-schema, the failure analyst's diagnosis was then rejected against the WRONG
 * schema ("must have required property 'storyRoleAssignments' … 'diagnosis' is not allowed"),
 * returned empty three times, and self-healing was reported broken (£0 greenfield harness run 26,
 * 2026-09-14). Latent since 2026-07-28; visible once --json-schema was wired into the claude arm.
 *
 * Judged by executing the REAL function with its collaborators stubbed: the runner must be called
 * with the prompt, must see the schema while it runs, and nothing must remain exported after.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { engineSource } from '../../lib/engine-source';

const ROOT = resolve(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function extractFn(name: string): string {
  const lines = engineSource(ORCH).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (start < 0) throw new Error(`${name}() not found`);
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  return lines.slice(start, end + 1).join('\n');
}

describe('the pre-phase assessment runs, and its schema stays its own', () => {
  it('the runner is called with the prompt, sees the schema while running, and nothing stays exported', () => {
    const d = mkdtempSync(join(tmpdir(), 'pfa-')); dirs.push(d);
    const logs = join(d, 'logs'); mkdirSync(logs);
    const profiles = join(d, 'profiles.json'); writeFileSync(profiles, '{}');
    const prd = join(d, 'prd.json'); writeFileSync(prd, JSON.stringify({ stories: [] }));
    const seen = join(d, 'runner-seen.txt');
    const script = [
      'set -u',
      `SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"`, 'PRD_REL=prd.json', 'PROFILES_REL=profiles.json',
      `AGENT_PROFILES_FILE="${profiles}"`, `LOG_DIR="${logs}"`, `PROJECT_ROOT="${d}"`, `PRD_FILE="${prd}"`, `PHASE=scaffold`,
      'log() { :; }; warning() { echo "WARN: $*" >&2; }; error() { echo "ERR: $*" >&2; }; success() { :; }; info() { :; }',
      'jq_vals() { jq -n "$@"; }',
      'render_engine_prompt() { printf "RENDERED %s" "$1"; }',
      // The stub records what it was called with and what it can see, and answers like a runner that
      // decided nothing (so the function takes its non-critical path and returns).
      `run_orch_prompt_with_tools() { printf 'called=1\\nprompt=%s\\nseam=%s\\nschema_set=%s\\n' "$1" "$2" "\${EPAM_RESPONSE_SCHEMA:+yes}" >> "${seen}"; echo '{"storyRoleAssignments":[],"profileAdditions":[],"newProfiles":[]}'; }`,
      extractFn('run_pre_phase_assessment'),
      'run_pre_phase_assessment scaffold || true',
      // After the call: is the assessment schema still exported to children?
      `bash -c 'printf "after_export=%s\\n" "\${EPAM_RESPONSE_SCHEMA:+leaked}"' >> "${seen}"`,
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: d, env: { ...process.env, EPAM_RESPONSE_SCHEMA: '' } });
    const out = (() => { try { return engineSource(seen); } catch { return ''; } })();
    expect(out, `the runner was never called\n${r.stderr}`).toMatch(/called=1/);
    expect(out).toMatch(/prompt=RENDERED /);
    expect(out).toMatch(/seam=phase-assessment/);
    expect(out, 'the runner must see the assessment schema while it runs').toMatch(/schema_set=yes/);
    expect(out, 'the assessment schema must not stay exported to every later seam').toMatch(/after_export=$/m);
  });
});
