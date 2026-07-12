/**
 * Root cause of a live misdiagnosis (found 2026-07-07): SKY-002-test-1's own
 * test file had a casing typo (`import { SkyScannerClient }` when the real
 * export is `SkyscannerClient`) — but the failure-analyst, with NO visibility
 * into the dependency's real exports, diagnosed it as "exports as default but
 * test imports it as named," which is simply false. The class IS correctly a
 * named export, just mis-cased. Every subsequent retry — including the
 * strongest configured model — "fixed" the wrong thing because the diagnosis
 * guiding it was wrong; a stronger model can't out-reason a false premise
 * handed to it as ground truth.
 *
 * Fix: run_failure_analyst() now injects the same ground-truth dependency
 * contracts (.contracts/<dep-id>.md) already proven for
 * build_implementation_prompt() — so the analyst has the dependency's real
 * exported class/function names in front of it, not just the test failure
 * text and its own assumptions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const fnStart = claudeSrc.indexOf(`${name}() {`);
  const fnEnd = claudeSrc.indexOf('\n}', fnStart + 50);
  return claudeSrc.slice(fnStart, fnEnd + 2);
}

describe('run_failure_analyst — dependency contract injection (static)', () => {
  const body = extractFunctionBody('run_failure_analyst');

  it('reads .dependencies / technicalNotes.dependsOn, same field-lookup as build_implementation_prompt()', () => {
    expect(body).toMatch(/\.dependencies \/\/ \.technicalNotes\.dependsOn/);
  });

  it('looks for a contract file at $PROJECT_ROOT/.contracts/<dep-id>.md', () => {
    expect(body).toMatch(/\$PROJECT_ROOT\/\.contracts\/\$\{_fa_dep_id\}\.md/);
  });

  it('injects a DEPENDENCY CONTRACTS section into the analyst prompt template', () => {
    expect(body).toMatch(/DEPENDENCY CONTRACTS \(ground truth/);
    expect(body).toMatch(/__DEPENDENCY_CONTRACTS__/);
  });

  it('the prompt instructs the analyst to trust the contract over its own assumptions', () => {
    const idx = body.indexOf('DEPENDENCY CONTRACTS (ground truth');
    const section = body.slice(idx, idx + 300);
    expect(section).toMatch(/trust this over any assumption/i);
  });
});

describe('run_failure_analyst — REAL execution: contract injection prevents the exact live misdiagnosis shape', () => {
  function runWithStub(opts: {
    withContract: boolean;
    analystResponse: string;
    storyDependencies?: string[];
  }): { output: string; promptSeenByAnalyst: string } {
    const dir = mkdtempSync(join(tmpdir(), 'analyst-contract-test-'));
    try {
      if (opts.withContract) {
        const contractsDir = join(dir, '.contracts');
        mkdirSync(contractsDir, { recursive: true });
        writeFileSync(
          join(contractsDir, 'SKY-002-impl.md'),
          [
            '# Contract: SKY-002-impl',
            '',
            'Auto-generated from actual source (deterministic — not model-transcribed).',
            '',
            '```typescript',
            'export class SkyscannerClient {',
            '  constructor({ apiKey }: { apiKey?: string });',
            '  async searchFlights(params: SearchParams): Promise<FlightResult[]>;',
            '}',
            '```',
          ].join('\n'),
        );
      }

      const promptCaptureFile = join(dir, 'prompt-seen.txt');
      const aiRunPath = join(dir, 'ai-run.sh');
      writeFileSync(
        aiRunPath,
        `#!/usr/bin/env bash\ncat > "${promptCaptureFile}"\necho '${opts.analystResponse.replace(/'/g, "'\\''")}'\n`,
      );
      chmodSync(aiRunPath, 0o755);

      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [
            {
              id: 'SKY-002-test-1',
              agentRole: 'test-engineer',
              acceptanceCriteria: ['client.test.ts covers the constructor and searchFlights'],
              dependencies: opts.storyDependencies ?? ['SKY-002-impl'],
            },
          ],
        }),
      );

      const fnBody = extractFunctionBody('run_failure_analyst');
      const script = `
exec 2>&1
SCRIPT_DIR="${dir}"
PROJECT_ROOT="${dir}"
ORCH_GATE_PROVIDER="fake"
ORCH_GATE_MODEL="fake-model"
MAIN_PRD_FILE=""
PRD_FILE="${prdPath}"
VERIFICATION_FAILURE="SkyScannerClient is not a constructor"
warning() { echo "WARN: $*" >&2; }
log() { echo "LOG: $*" >&2; }
run_prd_change_reviewer() { echo "pass"; }
run_healing_recorder() { :; }
check_healing_effectiveness() { :; }
${fnBody}
run_failure_analyst "SKY-002-test-1" "/dev/null" "0"
echo "DIAGNOSIS_AMENDMENT=[$COORDINATOR_PROMPT_AMENDMENT]"
`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15_000 });
      let promptSeenByAnalyst = '';
      try {
        promptSeenByAnalyst = readFileSync(promptCaptureFile, 'utf8');
      } catch {
        promptSeenByAnalyst = '';
      }
      return { output, promptSeenByAnalyst };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the analyst prompt includes the real contract (correct casing) when the dependency has one', () => {
    const { promptSeenByAnalyst } = runWithStub({
      withContract: true,
      analystResponse: '{"diagnosis":"placeholder","target":"none","reason":"placeholder"}',
    });
    expect(promptSeenByAnalyst).toContain('export class SkyscannerClient');
    expect(promptSeenByAnalyst).toContain('DEPENDENCY CONTRACTS');
  });

  it('falls back to "(no dependency contracts available)" when no contract file exists yet — never fabricates one', () => {
    const { promptSeenByAnalyst } = runWithStub({
      withContract: false,
      analystResponse: '{"diagnosis":"placeholder","target":"none","reason":"placeholder"}',
    });
    expect(promptSeenByAnalyst).toContain('(no dependency contracts available)');
    expect(promptSeenByAnalyst).not.toContain('SkyscannerClient');
  });

  it('with the real contract present, a correctly-diagnosing analyst response flows through to COORDINATOR_PROMPT_AMENDMENT (proves the plumbing works end-to-end)', () => {
    const { output } = runWithStub({
      withContract: true,
      analystResponse:
        '{"diagnosis":"Test imports SkyScannerClient (wrong casing) — the real export is SkyscannerClient","target":"none","reason":"Fix the identifier casing to match the contract exactly"}',
    });
    expect(output).toContain('SkyscannerClient');
    expect(output).toContain('Fix the identifier casing to match the contract exactly');
  });

  it('no dependencies declared at all: still runs cleanly, contract section shows the no-contracts fallback', () => {
    const { promptSeenByAnalyst } = runWithStub({
      withContract: true,
      analystResponse: '{"diagnosis":"placeholder","target":"none","reason":"placeholder"}',
      storyDependencies: [],
    });
    expect(promptSeenByAnalyst).toContain('(no dependency contracts available)');
  });
});
