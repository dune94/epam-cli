/**
 * apply_known_fix() (claude.sh) — deterministic second-line safety net for
 * recurring self-heal failures.
 *
 * Root cause this fixes (found live, 2026-07-06): the FailureAnalyst's fix
 * routing has exactly 5 targets (prd, tc, tool, skill, kb) and none of them
 * means "directly patch the content of a file the agent already wrote." SKY-001
 * repeatedly failed on "vitest exits 1 with zero test files" — the analyst
 * correctly diagnosed the exact one-line fix needed (add passWithNoTests to
 * vitest.config.ts) at TWO different model tiers, but picked target=tool
 * (writes an unrelated helper script) then target=tc (patches documentation
 * text) — neither can touch the file's actual content, so the diagnosis
 * recurred and the story exhausted its entire retry ladder.
 *
 * Design constraint: NOT a 6th LLM-facing target (growing the analyst's enum
 * gives it one more way to be wrong, not a better chance of being right).
 * Instead, a deterministic, config-driven layer that only engages after
 * check_healing_effectiveness has already detected 2+ repeats — all
 * stack-specific knowledge (file, snippet, symptom pattern) lives in the
 * project's own .epam/known-fixes.json, same convention as
 * .epam/dependency-check.json and .epam/contract-generation.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const tier3Src = readFileSync(TIER3_SH, 'utf8');

// apply_known_fix() contains a python heredoc — a naive `indexOf('\n}', ...)`
// search would stop at the heredoc's own closing braces (e.g. the dict/loop
// bodies), so track heredoc state line-by-line like the existing
// check_healing_effectiveness extractor in healing-effectiveness.test.ts.
function extractFunctionBody(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
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

const VITEST_FIX_CONFIG = [
  {
    id: 'vitest-pass-with-no-tests',
    symptomPattern:
      '(?:vitest|test).*(?:no test files|zero test files).*exit|exit.*1.*(?:no|zero) test files|passWithNoTests',
    targetFile: 'vitest.config.ts',
    checkPattern: 'passWithNoTests',
    insertAfterPattern: 'test:\\s*\\{',
    insertText: '\n    passWithNoTests: true,',
  },
];

function runApplyKnownFix(opts: {
  configFile: object | null;
  targetFileContent?: string;
  targetFileName?: string;
  diagnosis: string;
}): { exitCode: number; stdout: string; finalFileContent: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'known-fix-test-'));
  const targetFileName = opts.targetFileName ?? 'vitest.config.ts';
  try {
    if (opts.configFile) {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam/known-fixes.json'), JSON.stringify(opts.configFile));
    }
    if (opts.targetFileContent !== undefined) {
      writeFileSync(join(dir, targetFileName), opts.targetFileContent);
    }
    const fnBody = extractFunctionBody('apply_known_fix');
    const scriptPath = join(dir, 'run.sh');
    const escapedDiagnosis = opts.diagnosis.replace(/'/g, `'\\''`);
    writeFileSync(
      scriptPath,
      [
        'log() { :; }',
        fnBody,
        `apply_known_fix "${dir}" '${escapedDiagnosis}'`,
        'echo "EXIT:$?"',
      ].join('\n')
    );
    const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    const exitMatch = stdout.match(/EXIT:(\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : -1;
    let finalFileContent: string | null = null;
    try {
      finalFileContent = readFileSync(join(dir, targetFileName), 'utf8');
    } catch {
      /* file may not exist in some fixtures */
    }
    return { exitCode, stdout, finalFileContent };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('apply_known_fix() — design constraints (static)', () => {
  const body = extractFunctionBody('apply_known_fix');

  it('no-ops (returns 1) when .epam/known-fixes.json is absent (opt-in, like dependency-check.json)', () => {
    expect(body).toMatch(/\[ -f "\$config_file" \] \|\| return 1/);
  });

  it('reads everything stack-specific from .epam/known-fixes.json — no hardcoded file names or snippets in the engine', () => {
    expect(body).toMatch(/\.epam\/known-fixes\.json/);
    expect(body).not.toMatch(/vitest\.config\.ts|passWithNoTests/);
  });

  it('is wired into check_healing_effectiveness before HEALING_BROKEN is set, and returns early (does not fall through to the CRITICAL escalation) on success', () => {
    const idx = claudeSrc.indexOf('function check_healing_effectiveness');
    const altIdx = claudeSrc.indexOf('check_healing_effectiveness() {');
    const start = idx !== -1 ? idx : altIdx;
    const applyIdx = claudeSrc.indexOf('apply_known_fix "${PROJECT_ROOT:-}"', start);
    const brokenIdx = claudeSrc.indexOf('HEALING_BROKEN=1', start);
    expect(applyIdx).toBeGreaterThan(start);
    expect(brokenIdx).toBeGreaterThan(applyIdx);
    // The apply_known_fix call must be gated by an if that returns early on success.
    const snippet = claudeSrc.slice(applyIdx - 20, applyIdx + 120);
    expect(snippet).toMatch(/if apply_known_fix/);
  });
});

