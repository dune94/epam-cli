/**
 * NO FAILURE IS FILTERED OUT OF SELF-HEAL.
 *
 * Live, regintel run 20260921T140717Z (2026-09-22): REGI-009a burned four attempts and ~$5.50
 * while healing-events.jsonl stayed 0 BYTES — for two days, across two runs. The story was
 * assigned effort low (maxIter=6, maxOutTok=8192), every attempt was truncated at its output cap,
 * and the agent whose entire purpose is to diagnose a failed attempt was never invoked:
 *
 *   run_failure_analyst() {
 *       ...
 *       [ -z "${VERIFICATION_FAILURE:-}" ] && return 0      <-- an attempt that dies before the
 *                                                                suite runs sets nothing here
 *
 * A second silent exit sits below it — "No gate provider configured — skipping self-heal
 * analysis" — which returns 0 and heals nothing.
 *
 * The rule, from the operator: when a retry is done, self-heal is invoked, period. Not by class,
 * not by whether a gate happened to run, not by whether the violation looks like a repeat.
 *
 * Executes the REAL function with the model call stubbed at its seam, so what is asserted is
 * which failures reach the analyst — not what a model says about them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
const HEALING = join(REPO_ROOT, 'orchestrations/scripts/lib/failure-healing.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Runs the real run_failure_analyst with the invocation seam recorded, not performed. */
function analyse(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'self-heal-filter-'));
  dirs.push(dir);
  const seen = join(dir, 'analyst-invoked.txt');
  const out = join(dir, 'attempt.log');
  // the story's own record: the analyst reads its role from the PRD
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: ['S-1'] },
    stories: [{ id: 'S-1', phase: 'core', status: 'pending', agentRole: 'python-engineer',
                acceptanceCriteria: ['x'], technicalNotes: { files: ['regintel/config.py'] } }],
  }));
  writeFileSync(out, 'Error: Response truncated at max_tokens with no usable output\n');
  // THE REAL SCRIPT DIRECTORY, with ONE file replaced: the analyst renders its prompt through
  // the engine's own prompt library, so a bare temp dir makes it refuse before it can be asked
  // which failures reach it. Everything is symlinked; ai-run.sh — the seam where it asks a model
  // — is the recorder.
  // the roster beside the scripts dir, where the analyst looks for its own profile
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'profiles.json'), JSON.stringify({
    'failure-analyst': 'You diagnose why an attempt failed and say what to change.',
    'python-engineer': 'You write Python.',
  }));
  const scriptsDir = join(dir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const realScripts = join(REPO_ROOT, 'orchestrations/scripts');
  for (const e of readdirSync(realScripts)) {
    if (e === 'ai-run.sh') continue;
    symlinkSync(join(realScripts, e), join(scriptsDir, e));
  }
  const aiRun = join(scriptsDir, 'ai-run.sh');
  writeFileSync(aiRun, `#!/usr/bin/env bash\nprintf '%s\\n' "INVOKED" >> ${JSON.stringify(seen)}\ncat > ${JSON.stringify(join(dir, 'analyst-input.txt'))}\necho '{"target":"skill","diagnosis":"x"}'\n`);
  spawnSync('chmod', ['+x', aiRun]);
  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export LOG_DIR=${JSON.stringify(dir)}`,
    `export PROJECT_ROOT=${JSON.stringify(dir)}`,
    `export PRD_FILE=${JSON.stringify(prd)}`,
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }',
    // THE SEAM WHERE THE ANALYST ASKS A MODEL is `bash $SCRIPT_DIR/ai-run.sh` — recorded here,
    // never performed, so what this asserts is which failures REACH the analyst.
    `export SCRIPT_DIR=${JSON.stringify(scriptsDir)}`,
    `export EPAM_CLI=/bin/true`,
    // collaborators the analyst calls, stubbed so the test is about REACH, not about them
    'seam_model_or_fail() { echo "fixture-model"; }',
    'story_acs_block() { echo "ACs"; }',
    '_skill_note_max_chars() { echo 400; }',
    'require_profile() { echo "the failure analyst profile, as the roster mints it"; }',
    // the prompt declares these and refuses on an empty payload — a run supplies them
    // THE PROJECT'S MINTED PROMPTS. The analyst renders a project-authority prompt, so it refuses
    // without one — the same refusal a project that never minted would get. A provisioned project
    // is used read-only; SELFHEAL_PROJECT_DIR overrides it.
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(process.env.SELFHEAL_PROJECT_DIR
      || '/home/bradleyjerome/projects/ai/regintel-pipeline/orchestrations/projects/regintel')}`,
    '_ensure_imperative_opener() { cat; }',
    '_apply_reviewed_tc_patches() { echo 0; }',
    // the prompt refuses on an empty payload, so a run's own values are supplied here too
    '_attempt_change_summary() { echo "regintel/config.py | 12 +++"; }',
    '_analyst_write_scope() { echo "this story may write: regintel/config.py"; }',
    '_analyst_shared_criteria() { echo "none"; }',
    'agent_ladder_model() { echo "fixture-model"; }',
    'record_healing_event() { :; }',
    'evidence_window() { echo 40; }',
    ...Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
    shellFunction(HEALING, 'run_failure_analyst'),
    `run_failure_analyst "S-1" ${JSON.stringify(out)} 1`,
    'echo "rc=$?"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  if (process.env.SELFHEAL_DEBUG) console.log((r.stdout || '') + (r.stderr || ''));
  return {
    invoked: existsSync(seen) && readFileSync(seen, 'utf8').includes('INVOKED'),
    input: existsSync(join(dir, 'analyst-input.txt')) ? readFileSync(join(dir, 'analyst-input.txt'), 'utf8') : '',
    out: (r.stdout || '') + (r.stderr || ''),
  };
}

