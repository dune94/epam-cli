import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A STAGE THAT CANNOT DO ITS JOB MUST SAY SO AND STOP.
 *
 * Both blockers on 2026-09-02 were SILENT degradations, not wrong answers:
 *
 *   the baseline gate could not build its cache, ran `rm -f "$baseline_cache"`, and carried on with
 *   NO subtraction — so a pre-existing flake was charged to the story and the writer burned its
 *   retries against a failure it could not fix.
 *
 *   the analyst was handed a ~1,141,382-token prompt against a 1,000,000 limit, and instead of
 *   refusing, escalated claude-sonnet-5 -> claude-opus-4-8 -> claude-opus-5 on three calls that
 *   could not succeed at any model.
 *
 * Neither said "I cannot do this". Each cost ~20 minutes of run time to discover indirectly.
 *
 * INPUTS ARE REAL ARTEFACTS, NOT FIXTURES I INVENTED. Every green test that shipped a broken fix
 * today used a shape I imagined; the shape production produces is ONE failing entry inside a huge
 * output, and that is the branch that was never executed.
 */
const REPO = path.resolve(__dirname, '../..');
// PARKED IN THE REPO, because the pipeline deletes its own working copy: pre-run-reset clears
// orchestrations/logs/kb-scratchpad/, so reading from there passes until the next run and then
// fails with "artefact missing" — which is what happened on 2026-09-02, an hour after these tests
// went green. Real captured output, not a fixture anyone wrote.
const REAL_FAILURE = path.join(REPO, 'test/fixtures/real-run-artefacts/AMSD-1919-suite-failure.txt');

