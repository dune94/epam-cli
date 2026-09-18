/**
 * A PAUSED RUN OWNS ITS ROSTER, EVEN AFTER ANOTHER RUN HAS LAUNCHED.
 *
 * regintel 20260918T132928Z paused at post-roster with a reviewed four-role roster and ten
 * assignments. Two fresh launches followed the same day (151250Z, 135356Z); both aborted in the
 * mint, and both wrote over the project's roster files on the way: agent-profiles.json now carried
 * runId 151250Z and three other roles, project-roles.json listed those three, roster.json was
 * cleared, and LOG_DIR/role-assignments.json was gone. The paused run's own copies survived only
 * under runs/<id>/checkpoint/reviewed — and restore_run_checkpoint would not have used them:
 *
 *   - "live differs from reviewed" is read as an OPERATOR EDIT and the live file is kept. A later
 *     run's mint output is not an edit, but the restore had no way to tell the two apart.
 *   - project-roles.json, project-investigators.json and role-assignments.json are saved as
 *     "best-effort forensics" and never restored at all.
 *   - roster.json and the agent-profiles.json store — the two files the skip-mint resume actually
 *     reads to re-register the run's implementers — were never saved in the first place.
 *
 * The mint stamps its outputs with the run that made them (agent-roster.js, rosterRunId), so
 * ownership is on disk: a live roster file that names ANOTHER run was written by that run, not
 * by the operator at this pause, and the checkpoint's copy governs. An edit — same run, different
 * bytes — is still honoured, as a-restore-does-not-undo-the-operator proves.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');
const PAUSED = '20260918T132928Z';
const LATER = '20260918T151250Z';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PAUSED_ROLES = ['evidence-runbook-engineer', 'review-portal-engineer',
  'regintel-pipeline-engineer', 'fastapi-service-engineer'];
const LATER_ROLES = ['regintel-pipeline-engineer', 'regintel-service-engineer', 'regintel-engineer'];

const roster = (runId: string, roles: string[]) => JSON.stringify({
  runId, agents: Object.fromEntries(roles.map((r) => [r, { kind: 'implementer', brief: `${r} brief of ${runId}` }])),
});
const store = (runId: string, roles: string[]) => JSON.stringify({
  runId, profiles: Object.fromEntries(roles.map((r) => [r, `${r} brief of ${runId}`])),
});
const registry = (roles: string[]) => JSON.stringify({ roles });
const investigators = (runId: string) => JSON.stringify({ investigators: [`${runId}-investigator`] });
const assignments = (roles: string[]) => JSON.stringify(
  roles.map((r, i) => ({ storyId: `REGI-00${i + 1}`, codeline: '', agentRole: r })));
const prd = (roles: string[]) => JSON.stringify({
  stories: roles.map((r, i) => ({ id: `REGI-00${i + 1}`, agentRole: r })),
});

function workspace() {
  const d = mkdtempSync(join(tmpdir(), 'later-launch-')); dirs.push(d);
  const cfg = join(d, 'project'), agents = join(d, 'agents'), logs = join(d, 'logs');
  for (const x of [cfg, agents, logs]) mkdirSync(x, { recursive: true });
  const files = {
    prd: join(cfg, 'regintel-prd.json'),
    engineProfiles: join(agents, 'profiles.json'),
    store: join(cfg, 'agent-profiles.json'),
    roster: join(cfg, 'roster.json'),
    roles: join(cfg, 'project-roles.json'),
    investigators: join(cfg, 'project-investigators.json'),
    assignments: join(logs, 'role-assignments.json'),
  };
  return { d, cfg, agents, logs, files };
}

type W = ReturnType<typeof workspace>;

function inLib(snippet: string, w: W, runId: string) {
  return spawnSync('bash', ['-c',
    `is_truthy(){ return 1; }; info(){ :; }; warning(){ :; }; log(){ :; }; is_parent(){ return 0; }
     source ${JSON.stringify(LIB)}
     ${snippet}`,
  ], {
    encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env,
      EPAM_PROJECT_CONFIG_DIR: w.cfg, EPAM_AGENTS_DIR: w.agents, LOG_DIR: w.logs,
      PRD_FILE: w.files.prd, AGENT_PROFILES_FILE: w.files.engineProfiles,
      ORCH_RUN_ID: runId, PHASE: 'core',
    },
  });
}

/** The paused run mints, is reviewed, and saves its post-roster checkpoint. */
function pauseAsFirstRun(w: W) {
  writeFileSync(w.files.prd, prd(PAUSED_ROLES));
  writeFileSync(w.files.engineProfiles, JSON.stringify({ canonical: 'personas only' }));
  writeFileSync(w.files.store, store(PAUSED, PAUSED_ROLES));
  writeFileSync(w.files.roster, roster(PAUSED, PAUSED_ROLES));
  writeFileSync(w.files.roles, registry(PAUSED_ROLES));
  writeFileSync(w.files.investigators, investigators(PAUSED));
  writeFileSync(w.files.assignments, assignments(PAUSED_ROLES));
  const r = inLib('save_run_checkpoint core post-roster', w, PAUSED);
  expect(r.status, `save failed: ${r.stdout}${r.stderr}`).toBe(0);
}

