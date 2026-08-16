/**
 * Root cause of a live defect (run #14, 2026-07-04): SKY-004 attempt 1's
 * failure-analyst correctly chose target=tool for a mechanical import-path
 * layout check, but the generated script was rejected for a genuine bash bug
 * ("if statement is syntactically malformed... broken counter set inside
 * piped while loop runs in subshell, value never propagates"). Unlike
 * kb_entry/skill_note (which get 3 summarize-and-resubmit rounds via
 * run_change_with_reviewer_retry), tool_creation had NO retry — the rejection
 * discarded the fix outright, and the exact same wrong-import-path bug
 * recurred on attempt 2 with no structural mitigation in place.
 *
 * Fix: wire the tool) case to run_change_with_reviewer_retry, same as
 * kb_entry/skill_note. The generic summarizer prompt (used for short KB/skill
 * prose — under 200 chars, imperative verb, single line) is wrong for a bash
 * script, so run_prd_change_summarizer() branches its prompt AND its
 * post-processing (no `tr -d '\n'`, which would destroy a multi-line script)
 * by change_type.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// The template-layer renderer. Extracted claude.sh functions render their prompts through
// it, so a harness must source it just as it stubs log() and error().
const RENDER_LIB = join(__dirname, '../../../orchestrations/scripts/lib/render-engine-prompt.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  let inHeredoc = false;
  let heredocDelim = '';
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);
    if (!inHeredoc) {
      const m = line.match(/<<-?\s*'?(\w+)'?/);
      if (m) {
        inHeredoc = true;
        heredocDelim = m[1];
        continue;
      }
      if (line === '}') return body.join('\n');
    } else if (line.trim() === heredocDelim) {
      inHeredoc = false;
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('claude.sh — reviewer-retry wired into tool_creation self-heal', () => {
  it('tool) case calls run_change_with_reviewer_retry (not run_prd_change_reviewer directly) with max_retries=3', () => {
    const toolCaseIdx = claudeSrc.indexOf('_tool_review_verdict=$(run_change_with_reviewer_retry');
    expect(toolCaseIdx).toBeGreaterThan(-1);
    const callBlock = claudeSrc.slice(toolCaseIdx, toolCaseIdx + 200);
    expect(callBlock).toMatch(/"tool_creation"/);
    expect(callBlock).toMatch(/3\)/);
  });

  it('tool) case writes REVIEWER_RETRY_TEXT (the possibly-reformatted script) to the tool path, not the original candidate', () => {
    const toolCaseIdx = claudeSrc.indexOf('_tool_review_verdict=$(run_change_with_reviewer_retry');
    const writeIdx = claudeSrc.indexOf('> "$tool_path"', toolCaseIdx);
    expect(writeIdx).toBeGreaterThan(toolCaseIdx);
    const writeLine = claudeSrc.slice(claudeSrc.lastIndexOf('\n', writeIdx), claudeSrc.indexOf('\n', writeIdx));
    expect(writeLine).toMatch(/REVIEWER_RETRY_TEXT/);
  });

  it('run_prd_change_summarizer branches on change_type — tool_creation gets bash-appropriate rewrite instructions', () => {
    const body = extractFunctionBody('run_prd_change_summarizer');
    expect(body).toMatch(/if \[ "\$change_type" = "tool_creation" \]/);
    expect(body).toMatch(/bash script reviewer-summarizer/);
    expect(body).toMatch(/idempotent/);
  });

  it('tool_creation post-processing does NOT strip newlines (a bash script needs them; kb_entry\\/skill_note collapse to one line)', () => {
    const body = extractFunctionBody('run_prd_change_summarizer');
    const toolBranchIdx = body.indexOf('if [ "$change_type" = "tool_creation" ]');
    const toolBranchEnd = body.indexOf('else', toolBranchIdx);
    const toolBranch = body.slice(toolBranchIdx, toolBranchEnd);
    expect(toolBranch).not.toMatch(/tr -d '\\n'/);
  });
});

describe('tool_creation retry — REAL execution against the exact live subshell-scoping bug', () => {
  it('rewrites a piped-while-loop counter bug (the exact class rejected live for SKY-004) into a working process-substitution form, then gets approved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-retry-test-'));
    try {
      const aiRunPath = join(dir, 'ai-run.sh');
      writeFileSync(
        aiRunPath,
        `#!/usr/bin/env bash
prompt=$(cat)
if echo "$prompt" | grep -q "bash script reviewer-summarizer"; then
  cat << 'FIXED'
#!/usr/bin/env bash
set -e
count=0
while read -r f; do
  count=$((count + 1))
done < <(find src -name "*.ts" -not -name "*.test.ts")
echo "checked $count files"
FIXED
else
  after_section=$(echo "$prompt" | sed -n '/^AFTER:/,$p')
  if echo "$after_section" | grep -q "BROKEN_COUNTER_BUG"; then
    echo '{"verdict":"fail","issues":["broken counter in piped while loop runs in subshell, value never propagates"],"reason":"bash bug"}'
  else
    echo '{"verdict":"pass","issues":[],"reason":"ok"}'
  fi
fi
`,
      );
      chmodSync(aiRunPath, 0o755);

      const brokenToolPath = join(dir, 'broken-tool.sh');
      writeFileSync(
        brokenToolPath,
        `#!/usr/bin/env bash
set -e
BROKEN_COUNTER_BUG=1
count=0
find src -name "*.ts" | while read -r f; do
  count=$((count + 1))
done
echo "checked $count files"
`,
      );

      writeFileSync(join(dir, 'fn_reviewer.sh'), extractFunctionBodyBraceCounted('run_prd_change_reviewer'));
      writeFileSync(join(dir, 'fn_summarizer.sh'), extractFunctionBody('run_prd_change_summarizer'));
      writeFileSync(join(dir, 'fn_retry.sh'), extractFunctionBodyBraceCounted('run_change_with_reviewer_retry'));

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `SCRIPT_DIR="${dir}"
TMPDIR="${dir}"
ORCH_GATE_PROVIDER="fake"
ORCH_GATE_MODEL="fake-model"
profiles_file=""
warning() { :; }
log() { :; }
source "${dir}/fn_reviewer.sh"
source "${dir}/fn_summarizer.sh"
source "${dir}/fn_retry.sh"
broken_tool=$(cat "${dir}/broken-tool.sh")
verdict=$(run_change_with_reviewer_retry "SKY-004" "tool_creation" "" "$broken_tool" 3)
final=$(cat "${dir}/.reviewer-retry-text-$$" 2>/dev/null || echo "")
echo "VERDICT=$verdict"
echo "---FINAL---"
echo "$final"
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      expect(output).toContain('VERDICT=pass');
      expect(output).not.toContain('BROKEN_COUNTER_BUG');
      expect(output).toContain('done < <(find src');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function extractFunctionBodyBraceCounted(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  const braceStart = claudeSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < claudeSrc.length; i++) {
    if (claudeSrc[i] === '{') depth++;
    else if (claudeSrc[i] === '}') {
      depth--;
      if (depth === 0) return claudeSrc.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}
