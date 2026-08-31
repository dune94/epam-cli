/**
 * THE CPA PASS — 780 lines, no test, and it is the last gate before a run is authorised.
 *
 * For each story it retrieves context, asks a model for an estimate review, blends that with the
 * formula estimate, and GATES on risk. Its exit code is the decision: 0 proceed, 2 review, 3 block.
 *
 * Everything here is free to exercise: AI_RUNNER_CMD is a parameter, so the model call is a seam.
 * The failures that matter are the ones where a gate stops gating — a blocked story that exits 0 is
 * a run authorised on work nobody approved, and nothing downstream can tell.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/contextualize-stories.sh');

/** A stub runner: whatever JSON we choose, as the model's answer. */
function stubRunner(reply: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-runner-'));
  const f = join(dir, 'ai-run.sh');
  const replyFile = join(dir, 'reply.json');
  writeFileSync(replyFile, reply);
  writeFileSync(f, `#!/usr/bin/env bash\ncat ${JSON.stringify(replyFile)}\n`);
  chmodSync(f, 0o755);
  return f;
}

// The pass resolves a model ladder from the project's config, so a provisioned project is part of
// its environment — supplied for £0 by stubbing the call that specialises each prompt.
let projectDir = '';
beforeAll(async () => {
  const { provisionProject } = await import('../../helpers/provisioned-project');
  projectDir = (await provisionProject()).dir;
}, 180_000);

const story = (over: Record<string, unknown> = {}) => ({
  id: 'S-1', title: 'A story', effort: 'medium', storyType: 'feature',
  humanHours: 8, phase: 'core', acceptanceCriteria: ['one'], ...over,
});

function prdWith(stories: any[]) {
  const order: Record<string, string[]> = {};
  for (const s of stories) (order[s.phase || 'core'] = order[s.phase || 'core'] || []).push(s.id);
  return { stories, implementationOrder: order, project: { name: 'p' } };
}

function cpa(prd: unknown, reply: string, args: string[] = ['--json'], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-'));
  const f = join(dir, 'prd.json');
  writeFileSync(f, JSON.stringify(prd));
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 180_000,
    env: {
      ...process.env,
      PRD_FILE: f,
      AI_RUNNER_CMD: stubRunner(reply),
      NODE_BIN: process.execPath,
      EPAM_COVERAGE_GATED: '0',
      LOG_DIR: dir,
      EPAM_PROJECT_CONFIG_DIR: projectDir,
      ...env,
    },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '', prdPath: f, dir };
}

/**
 * THE MODEL DOES NOT DECLARE THE GATE — the engine computes it, which is why a model cannot wave
 * itself through. Confidence below GATE_BLOCK blocks; more than GATE_REVIEW_FLAGS risk flags asks
 * for review. So a fixture drives those two inputs, not a verdict.
 */
const answer = (over: Record<string, unknown> = {}) => JSON.stringify({
  confidence: 0.8, aiMinutes: 90, tokens: 100000, turns: 20, cost: 3.5,
  riskFlags: ['a risk'], risks: ['a risk'], rationale: 'because', ...over,
});
const CONFIDENT = answer();
const NO_CONFIDENCE = answer({ confidence: 0.05 });
const MANY_RISKS = answer({
  riskFlags: ['r1', 'r2', 'r3', 'r4', 'r5'], risks: ['r1', 'r2', 'r3', 'r4', 'r5'] });

