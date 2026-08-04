/**
 * A reviewer must be able to see what it is reviewing.
 *
 * The spec pass runs openspec → speckit → coordinator. Between them they decide the
 * manifest — which files a story will touch — and then review it. None of them has ever
 * had filesystem access. They review a list of paths having never seen the repository,
 * so a manifest naming a file that does not exist reads, to them, as a perfectly
 * reasonable path. They cannot disagree; they can only agree.
 *
 * That is how a wrong-cased path reached the writer on 2026-08-04 and cost a
 * ~2M-input-token non-converging loop. No reviewer missed it — no reviewer was ever
 * able to look.
 *
 * The precedent already exists in this repo and is the user's own: gate agents and the
 * detective get tools via ORCH_GATE_ALLOWED_TOOLS / CODEGRAPH_DETECTIVE_ALLOWED_TOOLS,
 * and team-lead-review.sh both TELLS the reviewer the tools exist and REQUIRES their use
 * before it may claim something is missing — "Both halves are required".
 *
 * READ-ONLY BY DESIGN. A spec reviewer needs to answer "does this path exist, and is it
 * the right file" — that needs reading, not shell. Withholding bash keeps a review pass
 * from mutating the repository it is reviewing.
 *
 * CONFIGURABLE, NOT HARDCODED: SPEC_MODE_ALLOWED_TOOLS overrides the default, so a
 * project needing something else changes config, not this engine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { specAgentEnv, manifestEvidence } = require('../../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

describe('spec-pass agents can see the repository', () => {
  it('REPRODUCES THE GAP: the env grants filesystem tools at all', () => {
    const env = specAgentEnv({});
    expect(
      env.EPAM_ALLOWED_TOOLS,
      'spec reviewers run with no tools, so they review a manifest of paths having never ' +
        'seen the repository — they cannot verify a path exists, only agree that it looks fine',
    ).toBeTruthy();
  });

  it('grants READ access', () => {
    const tools = specAgentEnv({}).EPAM_ALLOWED_TOOLS.split(',');
    expect(tools).toContain('read_file');
    expect(tools).toContain('list_files');
  });

  it('does NOT grant bash — a review pass must not mutate what it reviews', () => {
    expect(
      specAgentEnv({}).EPAM_ALLOWED_TOOLS.split(','),
      'a spec reviewer needs to read, not to run commands',
    ).not.toContain('bash');
  });

  it('does not grant write or edit', () => {
    const tools = specAgentEnv({}).EPAM_ALLOWED_TOOLS;
    expect(tools).not.toMatch(/write_file|edit_file/);
  });

  it('is CONFIGURABLE — a project can override without touching the engine', () => {
    const env = specAgentEnv({ SPEC_MODE_ALLOWED_TOOLS: 'read_file,codegraph_query' });
    expect(env.EPAM_ALLOWED_TOOLS).toBe('read_file,codegraph_query');
  });

  it('still carries the existing max-output-tokens setting when set', () => {
    expect(specAgentEnv({ SPEC_MODE_MAX_OUTPUT_TOKENS: '4096' }).EPAM_MAX_OUTPUT_TOKENS).toBe('4096');
  });

  it('omits max-output-tokens when unset — existing behaviour unchanged', () => {
    expect(specAgentEnv({}).EPAM_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it('names no project, codeline or vendor', () => {
    expect(JSON.stringify(specAgentEnv({}))).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});

/**
 * GRANTING TOOLS WAS NOT ENOUGH — AND THE LIVE CALL PROVED IT.
 *
 * The env above really does grant read_file/list_files, and the prompt really did require
 * their use. Live (test/integration/spec-reviewer-live.test.ts, first run) the reviewer
 * answered with 87 bytes:
 *
 *     <tool_call>list_files path="."</arg_value><tool_call>list_files path="src"</arg_value>
 *
 * No <SPEC_REVIEW> at all. ai-run.sh is a single-shot text call with NO tool-execution
 * loop: nothing runs a tool the model asks for, so requiring verification-before-verdict
 * asked for a turn that never comes. The grant set an env var; it did not put the reviewer
 * on a tool-executing path.
 *
 * So the path facts are gathered DETERMINISTICALLY by manifestEvidence() and handed to the
 * reviewer in its prompt. fs.existsSync cannot hallucinate, costs no tokens, and cannot
 * stall. The reviewer then judges what evidence cannot: testability and plausibility.
 * (The tool grant stays — the detective and other spec agents run on paths that do execute
 * tools, and read-only access is correct for them.)
 *
 * These tests EXECUTE manifestEvidence against real files on disk, rather than asserting
 * the instruction text exists. A source-grep would pass on a comment or a dead branch.
 */
