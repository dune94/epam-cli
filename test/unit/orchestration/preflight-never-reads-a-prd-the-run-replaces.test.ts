/**
 * PRE-FLIGHT MUST NOT VALIDATE — OR REPORT — A PRD FIELD THE RUN HAS NOT WRITTEN YET.
 *
 * preflight-check.sh runs BEFORE ingest. At that moment orchestrations/projects/<p>/prd.json is,
 * by definition, NOT this run's PRD: it is whatever was left on disk — the file the install
 * shipped, or the PREVIOUS run's output. resolve-codeline-scope.sh → apply-codeline-scope.js
 * writes project.outputDir/outputDirs later, from the codelines discovery actually resolves.
 *
 * The gate already knows this. It reads the codeline root from the VARIABLE
 * (_codeline_root="${JIRA_CODELINE_ROOT:-}") and carries two deferral branches whose own comment
 * says "project.outputDir is WRITTEN BY THE RUN … this gate demanded a field the pipeline had not
 * created yet". But the branches are ordered VALUE-FIRST:
 *
 *     if   [[ -n "$OUTPUT_DIR_VAL" ]];          then ok "PRD project.outputDir = $OUTPUT_DIR_VAL"
 *     elif [[ "$_prd_pending_ingest" == "1" ]]; then ok "... deferred"
 *     elif [[ -n "$_codeline_root" ]];          then ok "... deferred"
 *
 * so both deferrals are unreachable whenever the stale file happens to carry a value — which is
 * every fresh install, because prd.json is committed to the repo.
 *
 * Found live 2026-09-04, pipeline-tests-10: a run correctly targeting
 * /home/…/tests/codelines reported "✓ PRD project.outputDir = /home/…/metrolinx/next.gotransit.com"
 * — a REAL CLIENT PATH — at pre-flight, from the shipped stale prd.json. Nothing acted on it (ingest
 * regenerated the PRD correctly minutes later) but a gate that prints a client path as a ✓ for a run
 * that is not targeting it is reporting on a file it was written to ignore.
 *
 * THE CONDITION IS TESTED BEFORE THE VALUE: when scope is resolved during the run, the field is not
 * read, not reported, and not compared.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const PREFLIGHT = join(REPO, 'orchestrations/scripts/preflight-check.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A PRD carrying a resolved outputDir from an EARLIER run — exactly what a fresh install ships. */
function stalePrd(outputDir: string) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-stale-prd-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    id: 'from-a-previous-run',
    project: {
      name: 'acme',
      outputDir,
      outputDirs: [{ codeline: 'someline', path: outputDir }],
    },
    stories: [],
    implementationOrder: { core: [] },
  }, null, 2));
  return prd;
}

function runPreflight(prd: string, env: Record<string, string>) {
  const r = spawnSync('bash', [PREFLIGHT], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PRD_FILE: prd, ...env },
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

describe('pre-flight defers outputDir when the RUN resolves scope — it never reports a stale value', () => {
  it('with JIRA_CODELINE_ROOT declared, a stale outputDir is NOT read out and reported', () => {
    const STALE = '/home/someone/real-client-repos/next.example.com';
    const root = mkdtempSync(join(tmpdir(), 'preflight-codeline-root-'));
    dirs.push(root);
    mkdirSync(join(root, 'someline'), { recursive: true });

    const out = runPreflight(stalePrd(STALE), { JIRA_CODELINE_ROOT: root });

    // THE DEFECT: the gate prints a path belonging to a run that already ended, as a ✓ for this one.
    expect(out, 'pre-flight reported a stale PRD outputDir that this run will overwrite')
      .not.toContain(STALE);
    // ...and says so, rather than going silent (a silent gate is indistinguishable from a skipped one).
    expect(out, 'pre-flight did not say WHY it skipped the outputDir check')
      .toMatch(/outputDir check deferred|resolved during the run/i);
  });

  it('the stale value is not used for the OUTPUT_DIR comparison either', () => {
    // The comparison below the branch has the same flaw: it fires on $OUTPUT_DIR_VAL being
    // non-empty, so a stale value could FAIL a run whose real target differs from a dead file's.
    const STALE = '/home/someone/real-client-repos/next.example.com';
    const root = mkdtempSync(join(tmpdir(), 'preflight-codeline-root-'));
    dirs.push(root);

    const out = runPreflight(stalePrd(STALE), {
      JIRA_CODELINE_ROOT: root,
      OUTPUT_DIR: '/somewhere/this/run/actually/targets',
    });

    expect(out, 'a stale PRD outputDir was compared against this run\'s real OUTPUT_DIR')
      .not.toMatch(/does NOT match PRD outputDir/);
  });

  it('with NO codeline root and NO pending ingest, a declared outputDir is still checked — the gate is not simply disabled', () => {
    // The deferral must be scoped to "the run resolves this later", never a blanket skip: a project
    // that genuinely declares its own outputDir up front still gets it verified.
    const target = mkdtempSync(join(tmpdir(), 'preflight-declared-target-'));
    dirs.push(target);
    const out = runPreflight(stalePrd(target), { JIRA_CODELINE_ROOT: '', OUTPUT_DIR: target });
    expect(out, 'a genuinely declared outputDir stopped being verified at all')
      .toMatch(new RegExp(`outputDir`, 'i'));
  });
});
