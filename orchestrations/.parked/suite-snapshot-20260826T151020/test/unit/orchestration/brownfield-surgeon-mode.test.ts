/**
 * Tests for brownfield surgeon mode — four changes that enforce find-first/fix-minimal
 * orientation when EPAM_BROWNFIELD=1, without affecting greenfield flow.
 *
 * Changes tested (source-text assertions, since the functions are internal):
 *   1. claude.sh: brownfield surgeon preamble injected into DYNAMIC_CONSTITUTION
 *   2. spec-mode-runner.js: openspec gets brownfield archaeology block + locationHint schema
 *   3. spec-mode-runner.js: Semble runs a service-boundary query in addition to symptom query
 *   4. spec-mode-runner.js: openspec model selection uses HIGH model when brownfield
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT   = join(__dirname, '../../../');
const CLAUDE_SH   = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');

const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

// THE SURGEON RULES LIVE IN THE CONTRACT CATALOG NOW.
//
// cf3f445 moved them out of claude.sh: "surgeon-mode rules move to the contract catalog, via a
// real renderer". These assertions kept reading claude.sh, so seven of them reported rules that
// had merely MOVED as rules that had vanished — a prompt migration showing up as a pipeline
// defect. The rules are real and still worth asserting, so they are asserted where they live.
const AGENT_CONTRACT = join(REPO_ROOT, 'orchestrations/config/agent-contract.json');
const contractSrc = readFileSync(AGENT_CONTRACT, 'utf8');
const specSrc   = readFileSync(SPEC_RUNNER, 'utf8');
const { buildBrownfieldArchaeologyBlock } = require(SPEC_RUNNER);

// ─── Change 1: claude.sh brownfield surgeon preamble ────────────────────────

describe('claude.sh — brownfield surgeon preamble (Change 1)', () => {
  // THE PREAMBLE MECHANISM MOVED WITH THE RULES.
  //
  // cf3f445 moved surgeon mode into the contract catalog "via a real renderer", so claude.sh no
  // longer builds a DYNAMIC_CONSTITUTION string containing the rules. Asserting that string is
  // asserting the old mechanism; what must hold is that the rules are declared once and that the
  // engine renders the catalog rather than carrying prompt text of its own.
  it('the rules are declared once, in the catalog', () => {
    expect(contractSrc).toMatch(/BROWNFIELD SURGEON MODE/);
  });

  it('the engine renders the catalog rather than embedding the rules', () => {
    expect(claudeSrc, 'the surgeon rules are back inside the engine')
      .not.toMatch(/BROWNFIELD SURGEON MODE/);
    expect(claudeSrc.indexOf('EPAM_BROWNFIELD:-0}" = "1"'),
      'the brownfield guard is gone entirely').toBeGreaterThan(-1);
  });

});

// ─── Change 2: openspec brownfield archaeology block ────────────────────────

describe('spec-mode-runner.js — brownfield archaeology block, REAL behavior via buildBrownfieldArchaeologyBlock (Change 2)', () => {
  // Real bug (2026-07-23, live AMSD-1820 failure): the ORIGINAL version of
  // this describe block asserted the archaeology block was gated on
  // `agent === 'openspec'` — i.e. it tested that the bug's condition existed,
  // via static regex over the source text, and passed happily while the real
  // pipeline shipped a story with zero file guidance because the coordinator
  // assigned only speckit (openspec ran "0 stories" that phase). A source-text
  // "does X exist" assertion cannot catch "X only fires for one of two valid
  // callers" — these tests now call the real, exported, pure function with
  // both agent shapes and assert on its actual return value instead.

  it('fires for EPAM_BROWNFIELD=1 regardless of which agent is running — the exact gap that broke AMSD-1820', () => {
    const openspecResult = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    const speckitResult = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    // buildBrownfieldArchaeologyBlock takes no agent parameter at all — its
    // whole point is that the block no longer depends on which agent calls it.
    expect(openspecResult.archaeologyBlock).not.toBe('');
    expect(speckitResult.archaeologyBlock).not.toBe('');
    expect(openspecResult.archaeologyBlock).toBe(speckitResult.archaeologyBlock);
  });

  it('archaeology block instructs the agent to identify the existing fix site', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/BROWNFIELD MODE/);
    expect(archaeologyBlock).toMatch(/locationHint/);
  });

  it('archaeology block explicitly forbids tool use and requires JSON-only output', () => {
    // GLM-5.1 emitted <search_fi...> XML on the first live run when given
    // "you MUST identify the existing code path" without a no-tools constraint.
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    // SUPERSEDED 2026-08-06. This asserted the block FORBIDS tool use — while specAgentEnv
    // granted read_file/list_files/search with AI_GATE_ALLOW_TOOLS=1. The agent was given
    // tools and told not to use them, so it reasoned about code it could have read, from a
    // prompt that was 92% an undifferentiated CodeGraph dump. The rule that matters is not
    // "do not look", it is "do not invent": looking is allowed, fabricating is not.
    expect(archaeologyBlock).toMatch(/read_file|read the file/i);
    expect(archaeologyBlock, 'the anti-fabrication rule is what must survive').toMatch(/do NOT invent|fabrication/i);
    // Wording changed with the tool policy: the block now opens "answer as JSON" rather than
    // "output JSON only, no tools, no search". The requirement — a JSON answer — is unchanged.
    expect(archaeologyBlock).toMatch(/answer as JSON|JSON only|output JSON/i);
  });

  it('archaeology block constrains locationHint derivation to the Semble context already in the prompt', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/ONLY.*EXISTING CODE|already present in this prompt|Semble/i);
  });

  it('archaeology block instructs model to set locationHint to [] when no Semble context is available', () => {
    const { archaeologyBlock } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(archaeologyBlock).toMatch(/locationHint.*\[\]|\[\].*locationHint/s);
  });

  it('locationHint schema line is added for brownfield regardless of agent', () => {
    const { schemaLine } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(schemaLine).toMatch(/locationHint/);
    expect(schemaLine).not.toBe('');
  });

  it('locationHint includes file, function, and reason fields', () => {
    const { schemaLine } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });
    expect(schemaLine).toMatch(/"file".*"function".*"reason"|locationHint.*file.*function.*reason/s);
  });

  it('archaeology block and schema line are both empty when EPAM_BROWNFIELD is not "1" — greenfield unaffected', () => {
    expect(buildBrownfieldArchaeologyBlock({}).archaeologyBlock).toBe('');
    expect(buildBrownfieldArchaeologyBlock({}).schemaLine).toBe('');
    expect(buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '0' }).archaeologyBlock).toBe('');
    expect(buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: 'true' }).archaeologyBlock).toBe('');
  });

  it('the real prompt-building call site actually uses buildBrownfieldArchaeologyBlock, not a private inline ternary re-implementing the same logic', () => {
    // Guards against a future edit silently reverting to an inline, per-agent
    // condition without touching (or breaking) this test file.
    // The call now passes what the STORY has (hasAcceptanceCriteria / hasReferencedDocs), so
    // the block can name only sources that exist. Still the shared builder, not an inline copy.
    expect(specSrc).toMatch(/buildBrownfieldArchaeologyBlock\(process\.env,\s*\{/);
  });
});

// ─── Change 3: Semble service-boundary query for brownfield ─────────────────

describe('spec-mode-runner.js — Semble service-boundary query (Change 3)', () => {
  it('fetchSembleContext has an isBrownfield branch', () => {
    expect(specSrc).toMatch(/isBrownfield\s*=\s*process\.env\.EPAM_BROWNFIELD\s*===\s*['"]1['"]/);
  });

  it('brownfield path runs a second pathQuery using action verbs targeting the code handler', () => {
    // THE VERBS MOVED TO CONFIG. This asserted the action verbs appeared literally in
    // spec-mode-runner.js. They were an inline string duplicated across two query builders that
    // had already drifted ("processes resolves" vs "processes calculates resolves"), so they were
    // declared once in spec-mode-defaults.json retrieval.queryPrefix and both builders now read
    // it. Asserting the literal in the engine would forbid exactly that fix.
    const retrieval = JSON.parse(
      readFileSync(join(REPO_ROOT, 'orchestrations/config/spec-mode-defaults.json'), 'utf8')).retrieval;
    expect(String(retrieval.queryPrefix)).toMatch(/handles.*applies.*processes|applies.*handles.*processes/);
    // and the engine reads it rather than carrying its own copy
    expect(specSrc).toMatch(/buildRetrievalQuery|retrievalConfig/);
  });

  it('brownfield path deduplicates results by file+line before injecting', () => {
    const sembleIdx = specSrc.indexOf('function fetchSembleContext');
    const sembleFn = specSrc.slice(sembleIdx, sembleIdx + 2000);
    expect(sembleFn).toMatch(/seen\s*=\s*new Set/);
    expect(sembleFn).toMatch(/seen\.has|seen\.add/);
  });

  it('brownfield result block label says "identify the code path" not "write precise ACs"', () => {
    expect(specSrc).toMatch(/identify the code path that handles/);
  });

  it('greenfield path label is unchanged', () => {
    expect(specSrc).toMatch(/use this to write precise, grounded ACs/);
  });

  it('symptomQuery is computed the same way in both greenfield and brownfield paths', () => {
    // The symptom query is still title + ACs; what changed is that the CAP is declared rather
    // than a literal 400, and the cut lands on a word boundary — `.slice(0, 400)` could cut a
    // word in half, and half a word matches nothing, so the search silently narrowed.
    const sembleIdx = specSrc.indexOf('function fetchSembleContext');
    const sembleFn = specSrc.slice(sembleIdx, sembleIdx + 2500);
    expect(sembleFn).toMatch(/symptomQuery\s*=\s*capAtWord\(/);
    expect(sembleFn).toMatch(/story\.title/);
    expect(sembleFn).toMatch(/acceptanceCriteria/);
    // the caps come from the declaration, not from a number written at the call site
    expect(sembleFn).toMatch(/_r\.(symptomQueryChars|acsInSymptomQuery)/);
  });
});

// ─── Change 4: Stronger model for brownfield openspec ───────────────────────

describe('spec-mode-runner.js — stronger model for brownfield openspec (Change 4)', () => {
  it('openspec model selection checks EPAM_BROWNFIELD before choosing base model', () => {
    const openspecModelIdx = specSrc.indexOf('SPEC_MODE_OPENSPEC_MODEL_HIGH');
    expect(openspecModelIdx).toBeGreaterThan(-1);
    // The HIGH model reference must be near a brownfield check
    const region = specSrc.slice(openspecModelIdx - 200, openspecModelIdx + 200);
    expect(region).toMatch(/EPAM_BROWNFIELD/);
  });

  it('when EPAM_BROWNFIELD=1, openspec uses SPEC_MODE_OPENSPEC_MODEL_HIGH as base model', () => {
    // The conditional must prefer _HIGH when brownfield
    const openspecBlock = (() => {
      const idx = specSrc.indexOf("logName.includes('openspec')");
      return specSrc.slice(idx, idx + 400);
    })();
    expect(openspecBlock).toMatch(/EPAM_BROWNFIELD.*SPEC_MODE_OPENSPEC_MODEL_HIGH/s);
  });

  it('when EPAM_BROWNFIELD is not set, openspec falls back to base SPEC_MODE_OPENSPEC_MODEL', () => {
    // The else-branch of the ternary must reference the base model (without _HIGH suffix).
    // Extend the window to 700 chars to cover the full multi-line ternary.
    const openspecBlock = (() => {
      const idx = specSrc.indexOf("logName.includes('openspec')");
      return specSrc.slice(idx, idx + 700);
    })();
    // The ternary's else branch uses SPEC_MODE_OPENSPEC_MODEL (base) as fallback
    expect(openspecBlock).toMatch(/:\s*process\.env\.SPEC_MODE_OPENSPEC_MODEL\s*\|\|/);
  });

  it('speckit model selection is unaffected by EPAM_BROWNFIELD', () => {
    const speckitBlock = (() => {
      const idx = specSrc.indexOf("logName.includes('speckit')");
      return specSrc.slice(idx, idx + 200);
    })();
    expect(speckitBlock).not.toMatch(/EPAM_BROWNFIELD/);
  });
});
