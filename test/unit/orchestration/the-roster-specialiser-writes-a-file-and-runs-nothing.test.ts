/**
 * THE ROSTER SPECIALISER WRITES A FILE AND RUNS NOTHING.
 *
 * Run 20260912T172213Z (regintel, greenfield, openrouter): the mint's roster specialiser failed
 * three of three attempts with "the agent wrote no roster". What it did instead, with bash in
 * its grant and the writer's 150-iteration budget: attempt 1 (glm-5.3, 157 tool calls) decided
 * "the build directory is empty — I'll implement the PRD stories now" and copied the source
 * repository into the codeline; attempt 2 (kimi-k3, 150 calls) explored the registry with
 * node -e scripts; attempt 3 (kimi-k3, 46 calls, 1.4M input tokens) ended emitting tool calls
 * with empty arguments at eight minutes each. The prompt had told it "The stack in use: unknown",
 * because the greenfield codeline had no manifest yet and nothing asked the PRD.
 *
 * Three declarations, all executed here:
 *   - a grant kind that writes a file and runs nothing (config/spec-mode-defaults.json write-file);
 *   - the specialiser's own tool-call budget reaches the runner from the registry through
 *     seamInvocationEnv (it was declared for shell seams only);
 *   - stack facts for a codeline that is not built yet come from the PRD's own declarations.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const registry = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
const anyProject = () => {
  const dir = join(ROOT, 'orchestrations/projects');
  const p = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && existsSync(join(dir, e.name, 'config.env')));
  return join(dir, p!.name);
};

describe('a grant that writes a file and runs nothing', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tools = require(join(LIB, 'agent-tools.js'));
  it('write-file is the read-only floor plus write_file — and no shell', () => {
    const granted = tools.toolGrantFor('write-file').split(',');
    expect(granted).toContain('write_file');
    expect(granted).not.toContain('bash');
    for (const t of tools.readOnlyToolGrant().split(',').filter(Boolean)) expect(granted).toContain(t);
  });
  it('every seam whose job is one JSON file for the pipeline takes it', () => {
    for (const seam of ['roster-specialiser', 'phase-assessment', 'prd-model-coordinator']) {
      expect(registry.profiles[seam].toolGrant, `${seam} still holds a shell`).toBe('write-file');
    }
  });
});

describe('the specialiser\'s budget reaches the runner', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { seamInvocationEnv } = require(join(LIB, 'seam-invocation.js'));
  it('EPAM_MAX_TOOL_CALLS is the registry\'s number, and the tools carry no bash', () => {
    const declared = registry.profiles['roster-specialiser'].maxToolCalls;
    expect(declared, 'the specialiser declares no tool-call budget').toBeGreaterThan(0);
    expect(declared, 'a budget in the hundreds is the writer\'s, not a JSON author\'s').toBeLessThan(50);
    const env = seamInvocationEnv('roster-specialiser', join(ROOT, 'orchestrations/agents'), { env: { EPAM_PROJECT_CONFIG_DIR: anyProject() } });
    expect(env.EPAM_MAX_TOOL_CALLS).toBe(String(declared));
    expect(env.EPAM_ALLOWED_TOOLS.split(',')).not.toContain('bash');
    expect(env.EPAM_ALLOWED_TOOLS.split(',')).toContain('write_file');
  });
});

describe('stack facts for a codeline that is not built yet come from the PRD', () => {
  function facts(repo: string, prd?: string) {
    const r = spawnSync(process.execPath, [join(LIB, 'handlers/stack-facts.js'), repo], {
      encoding: 'utf8', env: { ...process.env, ...(prd ? { PRD_FILE: prd } : { PRD_FILE: '' }) },
    });
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  }
  const prdNaming = (manifest: string, skills: string[]) => {
    const f = join(tmp('prd-'), 'prd.json');
    writeFileSync(f, JSON.stringify({ stories: [{ id: 'S-1', technicalNotes: { files: [`src/a.x`, manifest], requiredSkills: skills } }] }));
    return f;
  };

  it('an empty codeline with no PRD is unknown — nothing invented', () => {
    expect(facts(tmp('empty-')).__STACK__).toBe('unknown');
  });

  it('an empty codeline whose PRD names a provider\'s manifest is that ecosystem, said as a declaration', () => {
    // The manifest name comes from the providers on disk, never from this file.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { allManifests } = require(join(LIB, 'ecosystem-registry.js'));
    const tryCmd = (e: any) => { try { return typeof e.testCommand === 'function' ? e.testCommand('pytest\n', '') : ''; } catch { return ''; } };
    const withTest = allManifests().find((e: any) => tryCmd(e));
    expect(withTest, 'no provider derives a test command from a dependency list').toBeTruthy();
    const f = facts(tmp('empty-'), prdNaming(withTest.file, ['pytest']));
    expect(f.__STACK__).toMatch(new RegExp(`^${withTest.stack} \\(declared by the PRD`));
    expect(f.__MANIFEST_FILE__).toBe(withTest.file);
    expect(f.__TEST_COMMAND__).toBe(tryCmd(withTest));
  });

  it('a codeline that HAS a manifest is read from the manifest, whatever the PRD says', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { allManifests } = require(join(LIB, 'ecosystem-registry.js'));
    const [a, b] = allManifests().filter((e: any) => e.stack).slice(0, 2);
    const repo = tmp('built-'); writeFileSync(join(repo, a.file), '');
    const f = facts(repo, prdNaming(b.file, []));
    expect(f.__MANIFEST_FILE__).toBe(a.file);
    expect(f.__STACK__).not.toMatch(/declared by the PRD/);
  });
});
