/**
 * A contract violation is not a transient, and must not be retried as one.
 *
 * Live AMSD-2041, 2026-07-28. speckit was asked to review an empty acceptance-
 * criteria list for a novel feature, and was handed four file PATHS with no file
 * CONTENTS. It answered by asking for the files — in a tool-call syntax it
 * invented, because this seam offers it no tools:
 *
 *   # Output
 *   <tool_call>read_file("src/hooks/useContent.ts")<tool_call>read_file("src/services/contentstack.ts")
 *   <tool_call>read_file("src/interface/content/contentCard.ts")<tool_call>read_file("...ContentstackLink.tsx")
 *
 * There was no JSON to parse, so the payload was null and the loop logged
 * "retrying transient failure" — then re-sent the IDENTICAL prompt twice and
 * escalated glm-5.2 → glm-5.1, which did the same thing. Three attempts and a
 * ladder escalation to reproduce a certainty. Identical output at the same
 * offset on two different models is the signature of a contract violation, not
 * a flake.
 *
 * This is the unfixed half of a known defect. On 2026-07-24 (AMSD-1820) glm-5.1
 * wrapped its answer in a `write_file` call; the recovery added then unwraps a
 * tool call that CONTAINS the JSON (spec-mode-runner.js:3724). `read_file` calls
 * contain no JSON to unwrap, so that recovery cannot see this. The note left at
 * the time — "prevention (prompt-forbid) still TODO" — is what this closes.
 *
 * Two things are required and only together do they work:
 *   PREVENTION — the prompt must say the agent has no tools. It told the model
 *                "raw JSON only (no XML tags, no markdown fences, no preamble)"
 *                and said nothing about tool calls.
 *   CLASSIFICATION — when it happens anyway, the retry must TELL the model what
 *                it did wrong instead of asking the same question again. The
 *                "detect, explain, retry" shape already exists in this file for
 *                review rejections; it just never covered this failure class.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(RUNNER);

/** The exact bytes speckit returned on AMSD-2041, from the run log. */
const LIVE_TOOL_CALL_OUTPUT = `
# Output
<tool_call>read_file("src/hooks/useContent.ts")<tool_call>read_file("src/services/contentstack.ts")<tool_call>read_file("src/interface/content/contentCard.ts")<tool_call>read_file("src/components/contentstack/ContentstackLink/ContentstackLink.tsx")`;

describe('classifying why a spec agent produced no payload', () => {
  it('calls the live AMSD-2041 response a contract violation, not a transient', () => {
    expect(mod.classifySpecFailure(LIVE_TOOL_CALL_OUTPUT)).toBe('tool-call');
  });

  it('recognises the other tool-call syntaxes models reach for', () => {
    expect(mod.classifySpecFailure('<tool_use><tool_name>write_file</tool_name></tool_use>')).toBe('tool-call');
    expect(mod.classifySpecFailure('<function_call>{"name":"read_file"}</function_call>')).toBe('tool-call');
  });

  it('calls an empty answer a transient — the one case worth re-asking', () => {
    expect(mod.classifySpecFailure('')).toBe('empty');
    expect(mod.classifySpecFailure('   \n  ')).toBe('empty');
    expect(mod.classifySpecFailure(null)).toBe('empty');
  });

  it('separates prose from malformed JSON', () => {
    // Run 7 died on prose ("It seems t..."); both are deterministic, but the
    // corrective advice differs, so they must not collapse into one bucket.
    expect(mod.classifySpecFailure('It seems the story is missing criteria.')).toBe('prose');
    expect(mod.classifySpecFailure('{"acceptanceCriteria": [,]}')).toBe('malformed-json');
  });

  it('only classifies FAILURES — valid JSON is never a violation', () => {
    // Guards against a classifier that reports a violation for every response.
    expect(mod.classifySpecFailure('{"acceptanceCriteria": ["x"]}')).toBe('malformed-json');
    // (a parseable payload never reaches the classifier; this asserts the
    //  classifier is not consulted as a validity oracle)
    expect(['tool-call', 'prose']).not.toContain(mod.classifySpecFailure('{"a":1}'));
  });
});

describe('the corrective note tells the model what it actually did wrong', () => {
  it('names the tool-call violation and states there are no tools', () => {
    const note = mod.specCorrectiveNote('tool-call');
    expect(note, 'a blind re-ask by another name').toMatch(/tool/i);
    expect(note, 'must state the agent has no tools available').toMatch(/no tools|not have tools|cannot call/i);
  });

  it('tells a prose answer to emit JSON', () => {
    expect(mod.specCorrectiveNote('prose')).toMatch(/JSON/);
  });

  it('returns nothing for a transient — there is nothing to correct', () => {
    // An empty response carries no information about what went wrong; inventing
    // advice would make the next prompt differ for no reason.
    expect(mod.specCorrectiveNote('empty')).toBeFalsy();
  });
});

describe('prevention: the prompt forbids what the model reached for', () => {
  const SRC = readFileSync(RUNNER, 'utf8');

  it('speckit is told it has no tools', () => {
    // Bounded to the speckit review prompt, not the whole file — a match
    // anywhere else would prove nothing about what speckit is sent.
    const i = SRC.indexOf('async function runSpeckitReview');
    const j = SRC.indexOf('async function', i + 10);
    const fn = SRC.slice(i, j > i ? j : undefined);
    // An earlier draft matched /no tools|do not emit.*tool|tool call/i and passed
    // BEFORE the prohibition was written — the words "tool call" already appeared
    // nearby. Assert the prohibition itself, and that it names the syntaxes.
    expect(fn, 'speckit is not told it has no tools — it can invent a tool call again')
      .toMatch(/You have NO tools in this request and cannot call any/);
    expect(fn, 'the prohibition names no concrete syntax, so it is easy to sidestep')
      .toMatch(/<tool_call>[\s\S]{0,80}<function_call>/);
  });
});
