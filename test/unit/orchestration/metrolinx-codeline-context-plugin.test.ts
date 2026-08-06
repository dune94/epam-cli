/**
 * Metrolinx codeline-context plugin (orchestrations/plugins/codeline-context-tools.js)
 * — the first real ToolPlugin built against the epam-cli plugin architecture
 * (src/tools/plugin.ts / PluginLoader.ts), added 2026-08-01 after two live
 * mistakes in the same session: a writer created a test file at a path that
 * didn't match the codeline's real convention, and a commit failed against a
 * real pre-commit hook because required env vars weren't documented anywhere
 * the agent could see.
 *
 * PROJECT-AGNOSTIC BY DESIGN: the plugin module itself contains no reference
 * to any project or codeline name — these tests exercise it against real
 * temp git repos, not against the live Metrolinx codelines.
 *
 * Real filesystem + real git repos throughout, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PLUGIN_PATH = join(__dirname, '../../../orchestrations/plugins/codeline-context-tools.js');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codeline-ctx-'));
  cleanupDirs.push(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  return repo;
}

/** Load the real plugin module and run its execute() with cwd temporarily switched. */
async function runTool(name: string, repo: string, input: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tools } = require(PLUGIN_PATH) as { tools: Array<{ name: string; execute: (i: any) => Promise<any> }> };
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in plugin`);
  const originalCwd = process.cwd();
  process.chdir(repo);
  try {
    return await tool.execute(input);
  } finally {
    process.chdir(originalCwd);
  }
}

describe('plugin module — loads via the real PluginLoader contract', () => {
  it('exports exactly the 4 expected tools, each pluginApiVersion 1.0.0', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tools } = require(PLUGIN_PATH) as { tools: Array<{ name: string; pluginApiVersion: string }> };
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_anti_patterns',
      'codeline_facts',
      'git_state',
      'resolve_test_file',
    ]);
    expect(tools.every((t) => t.pluginApiVersion === '1.0.0')).toBe(true);
  });

  it('every tool conforms to the Tool shape PluginLoader.validatePlugin requires', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tools } = require(PLUGIN_PATH) as Array<any> & { tools: any[] };
    for (const t of (tools as any).tools ?? tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.execute).toBe('function');
      expect(['safe', 'review', 'dangerous']).toContain(t.permission);
      expect(t.definition.inputSchema.type).toBe('object');
    }
  });
});

describe('resolve_test_file', () => {
  it('recommends the co-located __tests__ convention when it is the only one that exists', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/services/__tests__'), { recursive: true });
    writeFileSync(join(repo, 'src/services/contentstack.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src/services/__tests__/contentstack.spec.ts'), 'describe("x", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/services/contentstack.ts' });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.existingTestFiles).toContain('src/services/__tests__/contentstack.spec.ts');
    expect(parsed.recommendation).toContain('src/services/__tests__/contentstack.spec.ts');
  });

  it('reports ALL existing candidates when more than one exists (the exact scenario that caused a real mistake)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/services/__tests__'), { recursive: true });
    mkdirSync(join(repo, 'test/unit/services'), { recursive: true });
    writeFileSync(join(repo, 'src/services/contentstack.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src/services/__tests__/contentstack.spec.ts'), 'describe("real", () => {});\n');
    writeFileSync(join(repo, 'test/unit/services/contentstack.test.ts'), 'describe("wrong-path", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/services/contentstack.ts' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toHaveLength(2);
    expect(parsed.existingTestFiles).toContain('src/services/__tests__/contentstack.spec.ts');
    expect(parsed.existingTestFiles).toContain('test/unit/services/contentstack.test.ts');
    // Co-located __tests__ is the recommended one — it's tried first.
    expect(parsed.recommendation).toContain('src/services/__tests__/contentstack.spec.ts');
  });

  it('reports no existing test file and suggests the most conventional new location when nothing exists', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/utils'), { recursive: true });
    writeFileSync(join(repo, 'src/utils/brandNew.ts'), 'export const x = 1;\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/utils/brandNew.ts' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toEqual([]);
    expect(parsed.checkedCandidates.length).toBeGreaterThan(0);
    expect(parsed.recommendation).toContain(parsed.checkedCandidates[0]);
  });

  it('returns an error result when sourceFile is missing', async () => {
    const repo = makeRepo();
    const result = await runTool('resolve_test_file', repo, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('sourceFile');
  });
});

describe('codeline_facts', () => {
  it('returns a real, curated facts list when .epam/codeline-facts.json exists', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(
      join(repo, '.epam/codeline-facts.json'),
      JSON.stringify({ facts: ['fact one', 'fact two'] }),
    );

    const result = await runTool('codeline_facts', repo);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.facts).toEqual(['fact one', 'fact two']);
  });

  it('reports no facts configured when the file is absent (silent, not an error)', async () => {
    const repo = makeRepo();
    const result = await runTool('codeline_facts', repo);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no codeline-specific facts/i);
  });
});

describe('git_state', () => {
  it('reports the real branch, HEAD, and clean status', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: repo });

    const result = await runTool('git_state', repo);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.branch).toBe('main');
    expect(parsed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.dirty).toBe(false);
    expect(parsed.changedFiles).toEqual([]);
  });

  it('reports dirty=true with the real list of changed files', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');

    const result = await runTool('git_state', repo);
    const parsed = JSON.parse(result.content);

    expect(parsed.dirty).toBe(true);
    expect(parsed.changedFiles.length).toBe(2);
  });

  it('returns an error result when run outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeline-ctx-nogit-'));
    cleanupDirs.push(dir);
    const result = await runTool('git_state', dir);
    expect(result.isError).toBe(true);
  });
});

describe('check_anti_patterns', () => {
  const RULES = JSON.stringify([
    {
      id: 'example-wrong-key',
      matchPattern: 'wrongOption\\s*:\\s*\\{[^}]*wrongKey',
      message: 'Use rightKey, not wrongKey, inside wrongOption.',
    },
  ]);

  it('reports no rules configured when .epam/anti-patterns.json is absent (silent, not an error)', async () => {
    const repo = makeRepo();
    const result = await runTool('check_anti_patterns', repo, { content: 'anything' });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no anti-pattern rules/i);
  });

  it('reports a violation when content matches a configured rule', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/anti-patterns.json'), RULES);

    const result = await runTool('check_anti_patterns', repo, {
      content: 'wrongOption: { wrongKey: 1 }',
      filePath: 'src/x.ts',
    });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.violations).toHaveLength(1);
    expect(parsed.violations[0].file).toBe('src/x.ts');
    expect(parsed.violations[0].message).toMatch(/rightKey/);
  });

  it('reports no violations when content does not match any configured rule', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/anti-patterns.json'), RULES);

    const result = await runTool('check_anti_patterns', repo, {
      content: 'wrongOption: { rightKey: 1 }',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no configured anti-pattern matched/i);
  });

  it('never blocks (isError:false) when anti-patterns.json is malformed', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/anti-patterns.json'), '{ not valid json');

    const result = await runTool('check_anti_patterns', repo, { content: 'anything' });
    expect(result.isError).toBe(false);
  });

  it('returns an error result when content is missing', async () => {
    const repo = makeRepo();
    const result = await runTool('check_anti_patterns', repo, {} as any);
    expect(result.isError).toBe(true);
  });
});

describe('resolve_test_file — cross-extension conventions (real across all 3 metrolinx codelines)', () => {
  // Surveyed live 2026-08-06 across next.metrolinx.com, next.gotransit.com,
  // next.upexpress.com: every codeline mixes .ts and .tsx test files roughly evenly
  // (106/139, 370/366, 104/137). A .tsx source paired with a .spec.ts test — exactly
  // AMSD-2041's shape — is common, not an edge case. The tool only tried the SOURCE
  // file's own extension when building candidates, so a .tsx source never got .ts
  // candidates checked at all: a real, committed, on-topic test file was invisible to
  // every review cycle, and no amount of retrying could ever satisfy that check.
  it('THE BUG: a .tsx source file with a real, existing .spec.ts test is found, not missed', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/pages'), { recursive: true });
    writeFileSync(join(repo, 'src/pages/[[...slug]].tsx'), 'export default function Page() { return null; }\n');
    writeFileSync(join(repo, 'src/pages/[[...slug]].spec.ts'), 'describe("Page", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/pages/[[...slug]].tsx' });
    const parsed = JSON.parse(result.content);

    expect(
      parsed.existingTestFiles,
      'a real, committed, on-topic test file existed and was reported missing on every review cycle',
    ).toContain('src/pages/[[...slug]].spec.ts');
  });

  it('the reverse also holds: a .ts source with an existing .spec.tsx test is found', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/hooks'), { recursive: true });
    writeFileSync(join(repo, 'src/hooks/useContent.ts'), 'export function useContent() {}\n');
    writeFileSync(join(repo, 'src/hooks/useContent.spec.tsx'), 'describe("useContent", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/hooks/useContent.ts' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toContain('src/hooks/useContent.spec.tsx');
  });

  it('a co-located __tests__ dir with a cross-extension file is found too, not just sibling files', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/components/__tests__'), { recursive: true });
    writeFileSync(join(repo, 'src/components/Gallery.tsx'), 'export default function Gallery() { return null; }\n');
    writeFileSync(join(repo, 'src/components/__tests__/Gallery.test.ts'), 'describe("Gallery", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/components/Gallery.tsx' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toContain('src/components/__tests__/Gallery.test.ts');
  });
});

describe('resolve_test_file — the src/__tests__/ top-level mirror (real across all 3 codelines)', () => {
  // Confirmed live 2026-08-06 by checking the actual files, not inventing a convention:
  //   next.metrolinx.com:  src/__tests__/[[...slug]].spec.ts        (flat)
  //   next.gotransit.com:  src/__tests__/[...slug].spec.ts          (flat)
  //   next.upexpress.com:  src/__tests__/pages/[[...slug]].spec.ts  (nested, mirrors src/pages/)
  // None of the tool's three existing strategies (co-located __tests__, sibling, project-root
  // test/ mirror) cover a top-level src/__tests__/ mirror that KEEPS the src/ prefix. This is
  // very likely why the original writer (the incident this plugin exists to prevent) created a
  // new file at the wrong location: the tool never found the real, correctly-placed baseline
  // test for [[...slug]].tsx, because src/__tests__/[[...slug]].spec.ts was never a candidate.
  it('finds a FLAT src/__tests__/ mirror (metrolinx and gotransit\'s real convention)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/__tests__'), { recursive: true });
    mkdirSync(join(repo, 'src/pages'), { recursive: true });
    writeFileSync(join(repo, 'src/pages/[[...slug]].tsx'), 'export default function Page() { return null; }\n');
    writeFileSync(join(repo, 'src/__tests__/[[...slug]].spec.ts'), 'describe("Page", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/pages/[[...slug]].tsx' });
    const parsed = JSON.parse(result.content);

    expect(
      parsed.existingTestFiles,
      'the real baseline test for this exact page (metrolinx\'s actual convention) was never checked',
    ).toContain('src/__tests__/[[...slug]].spec.ts');
  });

  it('finds a NESTED src/__tests__/<subdir>/ mirror (upexpress\'s real convention)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/__tests__/pages'), { recursive: true });
    mkdirSync(join(repo, 'src/pages'), { recursive: true });
    writeFileSync(join(repo, 'src/pages/[[...slug]].tsx'), 'export default function Page() { return null; }\n');
    writeFileSync(join(repo, 'src/__tests__/pages/[[...slug]].spec.ts'), 'describe("Page", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/pages/[[...slug]].tsx' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toContain('src/__tests__/pages/[[...slug]].spec.ts');
  });

  it('does not report a src/__tests__/ file for an UNRELATED source (no false positives)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/__tests__'), { recursive: true });
    mkdirSync(join(repo, 'src/pages'), { recursive: true });
    writeFileSync(join(repo, 'src/pages/other.tsx'), 'export default function Other() { return null; }\n');
    writeFileSync(join(repo, 'src/__tests__/[[...slug]].spec.ts'), 'describe("Page", () => {});\n');

    const result = await runTool('resolve_test_file', repo, { sourceFile: 'src/pages/other.tsx' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toEqual([]);
  });
});

describe('every plugin tool, run against all 3 REAL codelines (not synthetic temp repos)', () => {
  // Directive: plugin coverage must be rooted in the actual project codelines this plugin
  // runs against, not one narrow invented case. All 4 tools, all 3 real repos.
  const REAL_CODELINES = [
    '/home/bradleyjerome/projects/metrolinx/next.metrolinx.com',
    '/home/bradleyjerome/projects/metrolinx/next.gotransit.com',
    '/home/bradleyjerome/projects/metrolinx/next.upexpress.com',
  ].filter((p) => {
    try { return require('node:fs').statSync(p).isDirectory(); } catch { return false; }
  });

  it('at least the 3 expected real codelines are present on this machine to test against', () => {
    expect(REAL_CODELINES.length, 'no real codelines found — this suite would silently test nothing').toBe(3);
  });

  describe.each(REAL_CODELINES)('%s', (repoPath) => {
    it('git_state reports the SAME branch and HEAD as real git, directly verified', async () => {
      const realBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
      const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

      const result = await runTool('git_state', repoPath);
      const parsed = JSON.parse(result.content);

      expect(result.isError).toBe(false);
      expect(parsed.branch).toBe(realBranch);
      expect(parsed.head).toBe(realHead);
    });

    it('codeline_facts does not crash and returns a real, well-formed result against the real repo', async () => {
      const result = await runTool('codeline_facts', repoPath);
      expect(result.isError).toBe(false);
      expect(typeof result.content).toBe('string');
    });

    it('check_anti_patterns does not crash against the real repo (no rules configured is a valid, silent result)', async () => {
      const result = await runTool('check_anti_patterns', repoPath, { content: 'export const x = 1;' });
      expect(result.isError).toBe(false);
    });

    it('resolve_test_file finds the REAL, pre-existing baseline test for the slug catch-all page', async () => {
      // The exact file this whole investigation started from — AMSD-2041's real fix site.
      const fs = require('node:fs');
      const candidates = [
        'src/pages/[[...slug]].tsx',
        'src/pages/[...slug].tsx',
      ].filter((f) => fs.existsSync(join(repoPath, f)));
      if (candidates.length === 0) return; // this codeline doesn't have a catch-all page — nothing to assert

      const result = await runTool('resolve_test_file', repoPath, { sourceFile: candidates[0] });
      const parsed = JSON.parse(result.content);

      // gotransit is a known exception: its page was renamed [...slug].tsx -> [[...slug]].tsx
      // at some point without renaming the test file (still src/__tests__/[...slug].spec.ts,
      // a genuinely different basename) — a real pre-existing inconsistency in that repo, not
      // a gap in this tool. A same-basename match correctly does not paper over that.
      if (repoPath.includes('gotransit')) {
        expect(parsed.existingTestFiles).toEqual([]);
        return;
      }
      expect(
        parsed.existingTestFiles.length,
        `the real baseline test for ${candidates[0]} was not found in ${repoPath} — the exact class of ` +
          'miss that caused AMSD-2041\'s review to loop forever on a false "no tests" claim',
      ).toBeGreaterThan(0);
    });
  });
});
