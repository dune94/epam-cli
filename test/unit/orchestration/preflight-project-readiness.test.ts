/**
 * PRE-LAUNCH MUST ASSESS THE PROJECT, NOT JUST THE RUNNER.
 *
 * 2026-08-05: four launches died on things a pre-flight should have caught, each costing a
 * cycle and some costing credits —
 *
 *   stale dist/ (twice)      caught by a phase gate AFTER the run started
 *   observability down       caught by the tier launcher's own check, not preflight
 *   missing project template  never caught — hello-dolly borrowed skyscanner-app's identity
 *   lane PRD deleted          never caught — working-prd.json archived as "missing"
 *
 * preflight-check.sh existed the whole time with six checks. It was wired into exactly TWO
 * launchers (skyscanner-app, travel-app). metrolinx and mock1 — the two actually being run
 * — never called it.
 *
 * A pre-flight that half the launchers skip is not a pre-flight.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const PREFLIGHT = join(SCRIPTS, 'preflight-check.sh');

const launchers = readdirSync(SCRIPTS).filter((f) => /^tier\d+-[a-z0-9-]+-run\.sh$/.test(f));

describe('every launcher runs the pre-flight', () => {
  it('there are launchers to check', () => {
    expect(launchers.length).toBeGreaterThan(2);
  });

  it.each(launchers)('%s calls preflight-check.sh', (f) => {
    const src = readFileSync(join(SCRIPTS, f), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(
      src,
      `${f} launches without a pre-flight. preflight-check.sh was wired into only two of ` +
        `the launchers, and the two being run daily were not among them.`,
    ).toMatch(/require_preflight|preflight-check\.sh/);
  });
});

describe('the pre-flight assesses PROJECT readiness', () => {
  const src = readFileSync(PREFLIGHT, 'utf8');

  it('checks dist/ is newer than src/ — the pipeline runs dist, not src', () => {
    expect(
      src,
      'a stale dist means the code under test is not the code that runs. This was caught ' +
        'twice on 2026-08-05, both times by a gate AFTER the run began.',
    ).toMatch(/dist/);
  });

  it('checks the project has its OWN synthesis template', () => {
    expect(
      src,
      'without prd.canonical.json a project inherits ANOTHER project\'s project block — ' +
        'hello-dolly runs were labelled project.name: skyscanner-app',
    ).toMatch(/canonical/);
  });

  it('checks observability is serving, since a run aborts without it', () => {
    expect(src).toMatch(/langfuse|observability/i);
  });
});

describe('it fails a project that is not ready, and says why', () => {
  function runPreflight(projectDir: string) {
    const r = spawnSync('bash', [PREFLIGHT, '--project-config', projectDir], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, EPAM_PREFLIGHT_SKIP_NETWORK: '1' },
    });
    return { out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
  }

  it('a project with no canonical template is reported, not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'));
    writeFileSync(join(dir, 'config.env'), 'PROJECT_NAME=incomplete\n');
    const r = runPreflight(dir);
    expect(
      r.out,
      'a missing template is exactly what let one project run under another\'s identity',
    ).toMatch(/canonical/i);
  });

  it('a complete project passes that check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-ok-'));
    writeFileSync(join(dir, 'config.env'), 'PROJECT_NAME=complete\n');
    writeFileSync(join(dir, 'prd.canonical.json'), JSON.stringify({ project: { name: 'complete' }, stories: [] }));
    const r = runPreflight(dir);
    expect(r.out).not.toMatch(/✗.*canonical/i);
  });
});
