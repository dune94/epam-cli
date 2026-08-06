/**
 * team-lead-review.sh's OWN model ladder (separate from ai-run.sh's and
 * claude.sh's — a third, hand-rolled implementation) must resume across
 * SEPARATE team-lead-review.sh subprocess invocations, not reset every time.
 *
 * Root cause (found 2026-08-06, following the "ladder logic applies to ALL
 * agents" instruction): team-lead-review.sh is invoked as a brand-new
 * subprocess by Step 3.6 on EVERY review cycle
 * (`"$SCRIPT_DIR/team-lead-review.sh" "$PHASE"`). Its own run_review_prompt()
 * escalates at most once per invocation (REVIEW_MAX_ATTEMPTS default 2,
 * base model always ORCH_GATE_MODEL) — so no matter how many rejection
 * cycles ran, the reviewer's OWN model never climbed past its first
 * escalation. This is a second, independent instance of the exact bug class
 * fixed for the writer (claude.sh) and generalized to every agent
 * (ai-run.sh).
 *
 * This test extracts and executes the REAL run_review_prompt() (same
 * line-anchor extraction technique as ai-run-provider-dispatch.test.ts) with
 * a stub AI_RUNNER_CMD that always fails and records the --model it was
 * invoked with — proving the SECOND invocation resumes past the model the
 * first invocation escalated to.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const REVIEW_SH = join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh');
const STORY_RETRY_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const reviewSrc = readFileSync(REVIEW_SH, 'utf8');

function extractFunctionByLineAnchor(name: string): string {
  const lines = reviewSrc.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'review-ladder-'));
  dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const modelsSeenFile = join(dir, 'models-seen.txt');
  writeFileSync(modelsSeenFile, '');

  // Emits NOTHING (not even to stderr) — run_review_prompt's own "did the
  // reviewer actually produce a verdict?" check treats empty output as a
  // thrash/stall and escalates the ladder. Anything non-empty (even an
  // error message) would be swallowed as a bogus "verdict" and stop the
  // loop after one attempt, which is not what's under test here.
  const runnerStub = join(dir, 'ai-run-stub.sh');
  writeFileSync(runnerStub, `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$prev" = "--model" ]; then echo "$a" >> ${JSON.stringify(modelsSeenFile)}; fi
  prev="$a"
done
exit 1
`);
  chmodSync(runnerStub, 0o755);
  return { dir, logDir, runnerStub, modelsSeenFile };
}

/** Runs run_review_prompt() in a fresh bash process — simulating a fresh team-lead-review.sh subprocess. */
function invoke(logDir: string, runnerStub: string, storyId: string) {
  const script = join(logDir, `invoke-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, `#!/usr/bin/env bash
set -o pipefail
source ${JSON.stringify(STORY_RETRY_LIB)}
LOG_DIR=${JSON.stringify(logDir)}
AI_RUNNER_CMD=${JSON.stringify(runnerStub)}
ORCH_GATE_MODEL=model-a
EPAM_MODEL_LADDER_HIGH='model-a=model-b|model-b=model-c|model-c=model-d'
REVIEW_MAX_ATTEMPTS=2
story_id=${JSON.stringify(storyId)}
PROJECT_ROOT=${JSON.stringify(logDir)}
AUTOMATION_DIR=${JSON.stringify(logDir)}
MONITOR_FILE=${JSON.stringify(join(logDir, 'monitor.json'))}
warning(){ echo "WARN: $*" >&2; }
${extractFunctionByLineAnchor('_ladder_next_model')}
${extractFunctionByLineAnchor('_ladder_skip_reason')}
${extractFunctionByLineAnchor('_provider_for_model')}
${extractFunctionByLineAnchor('run_review_prompt')}
run_review_prompt "some prompt" >/dev/null 2>>${JSON.stringify(join(logDir, 'stderr.txt'))}
`);
  return spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
}

describe('team-lead-review.sh — the review-agent ladder resumes across invocations', () => {
  it('a fresh invocation still escalates model-a -> model-b within itself (unchanged baseline)', () => {
    const { logDir, runnerStub, modelsSeenFile } = setup();
    invoke(logDir, runnerStub, 'S-1');
    const seen = readFileSync(modelsSeenFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(seen).toEqual(['model-a', 'model-b']);
  });

  it('THE FIX: a SECOND separate subprocess for the SAME story resumes past model-a/model-b', () => {
    const { logDir, runnerStub, modelsSeenFile } = setup();
    invoke(logDir, runnerStub, 'S-1'); // cycle 1 — reaches model-b
    writeFileSync(modelsSeenFile, '');
    invoke(logDir, runnerStub, 'S-1'); // cycle 2 — a fresh subprocess, same story
    const seenSecond = readFileSync(modelsSeenFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(
      seenSecond,
      'the second review cycle re-invoked model-a — the reviewer ladder silently reset instead of resuming',
    ).not.toContain('model-a');
    expect(seenSecond).toEqual(['model-b', 'model-c']);
  });

  it('a DIFFERENT story is unaffected — resume state is scoped per story', () => {
    const { logDir, runnerStub, modelsSeenFile } = setup();
    invoke(logDir, runnerStub, 'S-1');
    writeFileSync(modelsSeenFile, '');
    invoke(logDir, runnerStub, 'S-2');
    const seen = readFileSync(modelsSeenFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(seen, "a sibling story's review ladder must start fresh").toEqual(['model-a', 'model-b']);
  });
});
