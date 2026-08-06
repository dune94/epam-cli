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

/**
 * A PRD THAT INGEST HAS NOT WRITTEN YET IS NOT A DEFECTIVE PRD.
 *
 * On a Jira-sourced run the launcher creates an EMPTY file and exports its path as
 * JIRA_SYNTH_PRD_PATH; run-agent-orchestration.sh fills it during ingest — after the
 * pre-flight has run. Checking project.outputDir on that placeholder failed the launch of
 * a perfectly healthy mock1 run (2026-08-05), which is the same shape as every gate that
 * ever had to be disabled: it blocked a state it had never been tested against.
 *
 * A pre-flight must distinguish "this PRD is wrong" from "this PRD does not exist yet".
 */
describe('a PRD synthesized later is deferred, not failed', () => {
  function runWith(prdContent: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, prdContent);
    writeFileSync(join(dir, 'prd.canonical.json'), JSON.stringify({ project: { name: 'p' }, stories: [] }));
    const r = spawnSync('bash', [PREFLIGHT, '--prd', prd, '--project-config', dir], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        EPAM_PREFLIGHT_ENVIRONMENT: '0',
        // Pending-ingest deferral requires JIRA_URL: ingest only overwrites PRD_FILE on a
        // real (or stubbed) Jira-sourced run.
        JIRA_URL: env.JIRA_SYNTH_PRD_PATH === 'SELF' ? 'http://mock-jira.invalid' : '',
        JIRA_SYNTH_PRD_PATH: env.JIRA_SYNTH_PRD_PATH === 'SELF' ? prd : (env.JIRA_SYNTH_PRD_PATH ?? ''),
      },
    });
    return `${r.stdout || ''}${r.stderr || ''}`;
  }

  it('THE BUG: an empty placeholder this run will synthesize does not fail the launch', () => {
    const out = runWith('{}', { JIRA_SYNTH_PRD_PATH: 'SELF' });
    expect(
      out,
      'the pre-flight blocked a healthy mock1 launch by demanding a field that ingest ' +
        'writes minutes later',
    ).not.toMatch(/✗.*outputDir/);
    expect(out, 'and it must SAY it deferred, rather than passing silently').toMatch(/ingest|synthesi/i);
  });

  it('an empty PRD that nothing will synthesize still fails — deferral is not a loophole', () => {
    const out = runWith('{}');
    expect(out).toMatch(/✗.*outputDir/);
  });

  it('a populated PRD is checked exactly as before, ingest or not', () => {
    const out = runWith(JSON.stringify({ project: { outputDir: '/somewhere' }, stories: [] }), {
      JIRA_SYNTH_PRD_PATH: 'SELF',
    });
    expect(out).toMatch(/outputDir = \/somewhere/);
  });
});

/**
 * THE REAL FAILURE — a NON-EMPTY leftover PRD, not a placeholder.
 *
 * mock1's deferral only recognised a genuinely empty file. metrolinx's prd.json is never
 * empty — it carries real content from the PREVIOUS run — and ingest overwrites that exact
 * file (JIRA_SYNTH_PRD_PATH unset defaults to PRD_FILE per run-agent-orchestration.sh).
 * A metrolinx pre-flight on 2026-08-05 failed on "pre-baked specification blocks" that were
 * genuine contamination, but from a run about to be discarded before the writer ever ran.
 */
describe('a non-empty leftover PRD about to be overwritten by ingest is deferred too', () => {
  function runMetrolinxShaped(prdContent: unknown, withJiraUrl: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'ml-'));
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify(prdContent));
    writeFileSync(join(dir, 'prd.canonical.json'), JSON.stringify({ project: { name: 'p' }, stories: [] }));
    const r = spawnSync('bash', [PREFLIGHT, '--prd', prd, '--runner', 'tier3-metrolinx-run.sh', '--project-config', dir], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, EPAM_PREFLIGHT_ENVIRONMENT: '0', JIRA_URL: withJiraUrl ? 'http://mock-jira.invalid' : '' },
    });
    return `${r.stdout || ''}${r.stderr || ''}`;
  }

  const STALE_PRD = {
    stories: [{ id: 'AMSD-2041', completed: false, specification: { status: 'done' } }],
  };

  it('THE BUG: real leftover content from a prior run does not fail a Jira-sourced launch', () => {
    const out = runMetrolinxShaped(STALE_PRD, true);
    expect(
      out,
      'this exact shape — a pending story carrying a stale specification block — blocked ' +
        'a healthy metrolinx launch on 2026-08-05, because ingest was about to overwrite ' +
        'this exact file and nothing downstream would ever see the stale content',
    ).not.toMatch(/✗.*specification/);
  });

  it('the SAME stale content still fails when nothing will overwrite it (no JIRA_URL)', () => {
    const out = runMetrolinxShaped(STALE_PRD, false);
    expect(
      out,
      'deferral must not become a blanket exemption for real contamination',
    ).toMatch(/✗.*specification/);
  });
});
