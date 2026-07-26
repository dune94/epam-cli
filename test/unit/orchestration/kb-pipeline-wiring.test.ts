/**
 * The pipeline's own failure path feeds and reads the KB.
 *
 * BEHAVIOURAL, not source-regex. The existing healing-recorder tests are twelve
 * assertions of the form `expect(body).toMatch(/"diagnosis"/)` — they would all
 * still pass if the recorder wrote garbage. These execute the real bash function
 * and assert what lands on disk.
 *
 * Two connections:
 *   RECORD  run_healing_recorder also writes a KB episode keyed by the signature
 *           derived from $VERIFICATION_FAILURE (tsc/vitest output), not from the
 *           analyst's prose.
 *   APPLY   before the next attempt, matching constraints are compiled onto the
 *           STORY_* knobs the invocation actually reads — enforcement, not advice.
 *
 * Always on: there is no flag. Self-heal runs in every run by design.
 * the flag is set deliberately. The last test asserts that directly, because
 * "landed but inert" is the only safe way to put this in front of a real run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const src = readFileSync(CLAUDE_SH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Extract a brace-matched function body from claude.sh and run it standalone. */
function extractFn(name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unterminated ${name}`);
}

function runRecorder(env: Record<string, string>) {
  const logDir = mkdtempSync(join(tmpdir(), 'kb-pipe-')); dirs.push(logDir);
  const kbRoot = join(logDir, 'kb');
  const script = `
set -uo pipefail
log() { :; }
LOG_DIR=${JSON.stringify(logDir)}
KB_ROOT=${JSON.stringify(kbRoot)}
SCRIPT_DIR=${JSON.stringify(join(LIB, '..'))}
${extractFn('run_healing_recorder')}
run_healing_recorder "S-1" 0 none "Missing closing brace somewhere" 0 false
`;
  execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, KB_ROOT: kbRoot, ...env },
  });
  return { logDir, kbRoot };
}

describe('RECORD — the pipeline writes a KB episode keyed by tool output', () => {
  it('derives the signature from $VERIFICATION_FAILURE, not from the diagnosis', () => {
    const { kbRoot } = runRecorder({
      EPAM_KB_SELFHEAL: '1',
      VERIFICATION_FAILURE: "src/svc/discount.ts(77,3): error TS1005: ';' expected.",
      STORY_ROLE: 'typescript-engineer',
    });
    const ep = JSON.parse(readFileSync(join(kbRoot, 'healing-events.jsonl'), 'utf8').trim());
    expect(ep.signature).toBe('TS1005');
    expect(ep.signature_source).toBe('tsc');
    expect(ep.agent_role).toBe('typescript-engineer');
  });

  it('still writes the legacy healing-events.jsonl the dashboard reads', () => {
    const { logDir } = runRecorder({
      EPAM_KB_SELFHEAL: '1',
      VERIFICATION_FAILURE: 'src/a.ts(1,1): error TS2532: x',
      STORY_ROLE: 'r',
    });
    const legacy = readFileSync(join(logDir, 'healing-events.jsonl'), 'utf8');
    expect(legacy).toContain('"story_id":"S-1"');
  });

  it('records with NO flag set — self-heal is always on', () => {
    // The EPAM_KB_SELFHEAL switch is gone. A permanent off-switch on a feature
    // that is supposed to be running is indistinguishable from the feature being
    // broken, which is the failure mode this pipeline keeps hitting.
    const { kbRoot } = runRecorder({
      VERIFICATION_FAILURE: "src/a.ts(1,1): error TS2532: Object is possibly 'undefined'.",
      STORY_ROLE: 'r',
    });
    const f = join(kbRoot, 'healing-events.jsonl');
    expect(existsSync(f) && readFileSync(f, 'utf8').trim() !== '',
      'no episode recorded without a flag — self-heal is still gated').toBe(true);
  });

  it('survives tool output with no derivable signature', () => {
    const { kbRoot } = runRecorder({
      EPAM_KB_SELFHEAL: '1', VERIFICATION_FAILURE: 'the agent was confused', STORY_ROLE: 'r',
    });
    const ep = JSON.parse(readFileSync(join(kbRoot, 'healing-events.jsonl'), 'utf8').trim());
    expect(ep.signature).toBeNull();
  });
});

describe('APPLY — constraints land on the knobs the invocation reads', () => {
  it('kb_apply_constraints exports the tier override from a stored rule', () => {
    const kbRoot = mkdtempSync(join(tmpdir(), 'kb-apply-')); dirs.push(kbRoot);
    const cli = join(LIB, 'kb-cli.js');
    const env = { ...process.env, KB_ROOT: kbRoot };
    execFileSync(process.execPath, [cli, 'record', '--id', 'e1', '--agent-role', 'typescript-engineer'],
      { input: 'src/a.ts(1,1): error TS2532: x', env, encoding: 'utf8' });
    execFileSync(process.execPath, [cli, 'synthesize', '--agent-role', 'typescript-engineer',
      '--signature', 'TS2532', '--enforcement',
      JSON.stringify({ kind: 'effort_tier', tier: 'high' }),
      '--reason', 'r'], { env, encoding: 'utf8' });

    const out = execFileSync('bash', ['-c', `
set -uo pipefail
STORY_MAX_ITERATIONS=6
source ${JSON.stringify(join(LIB, 'kb-apply.sh'))}
kb_apply_constraints typescript-engineer TS2532
echo "EPAM_EFFORT_TIER=\${EPAM_EFFORT_TIER:-unset}"
`], { encoding: 'utf8', env: { ...env, EPAM_KB_SELFHEAL: '1' } });
    // Budget params are unconstructable now; the bounded channel is the tier,
    // which resolve_effort_settings() applies upgrade-only.
    expect(out).toMatch(/EPAM_EFFORT_TIER=.?high/);
  });

  it('leaves the knob untouched when no constraint matches', () => {
    const kbRoot = mkdtempSync(join(tmpdir(), 'kb-apply2-')); dirs.push(kbRoot);
    const out = execFileSync('bash', ['-c', `
set -uo pipefail
STORY_MAX_ITERATIONS=6
source ${JSON.stringify(join(LIB, 'kb-apply.sh'))}
kb_apply_constraints typescript-engineer TS9999
echo "STORY_MAX_ITERATIONS=$STORY_MAX_ITERATIONS"
`], { encoding: 'utf8', env: { ...process.env, KB_ROOT: kbRoot, EPAM_KB_SELFHEAL: '1' } });
    expect(out).toMatch(/STORY_MAX_ITERATIONS=6/);
  });

  it('applies a stored constraint with NO flag set — self-heal is always on', () => {
    const kbRoot = mkdtempSync(join(tmpdir(), 'kb-apply3-')); dirs.push(kbRoot);
    const cli = join(LIB, 'kb-cli.js');
    const env = { ...process.env, KB_ROOT: kbRoot };
    execFileSync(process.execPath, [cli, 'record', '--id', 'e1', '--agent-role', 'r'],
      { input: 'src/a.ts(1,1): error TS2532: x', env, encoding: 'utf8' });
    execFileSync(process.execPath, [cli, 'synthesize', '--agent-role', 'r', '--signature', 'TS2532',
      '--enforcement', JSON.stringify({ kind: 'effort_tier', tier: 'high' }),
      '--reason', 'r'], { env, encoding: 'utf8' });
    const out = execFileSync('bash', ['-c', `
set -uo pipefail
STORY_MAX_ITERATIONS=6
source ${JSON.stringify(join(LIB, 'kb-apply.sh'))}
kb_apply_constraints r TS2532
echo "EPAM_EFFORT_TIER=\${EPAM_EFFORT_TIER:-unset}"
`], { encoding: 'utf8', env });   // flag deliberately absent
    expect(out).toMatch(/EPAM_EFFORT_TIER=.?high/);
  });
});
