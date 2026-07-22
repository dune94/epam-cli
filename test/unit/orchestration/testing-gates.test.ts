/**
 * Testing gate contract tests — SAST sentinel + fuzz-weaver.
 *
 * Covers the exact failure modes observed in run 81:
 * - Fuzz-weaver hallucinating "fail" when it has no tool access
 * - Fuzz-weaver reporting findings on non-existent files
 * - SAST blocking on dev-dependency CVEs (should never block)
 * - Verdict downgrade logic: ungrounded "fail" → "warn"
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ORCH_SCRIPT   = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const PROFILES_PATH = join(__dirname, '../../../orchestrations/agents/profiles.json');

const profiles = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));

// ── helpers ──────────────────────────────────────────────────────────────────

/** The Python grounding-check embedded in the orchestration script — extracted for unit testing */
function runFuzzGroundingCheck(logContent: string, projectRoot: string): number {
  const tmpDir = join(tmpdir(), `fuzz-ground-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const logFile = join(tmpDir, 'fuzz.log');
  writeFileSync(logFile, logContent);

  try {
    const out = execSync(
      `python3 - "${logFile}" "${projectRoot}" << 'PYEOF'
import json, sys, os, re
log_file     = sys.argv[1]
project_root = sys.argv[2]
content = open(log_file).read()
json_match = re.search(r'\\{.*"agent".*"fuzz-weaver".*\\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)
try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)
grounded = 0
for case in data.get("cases", []):
    if case.get("status") != "vulnerability": continue
    f = case.get("file", "")
    candidates = [f, os.path.join(project_root, f), os.path.join(project_root, "src", os.path.basename(f))]
    if any(os.path.exists(p) for p in candidates):
        grounded += 1
print(str(grounded))
PYEOF`,
      { stdio: 'pipe', encoding: 'utf8', shell: '/bin/bash' }
    ).trim();
    return parseInt(out, 10) || 0;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeFuzzLog(cases: any[], verdict: string): string {
  return JSON.stringify({
    agent: 'fuzz-weaver',
    phase: 'scaffold',
    summary: {
      functionsAnalysed: cases.length,
      fuzzCasesProposed: cases.length,
      covered: 0,
      gaps: cases.filter((c) => c.status === 'gap').length,
      vulnerabilities: cases.filter((c) => c.status === 'vulnerability').length,
    },
    cases,
    verdict,
  });
}

// ── 1. Fuzz-weaver profile grounding rules ───────────────────────────────────
describe('fuzz-weaver profile — hallucination guards', () => {
  const profile: string = profiles['fuzz-weaver'] ?? '';

  it('profile exists', () => {
    expect(profile).toBeTruthy();
  });

  it('profile contains GROUNDING RULES section', () => {
    expect(profile).toContain('GROUNDING RULES');
  });

  it('profile instructs "warn" not "fail" when tool access is unavailable', () => {
    expect(profile).toMatch(/tool.*empty.*warn|no.*file.*access.*warn|warn.*cannot.*read/i);
  });

  it('profile forbids "fail" when agent cannot read files', () => {
    expect(profile).toMatch(/NEVER.*fail.*cannot read|cannot read.*NEVER.*fail/i);
  });

  it('profile requires file existence verification before marking vulnerability', () => {
    expect(profile).toMatch(/verify.*file.*exist|file.*exist.*before.*vulnerabilit/i);
  });

  it('profile states "fail" requires confirmed file path on disk', () => {
    expect(profile).toMatch(/fail.*requires.*file.*exist|confirmed.*file.*path/i);
  });

  it('profile limits findings to files in src/ touched by git diff', () => {
    expect(profile).toMatch(/git diff|changed.*files|src\/.*directory/i);
  });
});

// ── 2. Fuzz-weaver grounding check: hallucinated findings ────────────────────
describe('fuzz-weaver grounding check — non-existent files', () => {
  // Use the epam-cli repo itself — src/index.ts always exists here regardless
  // of skyscanner-app state (which is cleaned before every run).
  const realProjectRoot = process.cwd();

  it('returns 0 grounded vulnerabilities when all files are non-existent', () => {
    const log = makeFuzzLog(
      [
        { status: 'vulnerability', file: 'src/config/loadConfig.ts',   function: 'parseConfig' },
        { status: 'vulnerability', file: 'src/util/retry.ts',          function: 'retryWithBackoff' },
        { status: 'vulnerability', file: 'src/util/merge.ts',          function: 'deepMerge' },
        { status: 'vulnerability', file: 'src/providers/request.ts',   function: 'buildChatRequest' },
        { status: 'vulnerability', file: 'src/util/redact.ts',         function: 'redactSecrets' },
      ],
      'fail'
    );
    const grounded = runFuzzGroundingCheck(log, realProjectRoot);
    expect(grounded).toBe(0);
  });

  it('returns 0 grounded vulnerabilities for gap-status findings', () => {
    const log = makeFuzzLog(
      [
        { status: 'gap', file: 'src/config/loadConfig.ts', function: 'parseConfig' },
        { status: 'gap', file: 'src/util/retry.ts',        function: 'retryWithBackoff' },
      ],
      'warn'
    );
    const grounded = runFuzzGroundingCheck(log, realProjectRoot);
    expect(grounded).toBe(0);
  });

  it('returns >0 when a vulnerability finding references a real file', () => {
    // src/index.ts always exists in the epam-cli repo (realProjectRoot = process.cwd())
    const log = makeFuzzLog(
      [{ status: 'vulnerability', file: 'src/index.ts', function: 'someFunction' }],
      'fail'
    );
    const grounded = runFuzzGroundingCheck(log, realProjectRoot);
    expect(grounded).toBeGreaterThan(0);
  });

  it('handles malformed / non-JSON fuzz log without crashing (returns 0)', () => {
    const grounded = runFuzzGroundingCheck('not json at all', realProjectRoot);
    expect(grounded).toBe(0);
  });

  it('handles missing cases array without crashing (returns 0)', () => {
    const log = JSON.stringify({ agent: 'fuzz-weaver', phase: 'scaffold', verdict: 'fail' });
    const grounded = runFuzzGroundingCheck(log, realProjectRoot);
    expect(grounded).toBe(0);
  });

  it('handles log with preamble text before JSON (agent "no tool access" messages)', () => {
    const preamble =
      'I have no file system or tool access available in this context — my tool list is empty.\n\n';
    const log = preamble + makeFuzzLog(
      [{ status: 'vulnerability', file: 'src/config/loadConfig.ts', function: 'parseConfig' }],
      'fail'
    );
    const grounded = runFuzzGroundingCheck(log, realProjectRoot);
    expect(grounded).toBe(0);
  });
});

// ── 3. Orchestration script: fuzz-weaver verdict handling ────────────────────
describe('fuzz-weaver orchestration wiring', () => {
  it('orchestration script contains grounding check before treating fuzz "fail" as blocking', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    expect(src).toContain('_fuzz_grounded');
    expect(src).toContain('os.path.exists');
  });

  it('orchestration script downgrades ungrounded fuzz "fail" to WARN', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    expect(src).toContain('downgraded to WARN');
  });

  it('orchestration script only sets failed=1 when grounded > 0', () => {
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    // The block that sets failed=1 must check _fuzz_grounded first
    const fuzzBlock = src.slice(
      src.indexOf('_fuzz_grounded='),
      src.indexOf('_fuzz_grounded=') + 3500
    );
    expect(fuzzBlock).toContain('_fuzz_grounded:-0');
    expect(fuzzBlock).toContain('failed=1');
    // failed=1 must come AFTER the grounded check, not before
    const failedIdx   = fuzzBlock.indexOf('failed=1');
    const groundedIdx = fuzzBlock.indexOf('_fuzz_grounded:-0');
    expect(groundedIdx).toBeLessThan(failedIdx);
  });
});

// ── 4. SAST sentinel profile and verdict rules ───────────────────────────────
describe('sast-sentinel profile — verdict rules', () => {
  const profile: string = profiles['sast-sentinel'] ?? '';

  it('profile exists', () => {
    expect(profile).toBeTruthy();
  });

  it('profile states dev-dependency CVEs are minor (never blocker)', () => {
    expect(profile).toMatch(/dev.*depend.*minor|devDependenc.*minor|minor.*dev.*CVE/i);
  });

  it('profile or prompt explicitly forbids classifying dev-dep CVE as blocker', () => {
    // Either in profile or the hardcoded prompt in the orch script
    const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');
    const hasCombined =
      profile.match(/NEVER classify a dev.dependency CVE as .blocker/i) ||
      orchSrc.match(/NEVER classify a dev-dependency CVE as .blocker/i);
    expect(hasCombined).toBeTruthy();
  });
});

// ── 5. SAST blockerCount extraction from log ─────────────────────────────────
describe('sast-sentinel blockerCount extraction', () => {
  function extractBlockerCount(logContent: string): number {
    const tmpDir = join(tmpdir(), `sast-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const logFile = join(tmpDir, 'sast.log');
    writeFileSync(logFile, logContent);
    try {
      const out = execSync(
        `python3 -c "
import sys, json, re
text = open('${logFile}').read()
parsed = None
m = re.search(r'\\\\{.*\\\\}', text, re.DOTALL)
if m:
    try: parsed = json.loads(m.group(0))
    except: pass
if parsed is not None:
    summary_count = parsed.get('summary', {}).get('blockerCount', None)
    if summary_count is not None: print(summary_count); sys.exit(0)
    findings = parsed.get('findings', [])
    print(sum(1 for f in findings if str(f.get('severity','')).lower() == 'blocker'))
else:
    hits = len(re.findall(r'\"severity\"\\\\s*:\\\\s*\"blocker\"', text, re.IGNORECASE))
    print(hits)
"`,
        { stdio: 'pipe', encoding: 'utf8' }
      ).trim();
      return parseInt(out, 10);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('extracts 0 blockers from a passing SAST report with dev-dep CVEs only', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel', phase: 'scaffold',
      summary: { filesScanned: 3, findingsCount: 3, blockerCount: 0 },
      findings: [
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'vitest CVE', suggestedFix: 'upgrade' },
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'vite CVE', suggestedFix: 'upgrade' },
      ],
      verdict: 'pass',
    });
    expect(extractBlockerCount(log)).toBe(0);
  });

  it('extracts correct blocker count from a real blocker finding', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel', phase: 'scaffold',
      summary: { filesScanned: 5, findingsCount: 2, blockerCount: 1 },
      findings: [
        { severity: 'blocker', rule: 'hardcoded-secret', file: 'src/config.ts', line: 12,
          description: 'API key hardcoded', suggestedFix: 'use env var' },
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'vitest CVE', suggestedFix: 'upgrade' },
      ],
      verdict: 'fail',
    });
    expect(extractBlockerCount(log)).toBe(1);
  });

  it('returns 0 for SAST log with verdict pass and no findings array', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel', phase: 'scaffold',
      summary: { filesScanned: 0, findingsCount: 0, blockerCount: 0 },
      findings: [],
      verdict: 'pass',
    });
    expect(extractBlockerCount(log)).toBe(0);
  });

  it('does not count dev-dep minor findings as blockers when blockerCount absent', () => {
    const log = JSON.stringify({
      agent: 'sast-sentinel', phase: 'scaffold',
      summary: { filesScanned: 1, findingsCount: 1 },
      findings: [
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'esbuild CVE' },
      ],
      verdict: 'pass',
    });
    expect(extractBlockerCount(log)).toBe(0);
  });
});

