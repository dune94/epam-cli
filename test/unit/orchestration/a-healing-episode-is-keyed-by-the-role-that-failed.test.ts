/**
 * A HEALING EPISODE IS KEYED BY THE ROLE THAT FAILED.
 *
 * The KB is a deterministic lookup on (agent_role, signature); synthesis fires only for a role.
 * STORY_ROLE was set by NO caller of claude.sh, and the tc-writer gate passed none to the attempt
 * analyst — so every episode either path recorded carried agent_role: null, and the KB never
 * learned from a single writer or tc-writer failure (£0 greenfield harness runs 22–27, 2026-09-14:
 * every healing-events.jsonl line null-keyed; kb-synthesizer never executed). Judged by executing
 * the real functions with their collaborators stubbed and reading what the KB was handed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function extractFn(file: string, name: string): string {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (start < 0) throw new Error(`${name}() not found in ${file}`);
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  return lines.slice(start, end + 1).join('\n');
}

describe("the writer path's healing recorder hands the KB the story's own role and the attempt's class", () => {
  it('kb_record_episode receives the agentRole from the PRD and a class that is not "unknown"', () => {
    const d = mkdtempSync(join(tmpdir(), 'heal-')); dirs.push(d);
    const lib = join(d, 'lib'); mkdirSync(lib); mkdirSync(join(d, 'logs'));
    const prd = join(d, 'prd.json'); writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', agentRole: 'stand-in-engineer' }] }));
    const seen = join(d, 'seen.txt');
    // The KB library as the recorder sources it — recording what it is handed.
    writeFileSync(join(lib, 'kb-apply.sh'), `kb_record_episode() { printf 'record role=%s class=%s\\n' "$2" "$4" >> "${seen}"; cat >/dev/null; }\nkb_maybe_synthesize() { printf 'synth role=%s\\n' "$1" >> "${seen}"; }\n`);
    const script = [
      'set -u', 'log() { :; }',
      `SCRIPT_DIR="${d}"`, `LOG_DIR="${join(d, 'logs')}"`, `PRD_FILE="${prd}"`, 'COORDINATOR_FAILURE_CLASS=env', 'VERIFICATION_FAILURE=""',
      extractFn(join(ROOT, 'orchestrations/scripts/claude.sh'), 'run_healing_recorder'),
      'run_healing_recorder S-1 0 prd "a diagnosis" 0 false',
      'COORDINATOR_FAILURE_CLASS=unknown run_healing_recorder S-1 2 prd "a diagnosis" 0 false',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, STORY_ROLE: '' } });
    const out = (() => { try { return readFileSync(seen, 'utf8'); } catch { return ''; } })();
    expect(out, r.stderr).toContain('record role=stand-in-engineer class=env');
    expect(out).toContain('synth role=stand-in-engineer');
    expect(out, '"unknown" is not a class the KB can key on').toContain('record role=stand-in-engineer class=\n');
  });
});

describe('the tc-writer gate names itself as the role whose attempt failed', () => {
  it('agent-attempt-analyst.sh runs with STORY_ROLE=tc-writer on a failed attempt', () => {
    const d = mkdtempSync(join(tmpdir(), 'tcgate-')); dirs.push(d);
    const scripts = join(d, 'scripts'); const lib = join(scripts, 'lib'); mkdirSync(lib, { recursive: true }); mkdirSync(join(d, 'logs'));
    const prd = join(d, 'prd.json'); writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', title: 't', phase: 'p', storyType: 'test', testCriteria: { facts: [] } }] }));
    const seen = join(d, 'seen.txt');
    // A tc-writer that produces nothing (a failed attempt), and an analyst that records its env.
    writeFileSync(join(scripts, 'post-impl-tc-writer.sh'), '#!/bin/bash\nexit 0\n'); chmodSync(join(scripts, 'post-impl-tc-writer.sh'), 0o755);
    writeFileSync(join(scripts, 'agent-attempt-analyst.sh'), `#!/bin/bash\nprintf 'analyst class=%s role=%s story=%s\\n' "$1" "\${STORY_ROLE:-}" "\${AGENT_ANALYST_STORY_ID:-}" >> "${seen}"\nexit 0\n`); chmodSync(join(scripts, 'agent-attempt-analyst.sh'), 0o755);
    const gate = readFileSync(join(ROOT, 'orchestrations/scripts/lib/tc-writer-gate.sh'), 'utf8');
    const script = [
      'set -u', 'log() { :; }; warning() { :; }; error() { :; }; success() { :; }; info() { :; }',
      'seam_model_or_fail() { echo m; }', 'jq_vals() { jq -n "$@"; }',
      `SCRIPT_DIR="${lib}"`, `LOG_DIR="${join(d, 'logs')}"`, `PRD_FILE="${prd}"`, `PROJECT_ROOT="${d}"`, 'EPAM_MODEL=m', 'EPAM_MODEL_LADDER_MEDIUM=""',
      gate.replace(/^\s*(set -[eu]+|source .*|\. .*)\s*$/gm, ''),
      '_tc_writer_gate_log_retry() { :; }',
      'run_inline_tc_writer_gate S-1 p || true',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, STORY_ROLE: '' }, timeout: 60000 });
    const out = (() => { try { return readFileSync(seen, 'utf8'); } catch { return ''; } })();
    expect(out, `the analyst was never invoked\n${r.stderr.slice(-800)}`).toMatch(/analyst class=no_json role=tc-writer story=S-1/);
  });
});
