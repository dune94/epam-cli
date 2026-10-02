/**
 * THE DETECTIVE RE-RUN LAUNCHER STARTS.
 *
 * 2026-10-02, AMSD-2974: the operator asked for the shared-package fix to be proven with minimal
 * tokens — the detective alone, through the pipeline's own re-run step — rather than another full
 * run. detective-rerun.sh died before any call: `line 71: CONFIG: unbound variable`. The project's
 * env is loaded by load_project_env (two files, resolved by the provider-set registry); the
 * launcher still re-read a $CONFIG that nothing sets any more. orchestrate.sh re-applies the
 * project env after the secrets file with load_project_env, and so must this.
 *
 * EXECUTED: the real launcher in its read-only --report mode (no agent is called, nothing is
 * written), for a brownfield project of this repository, on a PRD in a temporary directory.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const work = mkdtempSync(join(tmpdir(), 'detective-rerun-launch-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A project of this repository whose own config declares it brownfield — never a name written here. */
function brownfieldProject(): string {
  const dir = join(ROOT, 'orchestrations/projects');
  for (const p of readdirSync(dir).sort()) {
    const env = join(dir, p, 'config.env');
    if (existsSync(env) && /^\s*(export\s+)?EPAM_BROWNFIELD=["']?1/m.test(readFileSync(env, 'utf8'))) return p;
  }
  return '';
}

describe('detective-rerun.sh', () => {
  it('loads the project env and reaches the step (read-only --report)', () => {
    const project = brownfieldProject();
    expect(project, 'no brownfield project in this repository to launch for').toBeTruthy();
    const prd = join(work, 'prd.json');
    writeFileSync(prd, JSON.stringify({ project: { outputDirs: [] }, stories: [{ id: 'S-1', codelines: ['a'], fixSiteAnalysisPerCodeline: { a: [] } }] }));
    const r = spawnSync('bash', [join(ROOT, 'orchestrations/scripts/detective-rerun.sh'), '--project', project, '--report'], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, PRD_FILE: prd, OUTPUT_DIR: work, NODE_BIN: process.execPath },
    });
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(r.stderr, 'the launcher never reached the step').toContain(`[detective-rerun] project=${project}`);
    expect(r.status, r.stderr.slice(-600)).toBe(0);
  });
});
