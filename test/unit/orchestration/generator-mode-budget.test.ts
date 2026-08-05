/**
 * Full agent audit, 2026-07-31: the generator role's narrowed budget
 * (maxIter=3, maxOutTok=16384, vs typescript-engineer's much larger
 * defaults) and its zero-context prompt design were both real and
 * intentional — but only ever asserted by STRING-LOCATION tests (does
 * `build_generator_prompt` get called before/after some other function),
 * never by actually executing `resolve_generator_settings` against a real
 * PRD and checking the resulting shell variables, or executing
 * `build_generator_prompt` and checking its literal rendered output. This
 * closes that coverage gap with real bash execution.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  expect(start, `${name}() not found`).toBeGreaterThan(-1);
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

// Budgets moved to orchestrations/config/llm-defaults.json — the loader must run before the
// extracted function, or it sees no configuration. Declared before first use (const is not
// hoisted: declaring these below the harness gave a temporal-dead-zone ReferenceError).
const _loaderFn = extractFunctionBody('load_llm_settings_json');
const _AUTOMATION = join(__dirname, '../../../orchestrations');

function makePrd(stories: Array<{ id: string; agentRole: string; title?: string; files?: string[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'generator-budget-prd-'));
  const prdPath = join(dir, 'prd.json');
  writeFileSync(
    prdPath,
    JSON.stringify({
      stories: stories.map((s) => ({
        id: s.id,
        title: s.title ?? 'A story',
        description: 'A description',
        acceptanceCriteria: ['Does the thing'],
        agentRole: s.agentRole,
        technicalNotes: { files: s.files ?? [] },
      })),
    }),
  );
  return prdPath;
}

function runResolveGeneratorSettings(prdPath: string, storyId: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'generator-budget-run-'));
  try {
    const script = `
MAIN_PRD_FILE="${prdPath}"
AUTOMATION_DIR="${_AUTOMATION}"
${_loaderFn}
load_llm_settings_json
log() { :; }
${extractFunctionBody('resolve_generator_settings')}
resolve_generator_settings "${storyId}"
echo "STORY_GENERATOR_MODE=$STORY_GENERATOR_MODE"
echo "STORY_MAX_ITERATIONS=$STORY_MAX_ITERATIONS"
echo "STORY_MAX_OUTPUT_TOKENS=$STORY_MAX_OUTPUT_TOKENS"
`;
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);
    const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    const result: Record<string, string> = {};
    for (const line of output.trim().split('\n')) {
      const [k, ...rest] = line.split('=');
      result[k] = rest.join('=');
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBuildGeneratorPrompt(prdPath: string, storyId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'generator-prompt-run-'));
  try {
    // These budgets moved to orchestrations/config/llm-defaults.json, so a harness that runs
// the extracted function ALONE leaves them unset. Run the real loader first, as the
// pipeline does — this keeps the test measuring its own logic, not missing config.
const getStoryDetails = extractFunctionBody('get_story_details');
    const buildPrompt = extractFunctionBody('build_generator_prompt');
    const script = `
PRD_FILE="${prdPath}"
${getStoryDetails}
${buildPrompt}
build_generator_prompt "${storyId}"
`;
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolve_generator_settings — REAL execution against a real PRD', () => {
  it('narrows the budget for a story whose agentRole is "generator"', () => {
    const prdPath = makePrd([{ id: 'GEN-1', agentRole: 'generator' }]);
    try {
      const result = runResolveGeneratorSettings(prdPath, 'GEN-1');
      expect(result.STORY_GENERATOR_MODE).toBe('true');
      expect(result.STORY_MAX_ITERATIONS).toBe('3');
      expect(result.STORY_MAX_OUTPUT_TOKENS).toBe('16384');
    } finally {
      rmSync(prdPath, { recursive: true, force: true });
    }
  });

  it('leaves the budget untouched for a non-generator story', () => {
    const prdPath = makePrd([{ id: 'TS-1', agentRole: 'typescript-engineer' }]);
    try {
      const result = runResolveGeneratorSettings(prdPath, 'TS-1');
      expect(result.STORY_GENERATOR_MODE).toBe('');
      expect(result.STORY_MAX_ITERATIONS).toBe('');
      expect(result.STORY_MAX_OUTPUT_TOKENS).toBe('');
    } finally {
      rmSync(prdPath, { recursive: true, force: true });
    }
  });
});

describe('build_generator_prompt — REAL execution renders the zero-context contract', () => {
  it('names the target file and forbids ReadFile/tool exploration before WriteFile', () => {
    const prdPath = makePrd([{ id: 'GEN-1', agentRole: 'generator', files: ['src/report.html'] }]);
    try {
      const output = runBuildGeneratorPrompt(prdPath, 'GEN-1');
      expect(output).toContain('src/report.html');
      expect(output).toMatch(/MANDATORY FIRST ACTION: Call WriteFile immediately/);
      expect(output).toMatch(/Do NOT call ReadFile, ListFiles, Bash, Search, or any other tool before WriteFile/);
    } finally {
      rmSync(prdPath, { recursive: true, force: true });
    }
  });
});
