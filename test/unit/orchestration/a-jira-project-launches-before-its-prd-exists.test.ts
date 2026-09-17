/**
 * A JIRA PROJECT LAUNCHES BEFORE ITS PRD EXISTS — THE RUN'S INGEST CREATES IT.
 *
 * The generic launcher (228cbfcb) demanded `$PRD_FILE` on disk before launching anything. A
 * brownfield project's PRD is synthesised by the run's own Jira ingest (JIRA_JQL) at the path the
 * project declares, so every fresh brownfield launch through this launcher was refused with
 * "no PRD at ...". Found at £0 by replaying the Sept 9 metrolinx cassette (2026-09-17) — the
 * first brownfield launch attempted through the generic launcher.
 *
 * This EXECUTES the real launcher with the paid stages stubbed (orchestrator, remediation,
 * pre-flight, reset record their argv) and asserts whether the orchestrator was reached.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LAUNCHER = join(ROOT, 'orchestrations/scripts/tier3-run.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755);
}

function launch(cfg: string[], withPrd: boolean) {
  const ws = mkdtempSync(join(tmpdir(), 'jira-launch-')); dirs.push(ws);
  const projects = join(ws, 'projects'); const proj = join(projects, 'demo'); mkdirSync(proj, { recursive: true });
  const bins = join(ws, 'bins'); mkdirSync(bins);
  const record = join(ws, 'calls.txt'); writeFileSync(record, '');
  const prd = join(ws, 'demo-prd.json');
  if (withPrd) writeFileSync(prd, JSON.stringify({ stories: [] }));
  writeFileSync(join(proj, 'config.env'), ['EPAM_BROWNFIELD=1', `PRD_FILE=${prd}`, 'EPAM_PROMPT_PROVISION_MODE=copy', 'EPAM_PROVIDER_SET=mockserver', `JIRA_CODELINE_ROOT=${ws}`, ...cfg].join('\n'));
  stub(bins, 'orch.sh', `echo "orch $*" >> "${record}"; exit 0`);
  stub(bins, 'rem.sh', `echo "rem $*" >> "${record}"; exit 0`);
  stub(bins, 'preflight.sh', `echo "preflight $*" >> "${record}"; exit 0`);
  stub(bins, 'reset.sh', `echo "reset $*" >> "${record}"; echo PRE_RUN_RESET_STATE_CLEARED; exit 0`);
  const r = spawnSync('bash', [LAUNCHER, '--project', 'demo', '--yes'], {
    encoding: 'utf8', cwd: ws, timeout: 120_000,
    env: { ...process.env, EPAM_PROJECTS_DIR: projects, EPAM_ORCHESTRATOR_BIN: join(bins, 'orch.sh'), EPAM_PRD_REMEDIATE_BIN: join(bins, 'rem.sh'), EPAM_PREFLIGHT_BIN: join(bins, 'preflight.sh'), PRE_RUN_RESET_SCRIPT: join(bins, 'reset.sh'), EPAM_FREE_RUN: '1', EPAM_PROJECT_OUTPUT_DIR: join(ws, 'logs'), EPAM_RESUME_RUN: '', JIRA_URL: '', JIRA_JQL: '' },
  });
  return { r, log: `${r.stdout}\n${r.stderr}`, calls: () => readFileSync(record, 'utf8') };
}

describe('a Jira project launches before its PRD exists', () => {
  it("Sept 9's shape: JIRA_URL + JIRA_JQL declared, no PRD on disk — the launcher proceeds to the orchestrator", () => {
    const t = launch(['JIRA_URL=https://example.atlassian.net', 'JIRA_JQL="issue = AMSD-1919"'], false);
    expect(t.log).not.toMatch(/✗.*no PRD at/);
    expect(t.log).toMatch(/this run's Jira ingest .* creates it/);
    // The brownfield path hands off to the real orchestrator (no stub hook on that path); it
    // starting — and refusing on the unresolvable fixture scope, as it should — is the proof
    // the launcher's own gates let the run through.
    expect(t.log, `the orchestrator was never reached:\n${t.log.slice(-1200)}`).toMatch(/\[orch\]/);
  });

  it('with NO ingest declared and no PRD on disk, the launcher still refuses — nothing would create one', () => {
    const t = launch([], false);
    expect(t.r.status).not.toBe(0);
    expect(t.log).toMatch(/no PRD at/);
    expect(t.log).not.toMatch(/\[orch\]/);
  });

  it('a PRD on disk launches as before, ingest declared or not', () => {
    for (const cfg of [[], ['JIRA_URL=https://example.atlassian.net', 'JIRA_JQL="issue = X-1"']]) {
      const t = launch(cfg, true);
      expect(t.log, `${cfg.join(' ')}: orchestrator not reached:\n${t.log.slice(-1200)}`).toMatch(/\[orch\]/);
    }
  });
});
