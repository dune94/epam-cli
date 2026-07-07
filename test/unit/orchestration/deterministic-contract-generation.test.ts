/**
 * Root cause of a live defect (runs #12-14, 2026-07-03/04): the typescript-engineer
 * profile has a "CONTRACT SCRATCHPAD — MANDATORY LAST STEP" instruction telling the
 * agent to hand-write .contracts/<storyId>.md after finishing a story. Across every
 * observed run, no such file was ever produced — the instruction is pure prompt
 * compliance and the model simply skipped it. Since build_implementation_prompt()'s
 * contract injection only activates `if [ -f "$_contract_file" ]`, dependent stories
 * (SKY-003, SKY-004) got zero contract data and guessed import paths / mock shapes
 * from scratch — reproducing exactly the bug class contract injection was built to
 * eliminate.
 *
 * Fix: generate_story_contract() writes the contract file DETERMINISTICALLY by
 * regex-extracting exported interfaces/classes/methods directly from the story's
 * own source files (technicalNotes.files) — no model compliance required, and it
 * can never be wrong the way an LLM transcription could be, since it's derived
 * straight from the actual code. Wired into run_implementation()'s loop, called
 * right after a story is marked "completed" and before commit_completed_story()
 * (so the contract file lands in the same commit).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// Naive brace-counting breaks on this function: its embedded Python heredoc
// contains regex literals like `\{([^}]*)\}` whose braces don't correspond to
// bash structure at all. Instead, scan line-by-line tracking heredoc state
// (any `<< 'DELIM'` ... `DELIM` block) and only treat a column-0 `}` as the
// function's end when we are NOT currently inside a heredoc.
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

describe('claude.sh — generate_story_contract() is wired into the implementation loop', () => {
  it('function is defined', () => {
    expect(claudeSrc).toMatch(/generate_story_contract\s*\(\)/);
  });

  it('is called after a story is marked completed, before commit_completed_story', () => {
    const implStart = claudeSrc.indexOf('run_implementation() {');
    const loopBody = claudeSrc.slice(implStart, claudeSrc.indexOf('\n}', implStart + 5000));
    const completedIdx = loopBody.indexOf('update_story_status "$story_id" "completed"');
    const contractIdx = loopBody.indexOf('generate_story_contract "$story_id"');
    const commitIdx = loopBody.indexOf('commit_completed_story "$story_id"');
    expect(completedIdx).toBeGreaterThan(-1);
    expect(contractIdx).toBeGreaterThan(completedIdx);
    expect(commitIdx).toBeGreaterThan(contractIdx);
  });

  it('writes to .contracts/<story_id>.md under GIT_WORK_ROOT (matches build_implementation_prompt()\'s read path)', () => {
    const body = extractFunctionBody('generate_story_contract');
    expect(body).toMatch(/\.contracts/);
    expect(body).toMatch(/GIT_WORK_ROOT/);
  });

  it('reads technicalNotes.files from the PRD to know which source files to scan', () => {
    const body = extractFunctionBody('generate_story_contract');
    expect(body).toMatch(/technicalNotes\.files/);
  });

  it('excludes test files from the source scan via a config-supplied excludePattern (a contract should reflect the implementation, not the test)', () => {
    const body = extractFunctionBody('generate_story_contract');
    expect(body).toMatch(/cfg\['excludePattern'\]/);
  });

  it('is config-driven (2026-07-05 refactor): no-op when .epam/contract-generation.json is absent, and contains zero hardcoded TypeScript/Vitest regex or mock-syntax literals — all patterns/templates come from cfg[...]', () => {
    const body = extractFunctionBody('generate_story_contract');
    expect(body).toMatch(/config_file="\$\{_commit_root\}\/\.epam\/contract-generation\.json"/);
    expect(body).toMatch(/\[ -f "\$config_file" \] \|\| return 0/);
    // Every parsing/rendering primitive is read from cfg, not hardcoded.
    for (const key of [
      'sourceExtensions', 'excludePattern', 'interfacePattern', 'classPattern',
      'ctorPattern', 'methodPattern', 'interfaceRenderTemplate', 'classDeclarationTemplate',
      'methodSignatureTemplate', 'mockFactoryTemplate', 'mockMethodTemplateSync', 'mockMethodTemplateAsync',
    ]) {
      expect(body).toContain(`cfg['${key}']`);
    }
    // No literal vi.fn()/vi.mock() syntax baked into the engine itself.
    expect(body).not.toMatch(/vi\.fn\(\)/);
    expect(body).not.toMatch(/vi\.mock\(/);
  });
});

// Mirrors the manifest tier3-travel-app-run.sh embeds at .epam/contract-generation.json
// for the real skyscanner-app project — generate_story_contract() is now opt-in on this
// file's presence and has zero TypeScript/Vitest knowledge of its own (2026-07-05 refactor).
const CONTRACT_GEN_CONFIG = {
  language: 'typescript',
  sourceExtensions: ['.ts'],
  excludePattern: '\\.(test|spec)\\.ts$',
  interfacePattern: 'export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}',
  classPattern: 'export\\s+class\\s+(\\w+)\\s*(?:extends\\s+\\w+\\s*)?\\{',
  ctorPattern: 'constructor\\s*\\(([^)]*)\\)',
  methodPattern: '^\\s*(?:public\\s+|private\\s+|protected\\s+)?(async\\s+)?(\\w+)\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{;]+))?\\s*\\{',
  interfaceRenderTemplate: 'export interface {{name}} {{{body}}}',
  classDeclarationTemplate: 'export class {{className}} {\n  constructor({{ctorParams}});\n{{methodSignatures}}\n}',
  methodSignatureTemplate: '  {{asyncPrefix}}{{methodName}}({{params}}){{returnAnnotation}};',
  asyncPrefixKeyword: 'async ',
  returnAnnotationPrefix: ': ',
  mockFactoryTemplate: "vi.mock('<import-path-to-{{className}}>', () => ({\n  {{className}}: vi.fn().mockImplementation(() => ({\n{{methodMocks}}\n  })),\n}));",
  mockMethodTemplateSync: '    {{methodName}}: vi.fn(),',
  mockMethodTemplateAsync: '    {{methodName}}: vi.fn().mockResolvedValue(undefined),',
};

function writeContractGenConfig(dir: string): void {
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, '.epam', 'contract-generation.json'), JSON.stringify(CONTRACT_GEN_CONFIG));
}

describe('generate_story_contract — no-op when .epam/contract-generation.json is absent (opt-in, same pattern as run_dependency_check())', () => {
  it('does not write a contract file when the manifest is missing, even though real exported classes exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-gen-no-config-'));
    try {
      mkdirSync(join(dir, 'src', 'skyscanner'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'skyscanner', 'client.ts'),
        `export class SkyscannerClient { constructor(apiKey: string) {} }`,
      );
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({ stories: [{ id: 'SKY-002', technicalNotes: { files: ['src/skyscanner/client.ts'] } }] }),
      );
      const fnBody = extractFunctionBody('generate_story_contract');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `PRD_FILE="${prdPath}"\nGIT_WORK_ROOT="${dir}"\n${fnBody}\ngenerate_story_contract "SKY-002"\necho "DONE"\n`);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(output).toContain('DONE');
      expect(existsSync(join(dir, '.contracts', 'SKY-002.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generate_story_contract — REAL execution against a realistic SkyscannerClient fixture', () => {
  function runGenerate(sourceFiles: Record<string, string>, storyId: string): { contractPath: string; content: string | null } {
    const dir = mkdtempSync(join(tmpdir(), 'contract-gen-test-'));
    try {
      writeContractGenConfig(dir);
      for (const [relPath, content] of Object.entries(sourceFiles)) {
        const fullPath = join(dir, relPath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      const filesForPrd = Object.keys(sourceFiles);
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({
        stories: [{ id: storyId, technicalNotes: { files: filesForPrd } }],
      }));

      const fnBody = extractFunctionBody('generate_story_contract');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `PRD_FILE="${prdPath}"\nGIT_WORK_ROOT="${dir}"\n${fnBody}\ngenerate_story_contract "${storyId}"\n`,
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      const contractPath = join(dir, '.contracts', `${storyId}.md`);
      let content: string | null = null;
      try {
        content = readFileSync(contractPath, 'utf8');
      } catch {
        content = null;
      }
      return { contractPath, content };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('extracts the exported interface with all its fields verbatim', () => {
    const { content } = runGenerate({
      'src/skyscanner/client.ts': `
export interface FlightResult {
  airline: string;
  price: number;
  durationMinutes: number;
}

export class SkyscannerClient {
  constructor(apiKey: string) {}
  async searchFlights(params: { from: string; to: string }): Promise<FlightResult[]> { return []; }
}
`,
    }, 'SKY-002');
    expect(content).toContain('export interface FlightResult');
    expect(content).toContain('airline: string');
    expect(content).toContain('price: number');
    expect(content).toContain('durationMinutes: number');
  });

  it('extracts the class constructor signature and every public method — including the mock-hiding method that caused SKY-004\'s incomplete-mock bug', () => {
    const { content } = runGenerate({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor(apiKey: string) {}
  async searchFlights(params: { from: string; to: string }): Promise<any[]> { return []; }
  getApiKey(): string { return ''; }
}
`,
    }, 'SKY-002');
    expect(content).toContain('constructor(apiKey: string)');
    expect(content).toContain('async searchFlights(params: { from: string; to: string }): Promise<any[]>');
    // getApiKey is easy to miss when a model hand-transcribes a mock factory — this is
    // exactly the "incomplete vi.mock factory" bug diagnosed live for SKY-004.
    expect(content).toContain('getApiKey(): string');
  });

  it('generates a mock-factory skeleton listing every method by name (the exact gap that caused repeated SKY-004 mock failures)', () => {
    const { content } = runGenerate({
      'src/skyscanner/client.ts': `
export class SkyscannerClient {
  constructor(apiKey: string) {}
  async searchFlights(params: any): Promise<any[]> { return []; }
  getApiKey(): string { return ''; }
}
`,
    }, 'SKY-002');
    expect(content).toContain('searchFlights: vi.fn().mockResolvedValue(undefined)');
    expect(content).toContain('getApiKey: vi.fn()');
  });

  it('excludes .test.ts files from the source scan even when listed in technicalNotes.files', () => {
    const { content } = runGenerate({
      'src/skyscanner/client.ts': `export class SkyscannerClient { constructor(apiKey: string) {} }`,
      'src/skyscanner/client.test.ts': `export class FakeTestOnlyClass { constructor() {} }`,
    }, 'SKY-002');
    expect(content).toContain('SkyscannerClient');
    expect(content).not.toContain('FakeTestOnlyClass');
  });

  it('writes nothing when the story has no exported interfaces or classes (avoids empty noise files)', () => {
    const { content } = runGenerate({
      'src/cli.ts': `console.log('hello');`,
    }, 'SKY-003');
    expect(content).toBeNull();
  });

  it('writes nothing when technicalNotes.files is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-gen-empty-'));
    try {
      writeContractGenConfig(dir);
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-002', technicalNotes: { files: [] } }] }));
      const fnBody = extractFunctionBody('generate_story_contract');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `PRD_FILE="${prdPath}"\nGIT_WORK_ROOT="${dir}"\n${fnBody}\ngenerate_story_contract "SKY-002"\necho "DONE"\n`);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(output).toContain('DONE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REGRESSION (live, run #15, 2026-07-05): resolves technicalNotes.files absolute paths rooted at MAIN_PROJECT_ROOT against the actual worktree — the real PRD always stores absolute paths, and the earlier tests above (which use relative paths) never exercised this', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-gen-worktree-'));
    try {
      const mainRoot = join(dir, 'main');
      const wtRoot = join(dir, 'wt');
      mkdirSync(join(wtRoot, 'src', 'skyscanner'), { recursive: true });
      writeContractGenConfig(wtRoot);
      // The file exists ONLY in the worktree (SKY-002 hasn't merged to main yet) —
      // this is exactly the live condition: main/ has no src/ at all.
      writeFileSync(
        join(wtRoot, 'src', 'skyscanner', 'client.ts'),
        `export class SkyscannerClient {
  constructor(apiKey: string) {}
  async searchFlights(params: { from: string; to: string }): Promise<any[]> { return []; }
}
`,
      );

      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{
            id: 'SKY-002',
            technicalNotes: {
              // Absolute paths rooted at mainRoot — matches the real PRD's
              // technicalNotes.files shape exactly (confirmed live via
              // `jq '.stories[] | select(.id=="SKY-002") | .technicalNotes.files'`).
              files: [
                join(mainRoot, 'src', 'skyscanner', 'client.ts'),
                join(mainRoot, 'src', 'skyscanner', 'client.test.ts'),
              ],
            },
          }],
        }),
      );

      const fnBody = extractFunctionBody('generate_story_contract');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `PRD_FILE="${prdPath}"\nGIT_WORK_ROOT="${wtRoot}"\nWORKTREE_MODE=primary\nMAIN_PROJECT_ROOT="${mainRoot}"\n${fnBody}\ngenerate_story_contract "SKY-002"\n`,
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      const contractPath = join(wtRoot, '.contracts', 'SKY-002.md');
      const content = readFileSync(contractPath, 'utf8');
      expect(content).toContain('export class SkyscannerClient');
      expect(content).toContain('async searchFlights');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT rewrite paths when WORKTREE_MODE is unset (main-branch invocation, absolute paths already correct)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-gen-mainbranch-'));
    try {
      writeContractGenConfig(dir);
      mkdirSync(join(dir, 'src', 'skyscanner'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'skyscanner', 'client.ts'),
        `export class SkyscannerClient { constructor(apiKey: string) {} }`,
      );
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [{ id: 'SKY-002', technicalNotes: { files: [join(dir, 'src', 'skyscanner', 'client.ts')] } }],
        }),
      );
      const fnBody = extractFunctionBody('generate_story_contract');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `PRD_FILE="${prdPath}"\nGIT_WORK_ROOT="${dir}"\n${fnBody}\ngenerate_story_contract "SKY-002"\n`);
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      const content = readFileSync(join(dir, '.contracts', 'SKY-002.md'), 'utf8');
      expect(content).toContain('export class SkyscannerClient');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