describe('the pipeline refuses what it cannot do', () => {
  const boundFailures = path.join(REPO, 'orchestrations/scripts/lib/handlers/bound-failures.js');

  it('the real 2.49MB suite output is bounded — the single-entry case production actually produces', () => {
    expect(fs.existsSync(REAL_FAILURE), `real artefact missing: ${REAL_FAILURE}`).toBe(true);
    const real = fs.readFileSync(REAL_FAILURE, 'utf8');
    // NOT "bigger than a number I picked": bigger than the DECLARED window, which is the only
    // property that makes this artefact exercise the bounding path at all.
    const declared = Number(JSON.parse(fs.readFileSync(
      path.join(REPO, 'orchestrations/config/evidence-windows.json'), 'utf8',
    )).windows.failureExcerptLines.value);
    expect(real.split('\n').length,
      'the artefact does not exceed the declared window, so it cannot exercise bounding')
      .toBeGreaterThan(declared);

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'trap-'));
    fs.mkdirSync(path.join(repo, '.epam'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.epam', 'verification.json'), JSON.stringify({
      typecheck: { command: 'true' },
      test: { command: 'true', failurePattern: '^\\s*FAIL\\s+(\\S+)', failureIdentity: '{1}' },
    }));

    const r = spawnSync(process.execPath, [boundFailures, repo, 'test'], {
      input: real, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    });
    const out = r.stdout ?? '';
    expect(out.length, 'handler produced nothing').toBeGreaterThan(0);

    // THE CONTRACT IS THE DECLARED WINDOW, and nothing else. An earlier version of this test
    // asserted "< 1,000,000 chars" and allowed "limit + 6" lines of slack — two numbers I invented,
    // neither derived from anything. The char ceiling passed for the wrong reason (a jest failure
    // summary sits near the END of the file, so slicing from the first failure alone drops millions
    // of characters while the limit itself stays untested), and the slack is exactly the margin a
    // regression hides in.
    //
    // The window comes from config/evidence-windows.json. The boundary between kept content and the
    // handler's own truncation note comes from the note itself, so no margin is guessed.
    const limit = Number(JSON.parse(fs.readFileSync(
      path.join(REPO, 'orchestrations/config/evidence-windows.json'), 'utf8',
    )).windows.failureExcerptLines.value);
    expect(Number.isFinite(limit) && limit > 0, 'failureExcerptLines is not declared').toBe(true);

    const content = out.split('[... ')[0];          // the handler states its own cut; split on it
    const lines = content.split('\n').filter((l) => l.length > 0).length;
    expect(lines, `kept ${lines} lines but the declared window is ${limit}`)
      .toBeLessThanOrEqual(limit);
  });

  it('the baseline gate FAILS LOUDLY when it cannot produce its cache, instead of continuing', () => {
    const gate = path.join(REPO, 'orchestrations/scripts/lib/tsc-baseline-gate.sh');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nobase-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    // a baseline SHA that does not exist in this repo => the cache CANNOT be built
    fs.writeFileSync(path.join(logDir, 'phase-baseline-sha.txt'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'o-'));
    const outFile = path.join(out, 'f');
    fs.writeFileSync(outFile, '  FAIL src/a.spec.tsx\n    expected 1 to be 2\n');

    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       AUTOMATION_DIR="${path.join(REPO, 'orchestrations')}"
       NODE_BIN="${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node"
       . "${gate}"
       baseline_new_failures "${repo}" "$NODE_BIN" "${logDir}" test "${outFile}"
       echo "RC=$?"`,
    ], { encoding: 'utf8', timeout: 120_000 });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(text.length, 'gate produced nothing — vacuous').toBeGreaterThan(0);

    const cacheWritten = fs.readdirSync(logDir).some((f) => f.startsWith('baseline-failures-'));
    expect(cacheWritten, 'no cache was produced, so the gate MUST say so').toBe(false);
    // THE TRAP'S OWN MARKER, not a loose word list. An earlier version matched
    // /cannot|could not|.../ which incidental text elsewhere in the output satisfied, so silencing
    // the trap left the test green — md5 confirmed the mutation applied and it still passed. A test
    // that cannot go red for the defect it names is not a test.
    expect(text, `the gate degraded silently instead of naming the failure:\n${text.slice(0, 400)}`)
      .toMatch(/\[baseline-gate\]/);
    expect(text, 'the gate must say the failures will be misattributed, not merely that it failed')
      .toMatch(/attributed to this story/i);
  });
});

/**
 * THE BASELINE CACHE MUST ACTUALLY BE PRODUCED.
 *
 * Everything above proves the gate is LOUD when it fails. This asks the question that has never
 * been answered: with a real codeline, a real resolvable baseline, and the real suite output from
 * the failed run, does baseline_new_failures write its cache?
 *
 * No baseline-failures-* file has ever existed on this machine, for any section. Until one does,
 * every pre-existing failure is charged to the story — which is what blocked AMSD-1919 through all
 * 12 writer retries against a flake in FullScheduleTable/SearchBox.spec.tsx that the change never
 * touched.
 *
 * Real inputs only: the real codeline, the baseline SHA the run itself recorded, and the captured
 * output. No models, no pipeline run.
 */
describe('the baseline cache, with real inputs', () => {
  const REPO2 = path.resolve(__dirname, '../..');
  // DERIVED FROM THE PRD, never a machine path: a test that names one laptop and one client is
  // not a test of the pipeline, and hardcoding is what the engine itself is forbidden to do.
  const projectsDir = path.join(REPO2, 'orchestrations/projects');
  let CODELINE = '';
  for (const project of fs.readdirSync(projectsDir)) {
    const prdPath = path.join(projectsDir, project, 'prd.json');
    if (!fs.existsSync(prdPath)) continue;
    let j: any;
    try { j = JSON.parse(fs.readFileSync(prdPath, 'utf8')); } catch { continue; }
    const dirs = (j.project && j.project.outputDirs) || [];
    const hit = dirs.find((d: any) => d && d.path && fs.existsSync(path.join(d.path, '.git')));
    if (hit) { CODELINE = hit.path; break; }
  }
  if (!CODELINE) throw new Error('no PRD points at a checked-out codeline — driven by real inputs');
  const gate = path.join(REPO2, 'orchestrations/scripts/lib/tsc-baseline-gate.sh');

  it('writes a baseline-failures cache for section=test', () => {
    const sha = execFileSync('git', ['-C', CODELINE, 'rev-parse', 'origin/develop'], { encoding: 'utf8' }).trim();
    expect(sha, 'could not resolve the real baseline').toMatch(/^[0-9a-f]{40}$/);

    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realbase-'));
    fs.writeFileSync(path.join(logDir, 'phase-baseline-sha.txt'), `${sha}\n`);

    const outFile = path.join(logDir, 'suite-output.txt');
    fs.copyFileSync(REAL_FAILURE, outFile);          // the real captured suite output

    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       AUTOMATION_DIR="${path.join(REPO2, 'orchestrations')}"
       NODE_BIN="${process.env.HOME}/.nvm/versions/node/v20.20.0/bin/node"
       JIRA_BASELINE_BRANCH=develop
       . "${gate}"
       baseline_new_failures "${CODELINE}" "$NODE_BIN" "${logDir}" test "${outFile}" >/dev/null
       echo "RC=$?"`,
    ], { encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });

    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(text.length, 'gate produced nothing — vacuous').toBeGreaterThan(0);

    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('baseline-failures-'));
    expect(files, `no cache produced. gate said:\n${text.slice(0, 800)}`).not.toEqual([]);
    expect(files[0]).toBe(`baseline-failures-test-${sha.slice(0, 12)}.txt`);

    // EXISTENCE IS NOT ENOUGH. An EMPTY cache says "nothing was failing at baseline", so every
    // current failure is still counted as new and the story is blamed exactly as before — the same
    // wrong outcome, now with a file to point at. Asserting only that the file appeared is the
    // vacuous pass this suite exists to prevent.
    const body = fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim();
    expect(body.length, 'the baseline cache is EMPTY — nothing will be subtracted').toBeGreaterThan(0);

    // AND it must contain what the codeline was actually failing at baseline. The captured run
    // recorded exactly one pre-existing failure; if the baseline does not carry it, the subtraction
    // cannot work no matter what the file says.
    const delta = text;
    expect(body, `baseline holds no failing suite. cache:\n${body.slice(0, 300)}`)
      .toMatch(/\.(spec|test)\.[jt]sx?/);
    expect(delta, 'the story is still being blamed for a pre-existing failure')
      .not.toMatch(/ProductContainer\.spec\.tsx/);
  });
});