describe('apply_known_fix() — REAL execution', () => {
  it('no-ops (exit 1) when no .epam/known-fixes.json exists', () => {
    const result = runApplyKnownFix({
      configFile: null,
      diagnosis: 'vitest exits 1 with zero test files',
    });
    expect(result.exitCode).toBe(1);
  });

  it('REPRODUCES the exact live fix: applies passWithNoTests to vitest.config.ts when the diagnosis matches', () => {
    const result = runApplyKnownFix({
      configFile: VITEST_FIX_CONFIG,
      targetFileContent: `import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n  test: {\n    globals: true,\n  },\n});\n`,
      diagnosis: 'AC7 omits test.passWithNoTests:true; vitest exits 1 with no test files by default, violating AC12',
    });
    expect(result.exitCode).toBe(0);
    expect(result.finalFileContent).toContain('passWithNoTests: true');
    expect(result.finalFileContent).toContain('globals: true');
  });

  it('does not double-patch when passWithNoTests is already present (avoids false "fix applied" claims for a different root cause)', () => {
    const alreadyFixed = `export default defineConfig({\n  test: {\n    passWithNoTests: true,\n    globals: true,\n  },\n});\n`;
    const result = runApplyKnownFix({
      configFile: VITEST_FIX_CONFIG,
      targetFileContent: alreadyFixed,
      diagnosis: 'vitest exits 1 with no test files',
    });
    expect(result.exitCode).toBe(1);
    expect(result.finalFileContent).toBe(alreadyFixed);
  });

  it('does not match and does not modify the file when the diagnosis is unrelated', () => {
    const original = `export default defineConfig({\n  test: {\n    globals: true,\n  },\n});\n`;
    const result = runApplyKnownFix({
      configFile: VITEST_FIX_CONFIG,
      targetFileContent: original,
      diagnosis: 'TypeError: Cannot read properties of undefined (reading "map") in src/cli.ts',
    });
    expect(result.exitCode).toBe(1);
    expect(result.finalFileContent).toBe(original);
  });

  it('no-ops (exit 1) when the target file declared in the config does not exist on disk', () => {
    const result = runApplyKnownFix({
      configFile: VITEST_FIX_CONFIG,
      diagnosis: 'vitest exits 1 with no test files',
      // deliberately omit targetFileContent — vitest.config.ts never created
    });
    expect(result.exitCode).toBe(1);
  });

  it('is fully generic — a second, unrelated project could supply its own known-fixes.json entry and get the same mechanism for a totally different symptom/file', () => {
    const genericConfig = [
      {
        id: 'flask-debug-mode',
        symptomPattern: 'debug mode.*disabled|500 error.*traceback',
        targetFile: 'app.py',
        checkPattern: 'debug=True',
        insertAfterPattern: 'app = Flask\\(__name__\\)',
        insertText: '\napp.debug = True',
      },
    ];
    const result = runApplyKnownFix({
      configFile: genericConfig,
      targetFileContent: `app = Flask(__name__)\n`,
      targetFileName: 'app.py',
      diagnosis: 'debug mode is disabled, cannot see traceback',
    });
    expect(result.exitCode).toBe(0);
    expect(result.finalFileContent).toContain('app.debug = True');
  });
});

describe('tier3-travel-app-run.sh — supplies the known-fixes manifest for this project (per-orchestration, not baked into claude.sh)', () => {
  it('writes .epam/known-fixes.json for the output project', () => {
    expect(tier3Src).toMatch(/\.epam\/known-fixes\.json/);
  });

  it('declares the vitest passWithNoTests fix (the exact live-diagnosed recurring failure)', () => {
    const idx = tier3Src.indexOf("<< 'KNOWNFIXES_EOF'") + "<< 'KNOWNFIXES_EOF'".length;
    const end = tier3Src.indexOf('KNOWNFIXES_EOF', idx);
    const block = tier3Src.slice(idx, end);
    expect(block).toMatch(/"targetFile":\s*"vitest\.config\.ts"/);
    expect(block).toMatch(/"checkPattern":\s*"passWithNoTests"/);
  });
});