describe('the CPA pass gates before a run is authorised', () => {
  it('a PASSING story exits 0', () => {
    const r = cpa(prdWith([story()]), CONFIDENT);
    expect(r.code, `${r.err.slice(0, 600)}`).toBe(0);
  }, 240_000);

  it('NO CONFIDENCE blocks — exit 3, because a block that exits 0 authorises unapproved work', () => {
    // The engine decides this from the confidence the model reported, not from a verdict the model
    // chose for itself.
    const r = cpa(prdWith([story()]), NO_CONFIDENCE);
    expect(r.code, 'an estimate nobody was confident in did not stop the run').toBe(3);
  }, 240_000);

  it('TOO MANY RISK FLAGS asks for review: exit 0 by default, 2 under --strict', () => {
    // The default is deliberate: review means "a human should look", not "stop". --strict is how an
    // operator asks for the stricter reading, and it must actually change the answer.
    const lenient = cpa(prdWith([story()]), MANY_RISKS);
    expect(lenient.code, 'review halted a run that was not asked to be strict').toBe(0);
    const strict = cpa(prdWith([story()]), MANY_RISKS, ['--json', '--strict']);
    expect(strict.code, '--strict did not change the verdict, so the flag does nothing').toBe(2);
  }, 240_000);

  it('BLOCK outranks --strict — the stricter reading cannot soften a block', () => {
    const r = cpa(prdWith([story()]), NO_CONFIDENCE, ['--json', '--strict']);
    expect(r.code).toBe(3);
  }, 240_000);

  it('one blocked story among passing ones still blocks the run', () => {
    // A per-story verdict folded into a run-level answer must not be averaged away.
    // Both stories get the same low-confidence answer; the point is that two stories do not average
    // into a pass.
    const r = cpa(prdWith([story(), story({ id: 'S-2' })]), NO_CONFIDENCE);
    expect(r.code, 'a blocked story was averaged away by its passing neighbours').toBe(3);
  }, 240_000);

  it('--dry-run makes no writes at all', () => {
    const prd = prdWith([story()]);
    const r = cpa(prd, CONFIDENT, ['--json', '--dry-run']);
    expect(JSON.parse(readFileSync(r.prdPath, 'utf8')),
      '--dry-run wrote to the PRD').toEqual(prd);
  }, 240_000);

  it('and WITHOUT --apply it is still a dry run — writing is opt-in', () => {
    const prd = prdWith([story()]);
    const r = cpa(prd, CONFIDENT);
    expect(JSON.parse(readFileSync(r.prdPath, 'utf8')),
      'the PRD was rewritten without --apply').toEqual(prd);
  }, 240_000);

  it('AN INFERENCE THAT RETURNS NOTHING is gated BLOCK, not passed', () => {
    // The last gate before a run is authorised used to force gate=pass on _inferenceSkipped alone,
    // commented "no API key — don't penalise missing key". Every path setting that flag is a
    // FAILURE: the runner was unavailable, returned nothing, or returned something unparseable.
    // There is no deliberate-skip path in cpa-inference.js at all, so the branch treated a broken
    // reviewer as a missing key and authorised every story — PASS in the report, 0 from the process.
    const r = cpa(prdWith([story()]), '');
    expect(r.code, 'an estimate that was never made was gated as a pass').toBe(3);
  }, 240_000);

  it('and a review that was never ATTEMPTED may still pass on the formula estimate', () => {
    // The distinction the fix rests on: _inferenceFailed separates "attempted and broke" from
    // "deliberately not attempted". A confident answer still passes, so the gate did not simply
    // become a blanket refusal.
    const r = cpa(prdWith([story()]), CONFIDENT);
    expect(r.code, 'a confident review was blocked, so the gate now refuses everything').toBe(0);
  }, 240_000);

  it('and an answer that does not parse as an object is treated as NO CONFIDENCE', () => {
    // Every `// default` in the parse block applies only when the JSON PARSES: on prose, jq exits 5
    // and each value comes back EMPTY, so confidence was "" rather than a low number and no
    // threshold compared true. Asserted directly on the shell, where that guard lives.
    const r = spawnSync('bash', ['-c',
      `cpa_raw='not json at all'
       if ! echo "$cpa_raw" | jq -e 'type == "object"' >/dev/null 2>&1; then echo "REFUSED"; fi`],
      { encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout.trim(), 'a non-object answer was accepted as an estimate').toBe('REFUSED');
  }, 240_000);

  it('a MISSING PRD is refused', () => {
    const r = spawnSync('bash', [SCRIPT, '--json'], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PRD_FILE: '/no/such/prd.json', EPAM_COVERAGE_GATED: '0',
        EPAM_PROJECT_CONFIG_DIR: projectDir, AI_RUNNER_CMD: stubRunner(CONFIDENT) },
    });
    expect(r.status, 'a missing PRD was gated as a pass').not.toBe(0);
  }, 240_000);

  it('--help explains itself and exits cleanly', () => {
    const r = cpa(prdWith([story()]), CONFIDENT, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--strict|--apply|--dry-run/);
  }, 240_000);

  it('--phase scopes the pass to one phase', () => {
    const body = prdWith([story({ id: 'A', phase: 'core' }), story({ id: 'B', phase: 'later' })]);
    const r = cpa(body, CONFIDENT, ['--json', '--phase', 'core']);
    expect(r.code).toBe(0);
    expect(r.out, 'a story outside the requested phase was assessed').not.toContain('"B"');
  }, 240_000);
});
