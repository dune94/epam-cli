import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('checkpoint/resume — source contract', () => {
  it('completed status check exists in the story loop', () => {
    expect(orchSrc).toContain('"$_story_current_status" = "completed"');
  });

  it('[CHECKPOINT] Skipping log message exists', () => {
    expect(orchSrc).toContain('[CHECKPOINT] Skipping');
    expect(orchSrc).toContain('already completed in prd.json');
  });

  it('phase-level _ckpt_total/_ckpt_done check exists', () => {
    expect(orchSrc).toContain('_ckpt_total');
    expect(orchSrc).toContain('_ckpt_done');
  });

  it('phase-level check skips loop when all stories completed', () => {
    expect(orchSrc).toContain('_ckpt_done:-0}" -ge "${_ckpt_total:-0}');
    expect(orchSrc).toContain('all checkpointed');
  });

  it('completed check fires AFTER deprecated and blocked checks', () => {
    const deprecatedPos = orchSrc.indexOf('"$_story_current_status" = "deprecated"');
    const blockedPos = orchSrc.indexOf('"$_story_current_status" = "blocked"');
    const completedPos = orchSrc.indexOf('"$_story_current_status" = "completed"');
    expect(deprecatedPos).toBeGreaterThan(0);
    expect(blockedPos).toBeGreaterThan(deprecatedPos);
    expect(completedPos).toBeGreaterThan(blockedPos);
  });

  it('completed check fires BEFORE checkpoint_already_done', () => {
    const completedPos = orchSrc.indexOf('"$_story_current_status" = "completed"');
    const ckptPos = orchSrc.indexOf('checkpoint_already_done "$story"');
    expect(completedPos).toBeGreaterThan(0);
    expect(ckptPos).toBeGreaterThan(completedPos);
  });
});

describe('checkpoint/resume — story-level skip behaviour', () => {
  it('skips completed stories without running them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-resume-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [
          { id: 'TST-001', status: 'completed', agentRole: 'backend' },
          { id: 'TST-002', status: 'pending',   agentRole: 'backend' },
        ]
      }));

      // Build a minimal script that replays just the live-status checks for a
      // single story, writing to a file if the story "ran" (i.e. was not skipped).
      const ran = join(dir, 'ran.txt');
      const script = join(dir, 'test-ckpt.sh');
      writeFileSync(script, `#!/bin/bash
PRD_FILE="${prdFile}"
ORCH_RUN_ID="test-run"
CHECKPOINT_FILE="${dir}/ckpt.jsonl"
info() { echo "INFO: $*"; }
checkpoint_already_done() { return 1; }

run_story() {
  local story="$1"
  _story_current_status=$(jq -r --arg id "$story" \\
    '.stories[] | select(.id == $id) | .status // "pending"' \\
    "$PRD_FILE" 2>/dev/null || echo "pending")
  if [ "$_story_current_status" = "deprecated" ]; then continue 2>/dev/null; fi
  if [ "$_story_current_status" = "blocked" ];    then continue 2>/dev/null; fi
  if [ "$_story_current_status" = "completed" ]; then
    info "[CHECKPOINT] Skipping $story — already completed in prd.json"
    return 0
  fi
  echo "$story" >> "${ran}"
}

run_story TST-001
run_story TST-002
`);
      chmodSync(script, 0o755);

      execFileSync('bash', [script], { encoding: 'utf8' });

      const ranContent = (() => {
        try { return readFileSync(ran, 'utf8'); } catch { return ''; }
      })();

      expect(ranContent).not.toContain('TST-001');
      expect(ranContent).toContain('TST-002');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkpoint/resume — phase-level early exit', () => {
  it('emits pass step and skips loop when all stories are completed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-phase-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [
          { id: 'TST-001', status: 'completed', agentRole: 'backend' },
          { id: 'TST-002', status: 'completed', agentRole: 'backend' },
        ]
      }));

      const ran = join(dir, 'loop-ran.txt');
      const script = join(dir, 'test-phase-ckpt.sh');
      writeFileSync(script, `#!/bin/bash
PRD_FILE="${prdFile}"
PHASE="impl"
step_emit() { echo "STEP_EMIT: $*"; }
info()      { echo "INFO: $*"; }

_ckpt_total=$(jq '[.stories[] | select(.status != "deprecated")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
_ckpt_done=$(jq '[.stories[] | select(.status == "completed")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
if [ "\${_ckpt_total:-0}" -gt 0 ] && [ "\${_ckpt_done:-0}" -ge "\${_ckpt_total:-0}" ]; then
    info "[CHECKPOINT] All $_ckpt_total stories already completed — skipping Step 1 for phase '\${PHASE:-main}'"
    step_emit "1" "pass" "Step 1: Main-branch stories (all checkpointed)"
else
    echo "loop-ran" >> "${ran}"
fi
`);
      chmodSync(script, 0o755);

      const out = execFileSync('bash', [script], { encoding: 'utf8' });

      expect(out).toMatch(/CHECKPOINT.*All 2 stories already completed/);
      expect(out).toMatch(/STEP_EMIT.*all checkpointed/);

      const loopRan = (() => {
        try { return readFileSync(ran, 'utf8'); } catch { return ''; }
      })();
      expect(loopRan).not.toContain('loop-ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT skip loop when some stories are still pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ckpt-phase-partial-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify({
        stories: [
          { id: 'TST-001', status: 'completed', agentRole: 'backend' },
          { id: 'TST-002', status: 'pending',   agentRole: 'backend' },
        ]
      }));

      const ran = join(dir, 'loop-ran.txt');
      const script = join(dir, 'test-phase-partial.sh');
      writeFileSync(script, `#!/bin/bash
PRD_FILE="${prdFile}"
PHASE="impl"
step_emit() { echo "STEP_EMIT: $*"; }
info()      { echo "INFO: $*"; }

_ckpt_total=$(jq '[.stories[] | select(.status != "deprecated")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
_ckpt_done=$(jq '[.stories[] | select(.status == "completed")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
if [ "\${_ckpt_total:-0}" -gt 0 ] && [ "\${_ckpt_done:-0}" -ge "\${_ckpt_total:-0}" ]; then
    info "[CHECKPOINT] All $_ckpt_total stories already completed — skipping Step 1 for phase '\${PHASE:-main}'"
    step_emit "1" "pass" "Step 1: Main-branch stories (all checkpointed)"
else
    echo "loop-ran" >> "${ran}"
fi
`);
      chmodSync(script, 0o755);

      execFileSync('bash', [script], { encoding: 'utf8' });

      const loopRan = (() => {
        try { return readFileSync(ran, 'utf8'); } catch { return ''; }
      })();
      expect(loopRan).toContain('loop-ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
