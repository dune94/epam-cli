/**
 * THE COORDINATOR AUDITS TAKE A SNAPSHOT SO THEY CAN UNDO A BAD REWRITE. THE SNAPSHOT COULD FAIL
 * OPEN, AND THE FAILED VALUE WAS WRITTEN BACK AS IF IT WERE THE ORIGINAL.
 *
 * Step 11:  _skills_before=$(cat "$AGENT_PROFILES_FILE" 2>/dev/null || echo "{}")
 * Step 12:  _tc_before=$(cat "$_tc_path" 2>/dev/null || echo "")
 *
 * The ONLY use of either variable is to be written back over the file when the coordinator
 * corrupts it. So an unreadable profiles.json produced a snapshot of `{}`, and the "restore"
 * destroyed every agent profile in the project — while logging that it had restored them. For a
 * tool script the fallback was the empty string, and an empty script PASSES `bash -n`, so the
 * restore silently neutered the tool and the next check reported it healthy.
 *
 * A rollback that can destroy the thing it protects is worse than no rollback: it converts a
 * recoverable corruption into a silent, total loss, and reports success.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'snapshot-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const src = () => readFileSync(ORCH, 'utf8');

/** Run a lifted fragment of the script under bash. */
function sh(script: string): { out: string; code: number } {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 };
}

describe('a failed snapshot is never written back', () => {
  it('an unreadable profiles.json does not become a snapshot of {}', () => {
    // The snapshot line, exactly as the script runs it, against a file it cannot read.
    const line = src().split('\n').find((l) => l.includes('_skills_before=$(cat "$AGENT_PROFILES_FILE"'));
    expect(line, 'the profiles snapshot is gone — this test is measuring nothing').toBeTruthy();

    const f = join(work, 'profiles.json');
    writeFileSync(f, '{"typescript-engineer":{"skills":["real"]}}');
    chmodSync(f, 0o000);
    const { out } = sh(`AGENT_PROFILES_FILE=${JSON.stringify(f)}
      _skills_before=""
      ${line!.trim()}
      echo "SNAPSHOT=[$_skills_before]"`);
    chmodSync(f, 0o644);

    expect(out, 'a failed read still produces "{}", which the restore writes over every profile')
      .toContain('SNAPSHOT=[]');
  });

  it('the restore refuses to overwrite profiles.json with an empty snapshot', () => {
    const body = src();
    const i = body.indexOf('skills-coordinator corrupted profiles.json');
    expect(i, 'the profiles restore is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 400, i + 600);
    expect(block, 'the restore is still unconditional — an empty snapshot wipes every profile')
      .toMatch(/if \[ -n "\$_skills_before" \]/);
    expect(block, 'nothing tells the operator the file was left alone and needs restoring')
      .toMatch(/leaving the file as-is|no pre-audit snapshot/i);
  });

  it('the restore refuses to overwrite a tool script with an empty snapshot', () => {
    const body = src();
    const i = body.indexOf('syntactically broken after 2 attempt');
    expect(i, 'the tool restore is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 400, i + 700);
    expect(block).toMatch(/if \[ -n "\$_tc_before" \]/);
  });

  it('an empty script passes bash -n — which is why the empty restore was invisible', () => {
    // Pins the mechanism. If this ever stops being true the reasoning above needs revisiting.
    const f = join(work, 'tool.sh');
    writeFileSync(f, '');
    expect(sh(`bash -n ${JSON.stringify(f)}`).code,
      'an empty script no longer passes bash -n',
    ).toBe(0);
  });

  it('a tool left broken by a failed second attempt is restored, not called "as-is"', () => {
    const body = src();
    const i = body.indexOf('tools-coordinator failed to fix');
    expect(i, 'the give-up path is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 600, i + 400);
    expect(block, 'the agent’s half-rewritten broken script is still left on disk and executed')
      .toMatch(/restoring the pre-audit script/i);
  });

  it('neither audit reports pass after a scan that failed', () => {
    const body = src();
    for (const [step, marker] of [['11', '_skills_audit_ok'], ['12', '_tools_audit_ok']]) {
      expect(body, `Step ${step} has no record of whether its scan succeeded`).toContain(marker);
      const i = body.indexOf(`step_emit "${step}" "pass"`);
      expect(i, `Step ${step} no longer emits pass`).toBeGreaterThan(-1);
      expect(body.slice(i - 300, i), `Step ${step} still emits pass unconditionally`)
        .toContain(marker);
    }
  });

  it('neither audit invokes an agent with an unrendered prompt', () => {
    const body = src();
    for (const tpl of ['skills-coordinator', 'tools-coordinator']) {
      const i = body.indexOf(`render_engine_prompt ${tpl} "$_cp_vals"`);
      expect(i, `${tpl} is no longer rendered here`).toBeGreaterThan(-1);
      const block = body.slice(i - 200, i + 400);
      expect(block, `a failed ${tpl} render still reaches an agent as an empty prompt`)
        .toMatch(/if ! _[a-z]+_prompt=|-z "\$_[a-z]+_prompt"/);
    }
  });
});
