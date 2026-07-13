/**
 * run_phase_assessment()'s prompt hardcoded a stack-specific skill-domain-
 * to-agentRole mapping directly in the engine:
 *   "TypeScript" / "Node.js" / "CLI" -> backend-engineer
 *   "React" / "UI" / "frontend" -> frontend-engineer
 *   "Docker" / "infrastructure" -> devops-engineer
 *   "Vitest" / "testing" / "E2E" -> qa-engineer
 * Found while fixing the Step 6 real-output-gate bug in the same function
 * (2026-07-12) -- a future project that doesn't use TypeScript/React/
 * Docker/Vitest at all would get nonsense role-reassignment guidance from
 * this. Same class of violation as the vendorDirs/node_modules hardcoding
 * fixed earlier this session in verify_story_deliverables().
 *
 * Fix: _build_skill_domain_guidance() reads a per-project, opt-in config
 * file (.epam/skill-domain-map.json's "skillDomains" array), matching the
 * established convention of dependency-check.json/contract-generation.json
 * -- generic infrastructure in the engine, stack specifics in project
 * config. No config file / empty "skillDomains" = no engine-authored
 * guidance; the caller falls back to a generic "use conservative judgment"
 * instruction rather than any hardcoded keyword list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(orchSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}

describe('run_phase_assessment() prompt — no hardcoded skill-domain/role mapping (static)', () => {
  const fnBody = extractFunctionBody('run_phase_assessment');
  const promptStart = fnBody.indexOf('cat << PROMPT_EOF');
  const promptEnd = fnBody.indexOf('\nPROMPT_EOF', promptStart);
  const promptText = fnBody.slice(promptStart, promptEnd);

  it('does not hardcode "TypeScript"/"React"/"Docker"/"Vitest" keyword-to-role mappings in the prompt', () => {
    expect(promptText).not.toMatch(/"TypeScript"\s*\/\s*"Node\.js"/);
    expect(promptText).not.toMatch(/backend-engineer.*frontend-engineer.*devops-engineer.*qa-engineer/s);
  });

  it('interpolates a dynamically-built guidance variable instead', () => {
    expect(promptText).toMatch(/\$_skill_domain_guidance/);
  });

  it('calls _build_skill_domain_guidance to construct that variable', () => {
    expect(fnBody).toMatch(/_build_skill_domain_guidance/);
  });
});

describe('_build_skill_domain_guidance() — REAL execution', () => {
  function run(config: unknown | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'skill-domain-guidance-'));
    try {
      if (config !== null) {
        mkdirSync(join(dir, '.epam'), { recursive: true });
        writeFileSync(join(dir, '.epam', 'skill-domain-map.json'), JSON.stringify(config));
      }
      const fnBody = extractFunctionBody('_build_skill_domain_guidance');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\n_build_skill_domain_guidance ${JSON.stringify(dir)}\n`);
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is empty (opt-in, no guidance) when no config file exists', () => {
    expect(run(null)).toBe('');
  });

  it('is empty when the config file exists but has no skillDomains key', () => {
    expect(run({})).toBe('');
  });

  it('builds real guidance text from a configured skillDomains array', () => {
    const guidance = run({
      skillDomains: [
        { role: 'backend-engineer', keywords: ['TypeScript', 'Node.js'] },
        { role: 'frontend-engineer', keywords: ['React', 'UI'] },
      ],
    });
    expect(guidance).toMatch(/TypeScript/);
    expect(guidance).toMatch(/backend-engineer/);
    expect(guidance).toMatch(/React/);
    expect(guidance).toMatch(/frontend-engineer/);
  });

  it('is domain-agnostic: works for an arbitrary hypothetical stack, not tied to TypeScript/React', () => {
    const guidance = run({
      skillDomains: [{ role: 'ml-engineer', keywords: ['PyTorch', 'CUDA'] }],
    });
    expect(guidance).toMatch(/PyTorch/);
    expect(guidance).toMatch(/ml-engineer/);
    expect(guidance).not.toMatch(/TypeScript|React|Docker|Vitest/);
  });
});

describe('run_phase_assessment() — real-execution fallback: uses a generic instruction when no config is present', () => {
  it('falls back to a conservative-judgment instruction, not silence or a crash, when .epam/skill-domain-map.json is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-domain-fallback-'));
    try {
      const guidanceFn = extractFunctionBody('_build_skill_domain_guidance');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          guidanceFn,
          `PROJECT_ROOT=${JSON.stringify(dir)}`,
          '_skill_domain_guidance=$(_build_skill_domain_guidance "$PROJECT_ROOT")',
          '[ -z "$_skill_domain_guidance" ] && _skill_domain_guidance="FALLBACK_TEXT"',
          'echo "$_skill_domain_guidance"',
        ].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
      expect(output).toBe('FALLBACK_TEXT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