describe('manifestEvidence — the path facts are gathered, not asked for', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-evidence-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'RealFile.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'src', 'other.tsx'), 'export const y = 2;\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const prd = () => ({ project: { outputDir: dir } });
  const story = (files: string[]) => [{ id: 'ST-1', technicalNotes: { files } }];

  it('reports a path that EXISTS', () => {
    const out = manifestEvidence(story(['src/RealFile.ts']), prd());
    expect(out).toMatch(/ST-1: EXISTS\s+src\/RealFile\.ts/);
  });

  it('reports a path that does NOT exist as MISSING', () => {
    const out = manifestEvidence(story(['src/nope-not-here.ts']), prd());
    expect(out).toMatch(/ST-1: MISSING/);
    expect(out).toContain('src/nope-not-here.ts');
  });

  it('THE ~2M-TOKEN CASE: a wrong-cased path names the real neighbour on disk', () => {
    const out = manifestEvidence(story(['src/realfile.ts']), prd());
    expect(
      out,
      'a bare "MISSING" is not actionable — naming the file that IS there is what lets ' +
        'the reviewer report something a human can act on',
    ).toContain('RealFile.ts');
    expect(out).toMatch(/MISSING/);
  });

  it('a wrong EXTENSION also names the real neighbour', () => {
    const out = manifestEvidence(story(['src/other.ts']), prd());
    expect(out).toContain('other.tsx');
  });

  it('a story declaring NO files is reported — silence is not evidence', () => {
    const out = manifestEvidence(story([]), prd());
    expect(out).toMatch(/NO FILES DECLARED/);
  });

  it('an unreadable directory degrades to MISSING instead of throwing', () => {
    const out = manifestEvidence(story(['no/such/dir/file.ts']), prd());
    expect(out).toMatch(/MISSING/);
  });

  it('evidence is gathered against the LANE\'s outputDir, not the engine repo', () => {
    // package.json exists in the engine repo but not in this fixture: if the resolver
    // ignored outputDir, this would wrongly read EXISTS.
    const out = manifestEvidence(story(['package.json']), prd());
    expect(out).toMatch(/MISSING/);
  });
});

describe('the reviewer is told to answer now, with the evidence it was given', () => {
  const block = SRC.slice(
    SRC.indexOf('const MANIFEST_GROUNDING_BLOCK'),
    SRC.indexOf('].join', SRC.indexOf('const MANIFEST_GROUNDING_BLOCK')),
  );

  it('the review prompt carries the grounding block', () => {
    expect(SRC.includes('${MANIFEST_GROUNDING_BLOCK}')).toBe(true);
  });

  it('the review prompt carries the gathered EVIDENCE, not just the instruction', () => {
    expect(
      SRC,
      'the instruction refers to evidence "above" — if the evidence is never injected, ' +
        'the reviewer is told to rely on something that is not there',
    ).toMatch(/MANIFEST EVIDENCE[\s\S]{0,200}manifestEvidence\(/);
  });

  it('it forbids deferring the verdict — the exact live failure', () => {
    expect(block).toMatch(/ANSWER IN THIS RESPONSE/);
    expect(block).toMatch(/no later turn|NO tools/i);
  });

  it('it does NOT ask for tool calls, which nothing would execute', () => {
    expect(
      block,
      'asking a single-shot call to run list_files produced 87 bytes of tool calls and no verdict',
    ).not.toMatch(/use (your )?(read-only )?tools|call list_files|search the repository/i);
  });

  it('a missing path must be reported, not quietly fixed', () => {
    expect(block).toMatch(/needs_review/);
    expect(block).toMatch(/missing_manifest_path/);
    expect(block).toMatch(/Never silently correct a path/);
  });

  it('the instruction names no project, codeline or vendor', () => {
    expect(block).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});
