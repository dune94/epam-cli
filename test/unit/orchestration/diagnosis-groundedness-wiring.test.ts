/**
 * Wires the standalone diagnosis-groundedness-check.py tool (see
 * diagnosis-groundedness-check.test.ts for the tool itself) into
 * run_failure_analyst() as run_diagnosis_groundedness_check() -- an
 * advisory-only second opinion on the FailureAnalyst's own diagnosis.
 *
 * Scope (per design discussion, 2026-07-12): advisory/logged only. This
 * check must NEVER alter `target` handling (PRD/TC patches, skill notes, KB
 * writes, tool creation) regardless of what the groundedness score says --
 * it exists purely to accumulate real data (in
 * orchestrations/logs/failure-diagnosis-groundedness.jsonl) on how often
 * self-heal acts on an ungrounded diagnosis, so a future decision to make
 * this blocking is backed by measurement, not guesswork.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

describe('run_diagnosis_groundedness_check() — exists and is wired into run_failure_analyst (static)', () => {
  it('is defined as a shell function', () => {
    expect(claudeSrc).toMatch(/run_diagnosis_groundedness_check\s*\(\)/);
  });

  it('is called between the diagnosis log line and the target case statement (advisory position, cannot gate target handling)', () => {
    const diagIdx = claudeSrc.indexOf('log "  [FailureAnalyst] Diagnosis: $diagnosis"');
    const callIdx = claudeSrc.indexOf('run_diagnosis_groundedness_check "$story_id" "$diagnosis"');
    const caseIdx = claudeSrc.indexOf('case "$target" in', callIdx);
    expect(diagIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(diagIdx);
    expect(caseIdx).toBeGreaterThan(callIdx);
  });

  it('the call site does not capture or branch on the function\'s return value (proves it cannot alter control flow)', () => {
    const callIdx = claudeSrc.indexOf('run_diagnosis_groundedness_check "$story_id" "$diagnosis"');
    const line = claudeSrc.slice(claudeSrc.lastIndexOf('\n', callIdx), callIdx + 80);
    expect(line).not.toMatch(/if\s*\[|&&|\|\|/);
  });

  it('respects SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK', () => {
    const fnBody = extractFunctionBody('run_diagnosis_groundedness_check');
    expect(fnBody).toMatch(/SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK/);
  });

  it('gracefully no-ops (does not error) when the venv/script is missing', () => {
    const fnBody = extractFunctionBody('run_diagnosis_groundedness_check');
    expect(fnBody).toMatch(/-x "\$_dgc_venv_python"/);
    expect(fnBody).toMatch(/-f "\$_dgc_script"/);
  });

  it('writes to orchestrations/logs/failure-diagnosis-groundedness.jsonl', () => {
    const fnBody = extractFunctionBody('run_diagnosis_groundedness_check');
    expect(fnBody).toMatch(/failure-diagnosis-groundedness\.jsonl/);
  });

  it('writes compact (one-line) JSON, not pretty-printed -- required for a valid JSONL file (found live, 2026-07-12: broke line-based tailing/counting)', () => {
    const fnBody = extractFunctionBody('run_diagnosis_groundedness_check');
    const writeCallIdx = fnBody.indexOf('>> "${LOG_DIR}/failure-diagnosis-groundedness.jsonl"');
    const jqCallIdx = fnBody.lastIndexOf('jq -n', writeCallIdx);
    expect(jqCallIdx).toBeGreaterThan(-1);
    const jqInvocation = fnBody.slice(jqCallIdx, jqCallIdx + 20);
    expect(jqInvocation).toMatch(/^jq -nc\b/);
  });

  it('bounds the call with a timeout (must never hang the retry loop)', () => {
    const fnBody = extractFunctionBody('run_diagnosis_groundedness_check');
    expect(fnBody).toMatch(/timeout \d+/);
  });
});

describe('run_diagnosis_groundedness_check() — REAL execution', () => {
  function run(opts: {
    diagnosis: string;
    fakePythonOutput?: string;
    withVenv: boolean;
    skipFlag?: string;
  }): { logOutput: string; jsonlContent: string | null } {
    const dir = mkdtempSync(join(tmpdir(), 'dgc-wiring-'));
    try {
      const scriptDir = join(dir, 'scripts');
      const logDir = join(dir, 'logs');
      mkdirSync(join(scriptDir, 'tools', '.venv-deepeval', 'bin'), { recursive: true });
      mkdirSync(logDir, { recursive: true });

      if (opts.withVenv) {
        // Fake venv python + fake tool script -- avoids any real network
        // call/cost in this test; the real tool itself is exercised in
        // diagnosis-groundedness-check.test.ts.
        writeFileSync(
          join(scriptDir, 'tools', '.venv-deepeval', 'bin', 'python'),
          `#!/usr/bin/env bash\ncat >/dev/null\necho '${opts.fakePythonOutput ?? '{"skipped":true,"reason":"test stub"}'}'\n`,
          { mode: 0o755 },
        );
        writeFileSync(join(scriptDir, 'tools', 'diagnosis-groundedness-check.py'), '# stub, not executed directly\n');
      }

      const fnBody = extractFunctionBody('run_diagnosis_groundedness_check');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `SCRIPT_DIR=${JSON.stringify(scriptDir)}`,
          `LOG_DIR=${JSON.stringify(logDir)}`,
          `VERIFICATION_FAILURE=${JSON.stringify('FAIL src/index.test.ts\\n  AssertionError: expected 4 to be 3')}`,
          opts.skipFlag ? `SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK=${opts.skipFlag}` : '',
          'log() { echo "LOG: $*" >&2; }',
          'warning() { echo "WARN: $*" >&2; }',
          fnBody,
          `run_diagnosis_groundedness_check ${JSON.stringify('SKY-TEST')} ${JSON.stringify(opts.diagnosis)}`,
          'echo "RC=$?"',
          '',
        ].join('\n'),
      );
      // log()/warning() write to stderr, not stdout -- merge streams via a
      // single execution (the function is safe to run once here; it only
      // appends to the JSONL log, which this test reads directly afterward).
      const stderrPath = join(dir, 'stderr.log');
      const wrapperPath = join(dir, 'run-wrapper.sh');
      writeFileSync(wrapperPath, `bash ${JSON.stringify(scriptPath)} 2> ${JSON.stringify(stderrPath)}`);
      let output = '';
      try {
        output = execFileSync('bash', [wrapperPath], { encoding: 'utf8' });
      } catch (e: any) {
        output = (e.stdout ?? '').toString();
      }
      output += readFileSync(stderrPath, 'utf8');
      let jsonlContent: string | null = null;
      try {
        jsonlContent = readFileSync(join(logDir, 'failure-diagnosis-groundedness.jsonl'), 'utf8');
      } catch {
        /* not written */
      }
      return { logOutput: output, jsonlContent };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('no-ops silently when the venv does not exist (no crash, no log spam)', () => {
    const { logOutput, jsonlContent } = run({ diagnosis: 'some diagnosis', withVenv: false });
    expect(logOutput).toMatch(/RC=0/);
    expect(jsonlContent).toBeNull();
  });

  it('no-ops when SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK=1, even with a working venv', () => {
    const { jsonlContent } = run({
      diagnosis: 'some diagnosis',
      withVenv: true,
      skipFlag: '1',
      fakePythonOutput: '{"skipped":false,"score":1.0,"verdict":"grounded","reason":"ok"}',
    });
    expect(jsonlContent).toBeNull();
  });

  it('logs and writes JSONL for a grounded verdict', () => {
    const { logOutput, jsonlContent } = run({
      diagnosis: 'The add function has an off-by-one bug.',
      withVenv: true,
      fakePythonOutput: '{"skipped":false,"score":0.95,"verdict":"grounded","reason":"well supported"}',
    });
    expect(logOutput).toMatch(/grounded/);
    expect(jsonlContent).not.toBeNull();
    const parsed = JSON.parse(jsonlContent!.trim());
    expect(parsed.storyId).toBe('SKY-TEST');
    expect(parsed.verdict).toBe('grounded');
    expect(parsed.score).toBe(0.95);
  });

  it('warns (but still just logs -- does not fail) for an ungrounded verdict', () => {
    const { logOutput, jsonlContent } = run({
      diagnosis: 'The database connection pool is exhausted.',
      withVenv: true,
      fakePythonOutput: '{"skipped":false,"score":0.05,"verdict":"ungrounded","reason":"no support in log"}',
    });
    expect(logOutput).toMatch(/WARN:.*ungrounded|ungrounded.*advisory/i);
    const parsed = JSON.parse(jsonlContent!.trim());
    expect(parsed.verdict).toBe('ungrounded');
  });

  it('writes nothing to the JSONL log when the tool itself reports skipped:true (e.g. no API key)', () => {
    const { jsonlContent } = run({
      diagnosis: 'x',
      withVenv: true,
      fakePythonOutput: '{"skipped":true,"reason":"no OPENROUTER_API_KEY available for the judge model"}',
    });
    expect(jsonlContent).toBeNull();
  });
});