describe('no failure is filtered out of self-heal', () => {
  it('REPRODUCES the live defect: an attempt that died at its output cap still reaches the analyst', () => {
    // No VERIFICATION_FAILURE, because the attempt was truncated before any suite ran — exactly
    // REGI-009a's attempts 4 and 5 (rawBytes 932, then 0).
    const { invoked } = analyse({
      ORCH_GATE_PROVIDER: 'openrouter',
      EPAM_FAILURE_CLASS: 'output_cap',
      COORDINATOR_FAILURE_CLASS: 'output_cap',
    });
    expect(invoked, 'an output_cap failure never reached the analyst — healing-events.jsonl stays 0 bytes').toBe(true);
  });

  it('a verification failure still reaches the analyst (unchanged behaviour)', () => {
    const { invoked } = analyse({
      ORCH_GATE_PROVIDER: 'openrouter',
      VERIFICATION_FAILURE: '## Verification Failure\n5 failed, 99 passed',
    });
    expect(invoked).toBe(true);
  });

  it('a run with no analyst provider SAYS SO instead of skipping self-heal silently', () => {
    const { invoked, out } = analyse({ ORCH_GATE_PROVIDER: '', EPAM_FAILURE_CLASS: 'timeout' });
    expect(invoked, 'it cannot invoke without a provider').toBe(false);
    expect(out, 'self-heal was skipped without the run being told it is running without self-heal')
      .toMatch(/self-heal/i);
    expect(out).toMatch(/WARN|ERR/);
  });

  it('the analyst is told what failed: the class and the provisioning the attempt ran under', () => {
    const { input } = analyse({
      ORCH_GATE_PROVIDER: 'openrouter',
      EPAM_FAILURE_CLASS: 'output_cap',
      COORDINATOR_FAILURE_CLASS: 'output_cap',
      STORY_MAX_OUTPUT_TOKENS: '8192',
      EPAM_MAX_ITERATIONS: '6',
    });
    expect(input, 'the analyst was asked to diagnose without being told the failure class').toMatch(/output_cap/);
    expect(input, 'the analyst cannot raise a budget it was never shown').toMatch(/8192/);
    expect(input).toMatch(/\b6\b/);
  });
});

/**
 * AND THE ANALYST PROVISIONS THE NEXT ATTEMPT. A starved attempt is not a wrong one; the agent
 * that read the evidence decides the retry's budget. This replaces raise_output_budget_after_cap_hit,
 * which jumped to the widest tier once, never touched iterations, and ran with nothing having
 * diagnosed anything (REGI-009a: fired once at 8192 -> 32768, maxIter stayed 6, attempts 4 and 5
 * hit the cap again).
 */
describe('the analyst provisions the next attempt', () => {
  function analystSays(json: string) {
    const dir = mkdtempSync(join(tmpdir(), 'self-heal-prov-'));
    dirs.push(dir);
    const script = join(dir, 'run.sh');
    const block = shellFunction(HEALING, 'run_failure_analyst');
    // the provisioning decision, executed exactly as it sits in the analyst
    const start = block.indexOf("            target=$(echo \"$analyst_json\" | jq -r '.target // \"none\"'");
    const end = block.indexOf('STORY_MAX_TURNS="$_fa_iters"; export STORY_MAX_TURNS', start);
    if (start === -1 || end === -1) throw new Error('the provisioning block moved');
    const decision = block.slice(start, end + 'STORY_MAX_TURNS="$_fa_iters"; export STORY_MAX_TURNS\n            fi'.length);
    writeFileSync(script, [
      '#!/usr/bin/env bash',
      'log() { echo "LOG: $*"; }',
      'STORY_MAX_OUTPUT_TOKENS=8192; EPAM_MAX_ITERATIONS=6',
      `analyst_json=${JSON.stringify(json)}`,
      decision.replace(/^ {12}local /m, '            local '),
      'echo "OUT=$STORY_MAX_OUTPUT_TOKENS ITER=$EPAM_MAX_ITERATIONS"',
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
    return (r.stdout || '') + (r.stderr || '');
  }

  it('raises the output budget and the iterations the analyst asked for', () => {
    const out = analystSays('{"target":"skill","provisioning":{"maxOutputTokens":32768,"maxIterations":60,"why":"truncated at 8192 with 3 of 8 files written"}}');
    expect(out).toMatch(/OUT=32768 ITER=60/);
    expect(out, 'the reason the budget moved was not recorded').toMatch(/truncated at 8192/);
  });

  it('changes NOTHING when the analyst asks for nothing — a budget cannot fix a wrong approach', () => {
    const out = analystSays('{"target":"skill","diagnosis":"the accessor reads attributes from a dict"}');
    expect(out).toMatch(/OUT=8192 ITER=6/);
  });

  it('never lowers a budget', () => {
    const out = analystSays('{"target":"skill","provisioning":{"maxOutputTokens":1024,"maxIterations":2,"why":"x"}}');
    expect(out).toMatch(/OUT=8192 ITER=6/);
  });
});