/** A later fresh launch mints over the same project and aborts — exactly what 151250Z left. */
function laterLaunchMintsAndAborts(w: W) {
  writeFileSync(w.files.store, store(LATER, LATER_ROLES));
  writeFileSync(w.files.roles, registry(LATER_ROLES));
  writeFileSync(w.files.investigators, investigators(LATER));
  rmSync(w.files.roster, { force: true });
  rmSync(w.files.assignments, { force: true });
}

function resumeFirstRun(w: W) {
  const r = inLib(`restore_run_checkpoint ${PAUSED}`, w, PAUSED);
  expect(r.status, `restore failed: ${r.stdout}${r.stderr}`).toBe(0);
  return (r.stdout || '') + (r.stderr || '');
}

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('THE CHECKPOINT KEEPS EVERYTHING THE RESUME READS', () => {
  it('saves the settled roster and the minted briefs, not only the engine profiles', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    const ck = join(w.cfg, 'runs', PAUSED, 'checkpoint');
    expect(existsSync(join(ck, 'roster.json')),
      'roster.json — what the skip-mint resume re-registers implementers from — was not saved')
      .toBe(true);
    expect(existsSync(join(ck, 'agent-profiles.json')),
      'the agent-profiles.json store — the minted briefs — was not saved').toBe(true);
    expect(json(join(ck, 'roster.json')).runId).toBe(PAUSED);
  });
});

describe('A LATER LAUNCH DOES NOT STEAL A PAUSED RUN', () => {
  it('restores the paused run\'s own roster over the one another run minted', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    laterLaunchMintsAndAborts(w);
    resumeFirstRun(w);
    expect(json(w.files.store).runId, 'the store still names the later run').toBe(PAUSED);
    expect(Object.keys(json(w.files.store).profiles).sort()).toEqual([...PAUSED_ROLES].sort());
    expect(json(w.files.roles).roles.sort(), 'project-roles.json still lists the later run\'s roles')
      .toEqual([...PAUSED_ROLES].sort());
    expect(json(w.files.investigators).investigators).toEqual([`${PAUSED}-investigator`]);
  });

  it('puts back the settled roster the later launch cleared', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    laterLaunchMintsAndAborts(w);
    resumeFirstRun(w);
    expect(existsSync(w.files.roster), 'roster.json is still missing — the resume would find no implementers').toBe(true);
    expect(json(w.files.roster).runId).toBe(PAUSED);
    expect(Object.keys(json(w.files.roster).agents).sort()).toEqual([...PAUSED_ROLES].sort());
  });

  it('puts back the reviewed story assignments the later launch cleared', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    laterLaunchMintsAndAborts(w);
    resumeFirstRun(w);
    expect(existsSync(w.files.assignments), 'role-assignments.json is still missing').toBe(true);
    expect(json(w.files.assignments).map((a: { agentRole: string }) => a.agentRole).sort())
      .toEqual([...PAUSED_ROLES].sort());
  });

  it('says which files it reclaimed and from which run', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    laterLaunchMintsAndAborts(w);
    const out = resumeFirstRun(w);
    expect(out).toMatch(new RegExp(LATER));
    expect(out).toMatch(/agent-profiles\.json/);
    expect(out).toMatch(/project-roles\.json/);
  });
});

