/**
 * EVERY LAUNCHED RUN WRITES ITS OUTCOME AND REPORTS.
 *
 * AMSD-2974 run 9, live iteration 2 (2026-10-13 18:43Z): "Pipeline complete", all codelines GO — and the run folder held
 * no outcome.txt, flow.html, narrative.html or qa-summary.html. The run was launched by orchestrate.sh; only
 * tier3-metrolinx-run.sh archived artefacts and generated reports (_archive_run_artifacts, defined there alone).
 * The function now lives once in lib/run-artifacts.sh and orchestrate.sh calls it on pass and on fail.
 *
 * EXECUTED: the real archive_run_artifacts (with the real archive-run-artifacts.sh and generate-run-report.py) on a
 * project config folder and a launch log; and orchestrate.sh's real fail() — after the run started, and (NEGATIVE)
 * when it refuses before any phase ran.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const FAIL = shellFunction(join(S, 'orchestrate.sh'), 'fail');
const RUN = '20261013T182439Z';

function estate() {
  const d = mkdtempSync(join(tmpdir(), 'run-reports-'));
  const cfg = join(d, 'projects/p'); mkdirSync(cfg, { recursive: true }); mkdirSync(join(d, 'orchestrations/logs'), { recursive: true });
  const log = join(d, 'launch.log');
  writeFileSync(log, [
    "[18:24:39] [orch] Codeline 'site' — 1 stories → /repo/site",
    '[18:27:43] [REVIEW] Review Decision: APPROVED',
    '[18:43:20] [orch] ✅ Pipeline complete.',
  ].join('\n'));
  const pre = [
    'set -uo pipefail', `SCRIPT_DIR=${JSON.stringify(S)}`, `REPO_ROOT=${JSON.stringify(d)}`,
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}`, `export ORCH_RUN_ID=${RUN}`,
    `. "${S}/lib/project-config.sh"`, `. "${S}/lib/run-artifacts.sh"`,
  ];
  return { d, cfg, log, dir: join(cfg, 'runs', RUN), pre };
}

const run = (script: string[]) => spawnSync('bash', ['-c', script.join('\n')], { encoding: 'utf8' });
const nonEmpty = (f: string) => existsSync(f) && statSync(f).size > 0;

describe('every launched run writes its outcome and reports', () => {
  it('archive_run_artifacts writes outcome.txt, the launch log and the four reports into runs/<run id>', () => {
    const e = estate();
    const r = run([...e.pre, `archive_run_artifacts p "PASSED: 1 stories complete" ${JSON.stringify(e.log)}`]);
    expect(r.stdout).toContain(e.dir);
    expect(readFileSync(join(e.dir, 'outcome.txt'), 'utf8').trim()).toBe('PASSED: 1 stories complete');
    expect(readFileSync(join(e.dir, 'run.log'), 'utf8')).toContain('Pipeline complete');
    for (const f of ['flow.html', 'narrative.html', 'qa-summary.html', 'code.html']) expect(nonEmpty(join(e.dir, f)), f).toBe(true);
  });

  it("orchestrate.sh's fail() after the run started records FAILED with its reason, and still exits 1", () => {
    const e = estate();
    const r = run([...e.pre, 'PROJECT=p; LOG_FILE=' + JSON.stringify(e.log), 'info(){ printf "%s\\n" "$*"; }; RED=; NC=',
      FAIL, '_RUN_STARTED=1', 'fail "Phase core failed (exit 1)"']);
    expect(r.status).toBe(1);
    expect(readFileSync(join(e.dir, 'outcome.txt'), 'utf8').trim()).toBe('FAILED: Phase core failed (exit 1)');
    expect(nonEmpty(join(e.dir, 'qa-summary.html'))).toBe(true);
  });

  it('NEGATIVE: a refusal before any phase ran writes no run folder', () => {
    const e = estate();
    const r = run([...e.pre, 'PROJECT=p; LOG_FILE=' + JSON.stringify(e.log), 'info(){ :; }; RED=; NC=',
      FAIL, '_RUN_STARTED=0', 'fail "Project config not found"']);
    expect(r.status).toBe(1);
    expect(existsSync(join(e.cfg, 'runs'))).toBe(false);
  });
});
