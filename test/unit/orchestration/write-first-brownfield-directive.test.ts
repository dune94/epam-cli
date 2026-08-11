/**
 * The write-first vs read-first-before-writing directive in
 * build_implementation_prompt() — REAL execution of the actual, unmodified
 * bash blocks, extracted by marker (not re-implemented).
 *
 * Built 2026-07-23 after the real Metrolinx AMSD-1820 run failed 8/8
 * attempts, at every model tier including the ladder's highest
 * (moonshotai/kimi-k3, high effort), always with the SAME root cause per the
 * FailureAnalyst: "Agent invented non-existent module paths... referenced
 * missing exports." Traced to a single unconditional directive baked into
 * EVERY story prompt: "CRITICAL — WRITE FILES FIRST... Do NOT plan... do NOT
 * investigate." Correct for greenfield (nothing exists yet to read). Wrong
 * for brownfield: forbidding investigation of an EXISTING file guarantees
 * the agent can't see its real exports, so it hallucinates plausible ones
 * instead.
 *
 * First fix (gate the directive on EPAM_BROWNFIELD, telling the agent to
 * ReadFile first) traded that problem for a NEW one, also found live: each
 * real ReadFile call accumulates in the ReAct loop's conversation history,
 * and every subsequent turn resends the whole growing transcript — attempts
 * were reporting ~240,000 input tokens (vs. a ~3,000-token static prompt)
 * and then failing outright with 0 output bytes. Real fix (matching the
 * already-established dependency_contracts pattern: "Inject it directly so
 * it's guaranteed, not requested"): deterministically read each existing
 * file's content ONCE in bash and inject it directly into the prompt,
 * capped at a fixed line budget — same real grounding, fixed one-time cost
 * instead of a cost that multiplies with every tool-call turn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

// The per-file loop (READ-vs-WRITE phrasing + content injection) and the
// directive selection (the "CRITICAL —" header text) are two adjacent,
// independently extractable blocks in the real function.
const fileLoopBlock = extractBlock(
  '    local write_first_lines=""',
  '    # "Do NOT investigate" is right for greenfield',
);
const directiveBlock = extractBlock(
  '    # "Do NOT investigate" is right for greenfield',
  '\n\n    # Deterministic contract injection',
);

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(env: NodeJS.ProcessEnv, projectRoot: string, storyFiles: string[]): { lines: string; directive: string; contents: string } {
  const storyJson = JSON.stringify({ technicalNotes: { files: storyFiles } });
  const script = `
run_extracted() {
  local PROJECT_ROOT='${projectRoot}'
  # Config accessors added to claude.sh after this harness was written. Unstubbed, the
  # extracted block aborts and every assertion fails during SETUP rather than on what it
  # asserts — the failure reads as a product defect and is a missing stub.
  existing_file_max_lines(){ echo 400; }
  existing_file_injection_enabled(){ return 0; }
  build_project_tools_block(){ echo '[[TOOLS]]'; }
  # Resolves a declared path against the project root; the harness works in absolute paths.
  _resolve_deliverable_path(){ echo "$1"; }
  local story_json='${storyJson}'
${fileLoopBlock}
${directiveBlock}
  echo "===LINES==="
  printf '%b' "$write_first_lines"
  echo "===DIRECTIVE==="
  echo "$write_first_directive"
  echo "===CONTENTS==="
  echo "$existing_file_contents"
}
run_extracted
`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  const [, linesPart, directivePart, contentsPart] = out.split(/===LINES===\n|===DIRECTIVE===\n|===CONTENTS===\n/);
  return { lines: linesPart, directive: directivePart, contents: contentsPart };
}

function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'write-first-test-'));
  cleanupDirs.push(d);
  return d;
}

describe('write-first / read-first directive (real extracted code)', () => {
  it('greenfield (EPAM_BROWNFIELD unset): keeps the original WRITE-first directive, no content injection', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    const env = { ...process.env };
    delete env.EPAM_BROWNFIELD;
    const { lines, directive, contents } = run(env, repo, ['a.ts']);
    expect(lines).toContain(`WRITE ${repo}/a.ts first, before any other action`);
    expect(directive).toContain('WRITE FILES FIRST');
    expect(directive).toContain('Do NOT plan');
    expect(contents.trim()).toBe('');
  });

  it('brownfield: injects the real file content directly instead of telling the agent to ReadFile it', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'export function getGreeting() {\n  return "hello world";\n}\n');
    const { lines, directive, contents } = run({ EPAM_BROWNFIELD: '1' }, repo, ['a.ts']);
    expect(lines).toContain('content already injected below');
    expect(lines).not.toContain('READ');
    expect(directive).toContain('injected below');
    expect(directive).not.toContain('Do NOT plan');
    expect(contents).toContain('getGreeting');
    expect(contents).toContain('hello world');
  });

  it('brownfield directive still forbids unverified imports (the actual AMSD-1820 failure mode)', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    const { directive } = run({ EPAM_BROWNFIELD: '1' }, repo, ['a.ts']);
    expect(directive.toLowerCase()).toMatch(/plausible-sounding module name is not a real one/);
  });

  it('caps injected content at 400 lines with a visible truncation marker for a long file', () => {
    const repo = makeRepo();
    const longFile = Array.from({ length: 900 }, (_, i) => `// line ${i}`).join('\n') + '\n';
    writeFileSync(join(repo, 'big.ts'), longFile);
    const { contents } = run({ EPAM_BROWNFIELD: '1' }, repo, ['big.ts']);
    expect(contents).toContain('// line 0');
    expect(contents).toContain('// line 399');
    expect(contents).not.toContain('// line 400');
    expect(contents).toMatch(/truncated at 400 of 900 lines/);
  });

  it('does not add a truncation marker for a file under the line cap', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'small.ts'), 'export const x = 1;\n');
    const { contents } = run({ EPAM_BROWNFIELD: '1' }, repo, ['small.ts']);
    expect(contents).not.toContain('truncated');
  });

  it('injects content for multiple files, each under its own heading', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
    const { contents } = run({ EPAM_BROWNFIELD: '1' }, repo, ['a.ts', 'b.ts']);
    expect(contents).toContain(`${repo}/a.ts`);
    expect(contents).toContain(`${repo}/b.ts`);
    expect(contents).toContain('export const a = 1;');
    expect(contents).toContain('export const b = 2;');
  });

  it('is deterministic across repeated calls', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    for (let i = 0; i < 5; i++) {
      const { contents } = run({ EPAM_BROWNFIELD: '1' }, repo, ['a.ts']);
      expect(contents).toContain('export const x = 1;');
    }
  });
});