describe('THE PRD IS THE PAUSED RUN\'S TOO', () => {
  it('restores the reviewed PRD when a later launch put the canonical back over it', () => {
    // tier3-run.sh restores the authored PRD on every fresh launch. After the pause that left the
    // live PRD without the reviewed agentRoles — different from what was shown, so "an edit", and
    // kept. The store on disk says who really wrote over the project: another run.
    const w = workspace();
    pauseAsFirstRun(w);
    laterLaunchMintsAndAborts(w);
    writeFileSync(w.files.prd, JSON.stringify({
      stories: PAUSED_ROLES.map((_, i) => ({ id: `REGI-00${i + 1}` })),
    }));
    resumeFirstRun(w);
    expect(json(w.files.prd).stories.map((s: { agentRole?: string }) => s.agentRole).sort())
      .toEqual([...PAUSED_ROLES].sort());
  });

  it('still keeps a PRD the operator edited when no other run has minted since', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    const edited = prd(PAUSED_ROLES).replace('fastapi-service-engineer', 'review-portal-engineer');
    writeFileSync(w.files.prd, edited);
    resumeFirstRun(w);
    expect(readFileSync(w.files.prd, 'utf8')).toBe(edited);
  });
});

describe('A RECLAIM MOVES THE OTHER RUN\'S FILE ASIDE — NOTHING IS OVERWRITTEN', () => {
  it('keeps the later run\'s store and registry under the paused run\'s checkpoint', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    laterLaunchMintsAndAborts(w);
    resumeFirstRun(w);
    const displaced = join(w.cfg, 'runs', PAUSED, 'checkpoint', 'displaced', LATER);
    expect(existsSync(join(displaced, 'agent-profiles.json')),
      'the later run\'s briefs were overwritten and exist nowhere').toBe(true);
    expect(json(join(displaced, 'agent-profiles.json')).runId).toBe(LATER);
    expect(json(join(displaced, 'project-roles.json')).roles.sort()).toEqual([...LATER_ROLES].sort());
  });
});

describe('AND AN OPERATOR EDIT AT THE PAUSE IS STILL AN EDIT', () => {
  it('keeps a registry the operator changed when no other run has minted since', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    writeFileSync(w.files.roles, registry([...PAUSED_ROLES, 'operator-added-engineer']));
    resumeFirstRun(w);
    expect(json(w.files.roles).roles, 'an operator edit was overwritten by the checkpoint copy')
      .toContain('operator-added-engineer');
  });

  it('keeps assignments the operator retuned when no other run has minted since', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    const retuned = assignments(PAUSED_ROLES).replace('fastapi-service-engineer', 'review-portal-engineer');
    writeFileSync(w.files.assignments, retuned);
    resumeFirstRun(w);
    expect(readFileSync(w.files.assignments, 'utf8')).toBe(retuned);
  });

  it('leaves this run\'s own store and roster alone', () => {
    const w = workspace();
    pauseAsFirstRun(w);
    const before = { store: readFileSync(w.files.store, 'utf8'), roster: readFileSync(w.files.roster, 'utf8') };
    resumeFirstRun(w);
    expect(readFileSync(w.files.store, 'utf8')).toBe(before.store);
    expect(readFileSync(w.files.roster, 'utf8')).toBe(before.roster);
  });
});
