/**
 * PRE-FLIGHT REFUSES AN ESTIMATION MANIFEST IT CANNOT READ — AND SAYS NOTHING WHEN THERE IS NONE.
 *
 * EPAM_ESTIMATION_MANIFEST (2026-09-28) is read right after ingest; a path that is missing or
 * unreadable would stop the run there, after ingest has spent. Pre-flight asks first. Executed: the
 * real lookup (_project_env_value) and the real check, lifted from preflight-check.sh by their own
 * markers, with ok/fail recording what they said. The key may live in the environment or in the
 * project's own env file — both are asked.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPT = join(ROOT, 'orchestrations/scripts/preflight-check.sh');
const src = readFileSync(SCRIPT, 'utf8');

function lift(): string {
  const fnStart = src.indexOf('_project_env_value() {');
  const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
  const chkStart = src.indexOf('_estimation_manifest="$(_project_env_value EPAM_ESTIMATION_MANIFEST)"');
  const chkEnd = src.indexOf('\nfi\n', src.indexOf('\n  fi\n', chkStart)) + 4;
  if (fnStart < 0 || chkStart < 0 || chkEnd < chkStart) throw new Error('the pre-flight estimation block is gone');
  return `${src.slice(fnStart, fnEnd)}\n${src.slice(chkStart, chkEnd)}`;
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function preflight(env: Record<string, string>) {
  const script = [
    'ok(){ echo "OK $*"; }', 'fail(){ echo "FAIL $*"; }',
    // BASH_SOURCE of the lifted function must resolve lib/ beside the real script.
    `cd ${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`,
    lift(),
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', ...env } });
  return (r.stdout + r.stderr).trim();
}

describe('pre-flight and the estimation manifest', () => {
  it('unset: nothing is checked and nothing is said', () => {
    expect(preflight({})).toBe('');
  });

  it('a readable manifest passes, naming it', () => {
    const d = mkdtempSync(join(tmpdir(), 'pf-est-')); dirs.push(d);
    expect(preflight({ EPAM_ESTIMATION_MANIFEST: d })).toBe(`OK estimation manifest readable: ${d}`);
  });

  it('a missing manifest FAILS pre-flight, naming the path', () => {
    const out = preflight({ EPAM_ESTIMATION_MANIFEST: '/nonexistent/estimates' });
    expect(out).toMatch(/^FAIL EPAM_ESTIMATION_MANIFEST=\/nonexistent\/estimates is missing or unreadable/);
  });

  it('declared in the project\'s own env file, it is found and checked there too', () => {
    const proj = mkdtempSync(join(tmpdir(), 'pf-est-proj-')); dirs.push(proj);
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'config.env'), 'PROJECT_NAME=x\nEPAM_ESTIMATION_MANIFEST=/nonexistent/from-project\n');
    const out = preflight({ PROJECT_CONFIG_DIR: proj });
    expect(out).toMatch(/^FAIL EPAM_ESTIMATION_MANIFEST=\/nonexistent\/from-project/);
  });
});