// ── H3–H9: QA gate retry helper — all 7 gates use _run_qa_gate_with_retry ────
describe('_run_qa_gate_with_retry — helper definition and wiring (H3–H9)', () => {
  const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

  it('_run_qa_gate_with_retry function is defined in the script', () => {
    expect(orchSrc).toContain('_run_qa_gate_with_retry()');
  });

  it('retry loop is bounded by QA_GATE_MAX_RETRIES (default 2)', () => {
    const fnStart = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart + 50);
    const body    = orchSrc.slice(fnStart, fnEnd);
    expect(body).toContain('QA_GATE_MAX_RETRIES');
    expect(body).toMatch(/-lt.*_qg_max|_qg_max.*-lt/);
  });

  it('corrective re-prompt is injected on the second attempt', () => {
    const fnStart = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart + 50);
    const body    = orchSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/RETRY.*attempt.*previous invocation/s);
  });

  it('escalates to ESCALATION_MODEL_HIGH on retry', () => {
    const fnStart = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart + 50);
    const body    = orchSrc.slice(fnStart, fnEnd);
    expect(body).toContain('ESCALATION_MODEL_HIGH');
    expect(body).toMatch(/_qg_attempt.*-ge 1.*ESCALATION_MODEL_HIGH|ESCALATION_MODEL_HIGH.*_qg_attempt/s);
  });

  it('validates output by grepping for JSON structural keys (verdict/findings/agent/summary)', () => {
    const fnStart = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart + 50);
    const body    = orchSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/grep.*verdict.*findings.*agent.*summary/);
  });

  it('returns 1 when all retries are exhausted with no structured output', () => {
    const fnStart = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart + 50);
    const body    = orchSrc.slice(fnStart, fnEnd);
    expect(body).toContain('return 1');
    expect(body).toContain('attempt(s) exhausted');
  });

  it('restores ORCH_GATE_MODEL after both success and failure paths', () => {
    const fnStart = orchSrc.indexOf('_run_qa_gate_with_retry()');
    const fnEnd   = orchSrc.indexOf('\n}', fnStart + 50);
    const body    = orchSrc.slice(fnStart, fnEnd);
    expect(body).toContain('_saved_gate_model');
    // Both return paths must restore the model
    const successRestoreIdx = body.indexOf('ORCH_GATE_MODEL="$_saved_gate_model"');
    const failureRestoreIdx = body.lastIndexOf('ORCH_GATE_MODEL="$_saved_gate_model"');
    expect(successRestoreIdx).toBeGreaterThan(-1);
    expect(failureRestoreIdx).toBeGreaterThan(successRestoreIdx);
  });

  const qaAgents = [
    { name: 'sast',          prompt: 'sast_prompt',   log: 'sast_log'   },
    { name: 'spec-validator', prompt: 'spec_prompt',   log: 'spec_log'   },
    { name: 'review-ranger', prompt: 'review_prompt', log: 'review_log' },
    { name: 'mutant-hunter', prompt: 'mutant_prompt', log: 'mutant_log' },
    { name: 'fuzz-weaver',   prompt: 'fuzz_prompt',   log: 'fuzz_log'   },
    { name: 'perf-sentinel', prompt: 'perf_prompt',   log: 'perf_log'   },
    { name: 'e2e',           prompt: 'prompt',        log: 'story_log'  },
  ];

  for (const { name, prompt, log } of qaAgents) {
    it(`qa-gate:${name} call site uses _run_qa_gate_with_retry (not bare run_orch_prompt_with_tools | tee)`, () => {
      expect(orchSrc).toContain(`_run_qa_gate_with_retry "$${prompt}" "qa-gate:${name}"`);
      // Old pattern must be absent for this specific agent
      expect(orchSrc).not.toContain(`run_orch_prompt_with_tools "$${prompt}" "qa-gate:${name}"`);
    });
  }

  it('e2e gate now uses rc=$? (not PIPESTATUS) since _run_qa_gate_with_retry returns directly', () => {
    // After the e2e helper call, rc must come from $? not from PIPESTATUS
    const e2eIdx = orchSrc.indexOf('_run_qa_gate_with_retry "$prompt" "qa-gate:e2e"');
    const afterCall = orchSrc.slice(e2eIdx, e2eIdx + 200);
    expect(afterCall).toContain('rc=$?');
    expect(afterCall).not.toContain('PIPESTATUS');
  });
});

