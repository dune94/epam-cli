/**
 * WHAT THE PAUSE INVITES YOU TO EDIT, THE CHECKPOINT MUST KEEP.
 *
 * Pause 1 prints "Inspect and EDIT if needed" over four files and promises the resume "does not
 * re-assign over your changes". The checkpoint saved two of them. So an operator could retune the
 * roster at the review point, and nothing on disk recorded what they set: if a later stage rewrote
 * it, there was no before to compare against and no copy to restore from.
 *
 * Found 2026-08-28 on a free rehearsal — role-assignments.json changed across a resume and the
 * change could not be characterised, because the only evidence kept was an md5 I took by hand.
 * "No inputs lost on resume" was unproven rather than untrue, which is its own defect.
 *
 * The editable set is declared ONCE, by operator_reviewable_inputs, and read by both the banner
 * that offers the files and the checkpoint that keeps them. Two lists would drift — resume_skip_env
 * already carries a comment about the last time two hand-kept lists in this file did exactly that.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const ORCH = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const RUN = '20260828T160000Z';

/** A workspace shaped like a real run at pause 1, with every reviewable file present. */
function workspace() {
  const d = mkdtempSync(join(tmpdir(), 'pause-edit-')); dirs.push(d);
  const cfg = join(d, 'project'), agents = join(d, 'agents'), logs = join(d, 'logs');
  for (const x of [cfg, agents, logs]) mkdirSync(x, { recursive: true });

  writeFileSync(join(agents, 'profiles.json'), JSON.stringify({ agents: [{ name: 'as-minted' }] }));
  writeFileSync(join(cfg, 'project-roles.json'), JSON.stringify([{ role: 'as-minted' }]));
  writeFileSync(join(cfg, 'project-investigators.json'), JSON.stringify([{ role: 'as-minted' }]));
  writeFileSync(join(logs, 'role-assignments.json'),
    JSON.stringify([{ storyId: 'S-1', agentRole: 'as-minted', codeline: 'a' }]));
  const prd = join(cfg, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', agentRole: 'as-minted' }] }));

  return { d, cfg, agents, logs, prd };
}

function env(w: ReturnType<typeof workspace>) {
  return {
    EPAM_PROJECT_CONFIG_DIR: w.cfg, EPAM_AGENTS_DIR: w.agents, LOG_DIR: w.logs,
    PRD_FILE: w.prd, AGENT_PROFILES_FILE: join(w.agents, 'profiles.json'),
    ORCH_RUN_ID: RUN, PHASE: 'core',
  };
}

function inLib(snippet: string, w: ReturnType<typeof workspace>, extra: Record<string, string> = {}) {
  return spawnSync('bash', ['-c',
    `is_truthy(){ case "$(printf '%s' "\${1:-}" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) return 0;; *) return 1;; esac; }
     info(){ :; }; warning(){ :; }; log(){ :; }; is_parent(){ return 0; }
     source ${JSON.stringify(LIB)}
     ${snippet}`,
  ], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env(w), ...extra } });
}

describe('THE CHECKPOINT KEEPS WHAT THE PAUSE OFFERED FOR EDITING', () => {
  it('declares the reviewable set in one place', () => {
    const w = workspace();
    const r = inLib('operator_reviewable_inputs', w);
    const paths = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
    expect(paths, `operator_reviewable_inputs failed: ${r.stderr}`).toEqual(expect.arrayContaining([
      join(w.agents, 'profiles.json'),
      join(w.cfg, 'project-roles.json'),
      join(w.cfg, 'project-investigators.json'),
    ]));
  });

  it('keeps a copy of every reviewable file', () => {
    const w = workspace();
    const r = inLib(`save_run_checkpoint core post-roster`, w);
    const dir = (r.stdout || '').trim().split('\n').pop() || '';
    expect(dir, `checkpoint failed: ${r.stderr}`).toBeTruthy();

    const missing = ['profiles.json', 'project-roles.json', 'project-investigators.json']
      .filter((f) => !existsSync(join(dir, 'reviewed', f)) && !existsSync(join(dir, f)));
    expect(missing, 'the pause offers these for editing and the checkpoint does not keep them — '
      + 'an edit made at the review point has no before and no copy to restore from').toEqual([]);
  });

  it('so an edit made at the pause can be recovered after something overwrites it', () => {
    const w = workspace();
    // the operator retunes an assignment at pause 1, exactly as the banner invites
    const edited = join(w.cfg, 'project-roles.json');
    writeFileSync(edited, JSON.stringify([{ role: 'HAND-EDITED-BY-OPERATOR' }]));

    const r = inLib(`save_run_checkpoint core post-roster`, w);
    const dir = (r.stdout || '').trim().split('\n').pop() || '';

    // ...and a later stage rewrites it
    writeFileSync(edited, JSON.stringify([{ role: 'clobbered' }]));

    const kept = [join(dir, 'reviewed', 'project-roles.json'), join(dir, 'project-roles.json')]
      .find((p) => existsSync(p));
    expect(kept, 'nothing preserved the operator edit').toBeTruthy();
    expect(readFileSync(kept!, 'utf8')).toContain('HAND-EDITED-BY-OPERATOR');
  });

  it('and keeps the assignments as evidence, since the resume rewrites them', () => {
    const w = workspace();
    const r = inLib(`save_run_checkpoint core post-roster`, w);
    const dir = (r.stdout || '').trim().split('\n').pop() || '';
    const kept = [join(dir, 'reviewed', 'role-assignments.json'), join(dir, 'role-assignments.json')]
      .find((p) => existsSync(p));
    expect(kept, 'the resume annotates role-assignments.json in place, with no before kept, so '
      + '"your edits survived" cannot be shown either way').toBeTruthy();
  });
});

describe('THE BANNER AND THE CHECKPOINT READ THE SAME DECLARATION', () => {
  it('the pause-1 banner offers exactly the declared files', () => {
    // Two hand-kept lists drift; this file already carries a comment about the last time they did.
    const w = workspace();
    const declared = (inLib('operator_reviewable_inputs', w).stdout || '')
      .trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);

    const at = ORCH.indexOf('_pause_after_agent_mint() {');
    const fn = ORCH.slice(at, ORCH.indexOf('\n}\n', at) + 3);
    const sh = join(w.d, 'banner.sh');
    writeFileSync(sh, [
      '#!/usr/bin/env bash',
      'info(){ :; }; warning(){ :; }; save_run_checkpoint(){ echo ckpt; }',
      'is_truthy(){ case "$(printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]")" in 1|true|yes|on) return 0;; *) return 1;; esac; }',
      'should_pause_after_agent_mint(){ return 0; }',
      `source ${JSON.stringify(LIB)}`,
      'GREEN=""; RED=""; NC="";',
      fn,
      '_pause_after_agent_mint || true',
    ].join('\n'));

    const out = spawnSync('bash', [sh], {
      // sourcing the library replaces the stub predicate with the real one, which reads this
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ...env(w), EPAM_PAUSE_AFTER_AGENT_MINT: '1', EPAM_RESUMED_FROM_STAGE: '' },
    });
    const printed = (out.stdout || '') + (out.stderr || '');
    expect(printed, 'the banner rendered nothing — every assertion below would pass vacuously')
      .toMatch(/spec NOT started/);

    const notOffered = declared.filter((p) => !printed.includes(p));
    expect(notOffered, 'the checkpoint keeps files the banner never offers, or the reverse — the '
      + 'two lists have drifted').toEqual([]);
  });
});
