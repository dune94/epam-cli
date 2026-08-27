/**
 * A REVIEWER THAT WAS BUILT, DECLARED, AND NEVER INVOKED.
 *
 * `prompt-review` is a full seam: its own template, a `_what`, three REQUIRED inputs and a
 * declared `produces: prompt-verdict`. The builder calls it behind an optional parameter:
 *
 *     if (typeof reviewPrompt === 'function') { ... }
 *
 * and the only caller in the repo — mint-agents-step.js — passes codelineContext, log,
 * mintedRoles, mode, projectContext, registryFile, runText, templatesDir, projectConfigDir.
 * Not reviewPrompt. So the condition is never true, prompt-verdict is never produced, and the
 * one artefact every downstream agent inherits WHOLE goes in unexamined.
 *
 * The code says this was deliberate — "It is OPTIONAL — a caller that supplies none provisions
 * exactly as before" — an opt-in nobody opted into. What makes it worth fixing is not the choice
 * but the reporting around it: 35 prompts provisioned last run and the log read
 * "REVIEW REJECTED: 0", which is what a reviewer that examined all 35 and approved them says.
 * Same vacuous shape as "0 findings" from an unparseable review, and "environment crash" from a
 * raw file that was never written.
 *
 * So: the run says plainly when prompts went in unreviewed; the registry marks the seam opt-in so
 * it stops looking like seams that always run; and a project can turn it on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const BUILDER = join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js');
const MINT = join(ROOT, 'orchestrations/scripts/mint-agents-step.js');
const REGISTRY = JSON.parse(
  readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProjectPrompts } = require(BUILDER);

describe('a reviewer nobody invoked', () => {
  it('THE REVIEWER RUNS BY DEFAULT — being opt-in is what made it never run', () => {
    const seam = REGISTRY.profiles['prompt-review'];
    expect(seam, 'prompt-review is not in the registry at all').toBeTruthy();
    // THIS ASSERTION WAS INVERTED, AND THE INVERSION WAS THE DEFECT.
    //
    // It demanded `optIn: true`, reasoning that a seam nothing invoked should not read as
    // always-on. That marked the problem instead of fixing it: no project ever set the switch,
    // so the one artefact every downstream agent inherits WHOLE — its prompt — was the only
    // generated thing installed unexamined, for the whole life of the pipeline.
    //
    // Absence of a flag is not a decision to skip a review. A project that wants it off says so
    // with EPAM_PROMPT_REVIEW_ENABLED=0.
    expect(seam.optIn, 'prompt-review is marked opt-in again — it will silently never run')
      .not.toBe(true);
    expect(seam.enabledBy, 'prompt-review is gated behind a switch again').toBeFalsy();
  });

  it('AND ONLY SEAMS THAT ARE ACTUALLY OPTIONAL CARRY THAT MARK', () => {
    // The mark must mean something: a seam the pipeline always runs must not claim to be opt-in.
    for (const always of ['agent-mint', 'roster-review', 'story-writer', 'spec-agent']) {
      expect(REGISTRY.profiles[always]?.optIn,
        `${always} always runs but is marked opt-in`).not.toBe(true);
    }
  });

  it('EVERY OPT-IN SEAM HAS A SWITCH — a mark is not a substitute for a caller', () => {
    // A seam declared opt-in must name the env var that turns it on, and something must read it.
    const optIn = Object.entries(REGISTRY.profiles as Record<string, any>)
      .filter(([, p]) => p.optIn === true);
    // Nothing is opt-in today, which is the DESIRED state — prompt-review being opt-in is
    // exactly what made it never run. The rule below still binds the moment something becomes
    // opt-in again, which is what this test exists for.
    if (!optIn.length) return;
    const src = readFileSync(MINT, 'utf8') + readFileSync(BUILDER, 'utf8');
    for (const [name, p] of optIn) {
      expect(p.enabledBy, `seam '${name}' is opt-in but names no switch`).toBeTruthy();
      expect(src, `nothing reads ${p.enabledBy}, so seam '${name}' can never be turned on`)
        .toContain(p.enabledBy);
    }
  });

  it('SAYS PROMPTS WENT IN UNREVIEWED — rather than reporting nothing at all', async () => {
    const lines: string[] = [];
    // Provision nothing: the point is what the builder REPORTS about review, not what it built.
    await buildProjectPrompts({
      templatesDir: join(ROOT, 'orchestrations/prompts/templates'),
      registryFile: join(ROOT, 'orchestrations/agents/invocation-profiles.json'),
      projectConfigDir: '/nonexistent-project-for-this-test',
      mode: 'copy',
      projectContext: '', codelineContext: '', mintedRoles: '',
      runText: async () => '',
      log: (m: string) => lines.push(m),
    }).catch(() => { /* provisioning may fail; the log line is what is under test */ });
    const joined = lines.join('\n');
    expect(joined, 'the run does not say whether prompts were reviewed')
      .toMatch(/not reviewed|unreviewed|review (is )?(off|disabled|not enabled)/i);
  });

  it('AND SAYS SO ONLY WHEN REVIEW IS ACTUALLY OFF', async () => {
    const lines: string[] = [];
    await buildProjectPrompts({
      templatesDir: join(ROOT, 'orchestrations/prompts/templates'),
      registryFile: join(ROOT, 'orchestrations/agents/invocation-profiles.json'),
      projectConfigDir: '/nonexistent-project-for-this-test',
      mode: 'copy',
      projectContext: '', codelineContext: '', mintedRoles: '',
      runText: async () => '',
      reviewPrompt: async () => ({ ok: true }),
      log: (m: string) => lines.push(m),
    }).catch(() => { /* as above */ });
    expect(lines.join('\n'), 'it reports prompts as unreviewed while a reviewer is supplied')
      .not.toMatch(/not reviewed|unreviewed/i);
  });

  it('THE MINT CAN TURN IT ON — the parameter is reachable from the caller', () => {
    const src = readFileSync(MINT, 'utf8');
    expect(src, 'the only caller still cannot supply a reviewer at all')
      .toMatch(/reviewPrompt/);
  });

  it('SUPPLIES EXACTLY THE PLACEHOLDERS ITS TEMPLATE DECLARES — no more, no fewer', () => {
    // The renderer is strict in BOTH directions: an unknown key throws, and an unreplaced
    // placeholder throws. Either would be swallowed by the reviewer's own catch and the seam
    // would go quiet again — the __MANIFEST_FILE__ failure, one seam over.
    const tpl = JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/prompts/templates/prompt-review.json'), 'utf8'));
    const src = readFileSync(MINT, 'utf8');
    // The values the reviewer supplies, wherever they are built. Located by the injected
    // `values:` factory rather than a variable name, so a refactor moves the test with the code.
    const start = src.indexOf('values: ({ id, template, generated }) => ({');
    expect(start, 'the reviewer no longer builds a values object').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}),', start));
    const supplied = [...block.matchAll(/(__[A-Z0-9_]+__)\s*:/g)].map((m) => m[1]).sort();
    const declared = [...(tpl.placeholders as string[])].sort();
    expect(supplied, 'the reviewer and its template disagree on placeholders').toEqual(declared);
  });
});
