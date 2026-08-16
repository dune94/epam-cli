/**
 * THE MINT LINKS PROMPTS TO THE AGENTS IT MINTED.
 *
 * Provisioning and minting were two things that happened in the same stage and knew nothing
 * about each other. The builder walked a STATIC list in bootstrap.json; the mint separately
 * resolved every minted agent to a seam. Nothing ever asked the question that matters at run
 * time:
 *
 *     this run just minted `mock3-fare-investigator`. It enters at seam `code-graph-detective`.
 *     Does a prompt exist, in THIS project, for that seam?
 *
 * Nobody asked, so the answer was found the expensive way — prompt-library throws at whichever
 * seam needed it, mid-run, after the roster is minted and the run is already spending. The same
 * failure the builder's own header says it exists to prevent, arriving through the one door it
 * did not cover.
 *
 * Operator, 2026-08-16: "this is a pipeline activity then linking the prompts to the new agents
 * and seams."
 *
 * So linking is a step, with an artefact. It is decidable from data — the roster, the registry
 * and the installed library — with no model involved and no tokens spent, which is the same
 * argument validateWorkflow makes for checking the roster can run before running it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { linkPromptsToRoster } = require(join(ROOT, 'orchestrations/scripts/lib/prompt-agent-link.js'));

/** A project whose installed library covers exactly the ids given. */
function project(installed: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-link-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  const templates = join(ROOT, 'orchestrations/prompts/templates');
  for (const id of installed) {
    const doc = JSON.parse(readFileSync(join(templates, `${id}.json`), 'utf8'));
    doc.authority = 'project';
    writeFileSync(join(dir, 'prompts', `${id}.json`), JSON.stringify(doc, null, 2));
  }
  return dir;
}

const link = (dir: string, roster: string[]) =>
  linkPromptsToRoster({ projectConfigDir: dir, registryFile: REGISTRY, agents: roster, env: {} });

describe('the link is derived, not declared', () => {
  it('maps a minted agent through its seam to the prompt that serves it', () => {
    // The whole chain in one assertion: an agent nobody wrote a profile for, resolved by rule to
    // a seam, and that seam's prompt found in THIS project's library.
    const dir = project(['code-graph-detective', 'detective-retry-note']);
    try {
      const out = link(dir, ['mock3-fare-investigator']);
      const entry = out.agents['mock3-fare-investigator'];
      expect(entry.seam, 'the agent did not resolve to the investigation seam').toBe('code-graph-detective');
      expect(entry.prompts, 'the agent resolves to a seam but to no prompt').toContain('code-graph-detective');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('carries every prompt that serves the seam, not just the one named after it', () => {
    // code-graph-detective is served by two: its own instructions and the retry note. A link
    // that returns only the same-named one silently drops the other.
    const dir = project(['code-graph-detective', 'detective-retry-note']);
    try {
      const p = link(dir, ['mock3-fare-investigator']).agents['mock3-fare-investigator'].prompts;
      expect(p).toContain('detective-retry-note');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a gap is a failure, at mint time', () => {
  it('FAILS when a minted agent’s seam has no prompt in this project', () => {
    // The case this step exists for. Provisioned nothing for the investigation seam, minted an
    // investigator: today that is discovered hours later, by a throw at the seam.
    const dir = project(['tc-writer']);
    try {
      expect(() => link(dir, ['mock3-fare-investigator']))
        .toThrow(/mock3-fare-investigator/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('names the seam and the prompt it wanted, not just the agent', () => {
    // An error naming only the agent sends the reader to work out which of 26 seams it entered
    // at and which template that seam declares. The step already knows both.
    const dir = project(['tc-writer']);
    let msg = '';
    try { link(dir, ['mock3-fare-investigator']); } catch (e) { msg = String((e as Error).message); }
    rmSync(dir, { recursive: true, force: true });
    expect(msg).toMatch(/code-graph-detective/);
  });

  it('FAILS when an agent resolves to no seam at all', () => {
    // Nothing to link, and — since the engine declares no default seam — nothing to run either.
    const dir = project(['tc-writer']);
    try {
      expect(() => link(dir, ['kramble-widget-flanger'])).toThrow(/resolves to no seam/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the link is written down', () => {
  it('records the map as an artefact the operator can read and diff', () => {
    // Anything the pipeline derives must be persisted at derivation time. A link held only in
    // memory cannot answer "why did this agent get that prompt" after the run.
    const dir = project(['code-graph-detective', 'detective-retry-note']);
    try {
      link(dir, ['mock3-fare-investigator']);
      const written = JSON.parse(readFileSync(join(dir, 'prompt-agent-link.json'), 'utf8'));
      expect(written.agents['mock3-fare-investigator'].seam).toBe('code-graph-detective');
      expect(written.agents['mock3-fare-investigator'].prompts).toContain('code-graph-detective');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('records which seams the roster actually uses, so unused ones are visible', () => {
    // A roster that reaches four of twenty-six seams is a fact worth seeing: the other
    // twenty-two are configured and idle, and one of them may be the one somebody expected.
    const dir = project(['code-graph-detective', 'detective-retry-note', 'tc-writer']);
    try {
      const out = link(dir, ['mock3-fare-investigator', 'doc-generator']);
      expect(out.seamsInUse).toContain('code-graph-detective');
      expect(out.seamsInUse).toContain('tc-writer');
      expect(out.seamsInUse.length, 'every seam is reported as in use — the roster cannot reach them all')
        .toBeLessThan(26);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