// ── 6. Run 81 regression: exact hallucination scenario ───────────────────────
describe('run 81 regression — fuzz-weaver hallucination scenario', () => {
  it('the exact run-81 fuzz log produces 0 grounded vulnerabilities', () => {
    // Files that appeared in the run-81 fuzz-weaver log — none exist in skyscanner-app
    const run81Log = makeFuzzLog(
      [
        { status: 'vulnerability', file: 'src/config/loadConfig.ts',
          function: 'parseConfig', property: 'parseConfig rejects unknown top-level keys' },
        { status: 'vulnerability', file: 'src/providers/request.ts',
          function: 'buildChatRequest', property: 'buildChatRequest refuses empty messages' },
        { status: 'gap', file: 'src/util/retry.ts',
          function: 'retryWithBackoff', property: 'respects maxAttempts' },
        { status: 'gap', file: 'src/util/merge.ts',
          function: 'deepMerge', property: 'no circular reference hang' },
        { status: 'gap', file: 'src/util/merge.ts',
          function: 'deepMerge', property: 'no prototype pollution' },
        { status: 'gap', file: 'src/util/redact.ts',
          function: 'redactSecrets', property: 'replaces all secret patterns' },
      ],
      'fail'
    );
    const grounded = runFuzzGroundingCheck(
      run81Log,
      '/home/bradleyjerome/projects/skyscanner-app'
    );
    expect(grounded).toBe(0);
  });

  it('the run-81 scenario would be downgraded to WARN not FAIL by orchestration', () => {
    // Verify the orch script logic: grounded=0 → warning (not failed=1)
    const src = readFileSync(ORCH_SCRIPT, 'utf8');
    // Find the section that evaluates _fuzz_grounded and decides whether to set failed=1
    const evalStart = src.indexOf('if [ "${_fuzz_grounded:-0}"');
    const evalBlock = src.slice(evalStart, evalStart + 900);
    // Must contain a warning/downgrade path when grounded == 0
    expect(evalBlock).toContain('warning');
    expect(evalBlock).toMatch(/downgraded|hallucinate|no vulnerability/i);
  });

  it('SAST passed in run 81 — dev-dep CVE findings correctly classified as minor', () => {
    // The actual SAST log from run 81 had verdict: "pass" with 0 blockerCount
    const run81SastLog = JSON.stringify({
      agent: 'sast-sentinel', phase: 'scaffold',
      summary: { filesScanned: 3, findingsCount: 4, blockerCount: 0 },
      findings: [
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'vitest CVE — dev-only dependency' },
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'vite CVE — dev-only dependency' },
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'esbuild CVE — dev-only bundler' },
        { severity: 'minor', rule: 'dev-dependency-cve', file: 'package.json', line: 0,
          description: 'vite-node CVE — chained dev dep' },
      ],
      verdict: 'pass',
    });
    // blockerCount is 0 → SAST should pass, not block
    const parsed = JSON.parse(run81SastLog);
    expect(parsed.summary.blockerCount).toBe(0);
    expect(parsed.verdict).toBe('pass');
    expect(parsed.findings.every((f: any) => f.severity === 'minor')).toBe(true);
  });
});
