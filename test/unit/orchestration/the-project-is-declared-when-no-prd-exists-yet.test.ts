/**
 * A JIRA RUN DECLARES ITS PROJECT, BECAUSE ITS PRD DOES NOT EXIST YET.
 *
 * tier3-mock-run.sh resolves the project config dir from `project.name` in the PRD, and refuses to
 * guess when it is absent — correctly, because guessing is how a run gets configured from a project
 * nobody chose, against a client repository.
 *
 * But a Jira-driven run has NO PRD at launch. The PRD is synthesized during ingest, at the path
 * given by JIRA_SYNTH_PRD_PATH, which is the same path handed to --prd. So the launcher was reading
 * a file that could not exist yet and refusing every Jira flow on the spot:
 *
 *   mock1-paused-run.sh:265     --prd "$SYNTH_PRD"   (written later, by ingest)
 *   brownfield-mock-e2e         --prd synthPrdPath   (likewise)
 *
 * The paid metrolinx launcher survived only by accident of shape: it points PRD_FILE at the
 * project's canonical prd.json, which pre-exists because pre-run-reset restores it. Nothing about
 * that is Jira-specific, so the incompatibility stayed invisible.
 *
 * THE FIX IS A DECLARATION, NOT A DEFAULT. When there is no PRD to read, the caller says which
 * project it is running — the same `--project <name>` orchestrate.sh has always taken. An absent
 * declaration is still refused. The library keeps its own stated rule: NO DEFAULT.
 *
 * A CONFLICT IS REFUSED TOO. If a PRD names one project and the caller declares another, silently
 * preferring either is the original defect wearing a new hat.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/project-config.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

/** The real function, executed. */
function resolve(prdPath: string, declared: string) {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}
     resolve_run_project ${JSON.stringify(prdPath)} ${JSON.stringify(declared)}`],
    {
      encoding: 'utf8', timeout: 60000, cwd: SCRIPTS,
      // Inherit so the shell coverage collector's BASH_ENV instrumentation survives; a hand-built
      // { PATH, HOME } makes every line this suite executes invisible to the meter.
      env: { ...process.env, NODE_BIN: NODE20 } as any,
    });
  return { name: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

const DIR = mkdtempSync(join(tmpdir(), 'declared-project-'));
const NAMED = join(DIR, 'named.json');
const UNNAMED = join(DIR, 'unnamed.json');
const MISSING = join(DIR, 'not-written-yet.json');
writeFileSync(NAMED, JSON.stringify({ project: { name: 'hello-dolly' } }));
writeFileSync(UNNAMED, JSON.stringify({ project: {} }));

describe('the project is declared when no PRD exists yet', () => {
  it('a PRD that names a project still wins — nothing about that changes', () => {
    const r = resolve(NAMED, '');
    expect(r.status, r.err).toBe(0);
    expect(r.name).toBe('hello-dolly');
  }, 70_000);

  it('THE DEFECT: no PRD yet, but the caller declared the project — it resolves', () => {
    const r = resolve(MISSING, 'hello-dolly');
    expect(r.status, `a Jira run was refused though its project was declared:\n${r.err}`).toBe(0);
    expect(r.name).toBe('hello-dolly');
  }, 70_000);

  it('a PRD that exists but names nothing is still refused when nothing is declared', () => {
    const r = resolve(UNNAMED, '');
    expect(r.status, 'an unnamed PRD resolved a project out of nowhere').not.toBe(0);
  }, 70_000);

  it('NO DEFAULT: no PRD and no declaration is refused, and says what is missing', () => {
    const r = resolve(MISSING, '');
    expect(r.status, 'the launcher guessed a project — these run against client repositories')
      .not.toBe(0);
    expect(r.err, 'the refusal does not say what to provide').toMatch(/project/i);
  }, 70_000);

  it('a conflict between the PRD and the declaration is refused, never silently preferred', () => {
    const r = resolve(NAMED, 'metrolinx');
    expect(r.status, 'one of two disagreeing project names was chosen silently').not.toBe(0);
  }, 70_000);

  it('every launcher that hands over a to-be-synthesized PRD declares its project', () => {
    // The callers are the point: fixing the resolver and leaving them passing a path that cannot
    // exist yet would leave every Jira flow refused exactly as before.
    const callers = readdirSync(SCRIPTS).filter((f) => /\.sh$/.test(f));
    const offenders: string[] = [];
    for (const f of callers) {
      const src = readFileSync(join(SCRIPTS, f), 'utf8');
      if (!/JIRA_SYNTH_PRD_PATH=/.test(src)) continue;
      if (!/--project(?![-\w])/.test(src)) offenders.push(f);
    }
    expect(offenders, 'these synthesize a PRD at launch but declare no project, so they are refused')
      .toEqual([]);
  });
});
