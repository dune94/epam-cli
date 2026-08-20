// THE PIPELINE ASSUMED vitest ON A jest CODELINE.
//
// run-agent-orchestration.sh contains 40 executable `vitest` references and ZERO `jest` ones.
// metrolinx runs jest (`codeline-ecosystem.js` reports testCommand "npm test", declaredBins
// include jest, not vitest). Four sites behave wrongly there:
//
//   1491  if [ -x "$PROJECT_ROOT/node_modules/.bin/vitest" ]  -> guard false, post-repair
//         re-verification SKIPPED and _lf_ok stays 1. A repair is accepted without its proof.
//   8100  timeout ... "$_node_bin" ./node_modules/.bin/vitest run   -> NO guard at all. The
//         binary does not exist, the command fails, and Step 19 reports
//         "vitest: FAIL — fix test failures before review proceeds". Fail-CLOSED on a false
//         premise: a missing binary reported as failing tests.
//   9024  if [ -f "$PROJECT_ROOT/node_modules/.bin/vitest" ]  -> review oracle skipped, so
//         reviewers see no test evidence.
//   10134 grep -E '^ FAIL ' / '^ ❯ .* > ' / '^ +→ '  -> the COMMAND at 10401 was genericised to
//         the project's declared testCommand, but the PARSER was left in vitest's output format.
//         On jest: no failing files parsed, no bug-fix stories created, and the run reports
//         "Could not parse failing test files from vitest output".
//
// The declared source already exists: lib/handlers/codeline-ecosystem.js -> testCommand.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const made: string[] = [];

function makeRepo(runner: 'jest' | 'vitest'): string {
  const d = mkdtempSync(join(tmpdir(), `runner-${runner}-`));
  made.push(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'fixture', scripts: { test: runner }, devDependencies: { [runner]: '^1.0.0' },
  }, null, 2));
  mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
  const bin = join(d, `node_modules/.bin/${runner}`);
  writeFileSync(bin, '#!/bin/sh\nexit 0\n'); chmodSync(bin, 0o755);
  return d;
}

function sh(body: string): string {
  const script = `
set +e
log() { :; }; warning() { :; }; error() { :; }; success() { :; }; info() { :; }
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"
NODE_BIN="${join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node')}"
eval "$(awk '/^_codeline_test_command\\(\\) \\{/,/^\\}/' "${ORCH}")"
eval "$(awk '/^_parse_failing_test_files\\(\\) \\{/,/^\\}/' "${ORCH}")"
${body}
`;
  return (spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout || '').trim();
}

afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe('the test runner comes from the codeline, not from the engine', () => {
  it('resolves a jest repo to its OWN declared command', () => {
    const repo = makeRepo('jest');
    expect(sh(`declare -F _codeline_test_command >/dev/null || { echo NOFUNC; exit 0; }
_codeline_test_command "${repo}"`), 'a jest codeline must not be handed a vitest command')
      .toMatch(/jest|npm test/);
  });

  it('resolves a vitest repo to its own command too — the fix must not invert the bug', () => {
    const repo = makeRepo('vitest');
    expect(sh(`declare -F _codeline_test_command >/dev/null || { echo NOFUNC; exit 0; }
_codeline_test_command "${repo}"`)).toMatch(/vitest|npm test/);
  });
});

describe('failing-test parsing is not tied to one runner\'s output format', () => {
  const VITEST_OUT = [
    ' FAIL  src/a.spec.ts > adds',
    ' ❯ src/a.spec.ts > adds two numbers',
    '   → expected 3 to be 4',
  ].join('\n');

  // Real jest output shape: FAIL with two leading spaces, ● for the failing assertion.
  const JEST_OUT = [
    'FAIL src/a.spec.ts',
    '  ● adds two numbers',
    '    expect(received).toBe(expected)',
  ].join('\n');

  /** Feeds the fixture through a heredoc so bash receives REAL newlines. */
  const parse = (out: string) => sh(`declare -F _parse_failing_test_files >/dev/null || { echo NOFUNC; exit 0; }
OUT=$(cat <<'FIXEOF'
${out}
FIXEOF
)
_parse_failing_test_files "$OUT"`);

  it('the fixtures are genuinely multi-line — otherwise the parser is never exercised', () => {
    expect(VITEST_OUT.split('\n').length).toBeGreaterThan(1);
    expect(JEST_OUT.split('\n').length).toBeGreaterThan(1);
  });

  it('parses vitest output — the format that already worked', () => {
    expect(parse(VITEST_OUT)).toContain('src/a.spec.ts');
  });

  it('THE DEFECT: parses jest output, so bug-fix stories can be created on a jest repo', () => {
    expect(parse(JEST_OUT),
      'no failing file parsed from jest output — no bug-fix story can name the file to fix')
      .toContain('src/a.spec.ts');
  });

  it('a clean run yields no failing files', () => {
    expect(parse('Tests: 12 passed')).toBe('');
  });
});
