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
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { specAgentEnv } = require('../../../orchestrations/scripts/spec-mode-runner.js');
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
 * BOTH HALVES. team-lead-review.sh's own note: "the BLOCK tells the reviewer the tools
 * exist, and the [instruction] makes it use them." Granting tools without requiring their
 * use leaves a reviewer that MAY look — and sometimes will not.
 */
describe('the reviewer is REQUIRED to verify, not merely able to', () => {
  it('the review prompt carries the grounding block', () => {
    expect(
      SRC.includes('${MANIFEST_GROUNDING_BLOCK}'),
      'tools were granted but the prompt never tells the reviewer to use them',
    ).toBe(true);
  });

  it('it requires checking EVERY declared path exists', () => {
    expect(SRC).toMatch(/confirm it EXISTS/);
    expect(SRC).toMatch(/list_files/);
  });

  it('a non-existent path must be reported as a BLOCKER, not quietly fixed', () => {
    expect(SRC).toMatch(/BLOCKER/);
    expect(SRC).toMatch(/Never silently correct a path/);
  });

  it('the instruction names no project, codeline or vendor', () => {
    const i = SRC.indexOf('const MANIFEST_GROUNDING_BLOCK');
    const block = SRC.slice(i, SRC.indexOf('].join', i));
    expect(block).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});
