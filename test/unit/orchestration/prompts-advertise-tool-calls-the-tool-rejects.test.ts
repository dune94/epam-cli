/**
 * A PROMPT DOCUMENTED A TOOL CALL THE TOOL REFUSES, AND THE AGENT OBEYED IT.
 *
 * estate-survey.json told the survey agent to call codegraph_query like a CLI:
 *
 *     codegraph_query explore "<domain nouns from the ticket>"
 *     codegraph_query show "<file> [start] [end]"
 *
 * There is no named `mode` in that syntax, so the model emitted calls with no mode key and the
 * plugin rejected every one: "mode must be one of explore, query, callers, callees, impact,
 * helpers, show."
 *
 * Live 2026-08-17, mock3 run 20260817T153139Z. The agent made 16 calls, all failed, and reported:
 *
 *   state: "failed", filesRead: [], "Attempted 16 codegraph_query calls (explore, query, callers,
 *   callees, show modes) — all failed ... No symbol index data was returned and no files were
 *   opened."
 *
 * Both codelines came back failed, and the investigator briefs degraded from precise findings
 * ("`rider.age > 65` on line 10 should be `>= 65`") to guesses ("Look for symbols related to
 * 'fare', 'age'"). The roster was assembled on no evidence — the exact outcome the survey exists
 * to prevent. The sibling prompt writer-codegraph-block.json had the named form right all along,
 * so this was one prompt out of step with the contract, not a tool defect.
 *
 * THIS TEST IS THE CONTRACT, NOT THE INSTANCE. It reads every prompt that mentions the tool,
 * extracts every call form it advertises, and asserts the real plugin accepts it. A prompt added
 * tomorrow that invents a call shape fails here rather than in a live run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildArgv } = require(join(ROOT, 'orchestrations/plugins/codegraph-plugin.js'));

/** Every template whose body mentions the tool, as {file, body}. */
function promptsMentioning(tool: string) {
  return readdirSync(TEMPLATES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, raw: readFileSync(join(TEMPLATES, f), 'utf8') }))
    .filter((p) => p.raw.includes(tool))
    .map((p) => {
      const j = JSON.parse(p.raw);
      // A prompt body can be a string, or a map of named blocks (writer-codegraph-block).
      const body = typeof j.body === 'string'
        ? j.body
        : Object.values(j.body || {}).filter((v) => typeof v === 'string').join('\n');
      return { file: p.file, body };
    });
}

describe('prompts advertise tool calls the tool rejects', () => {
  const prompts = promptsMentioning('codegraph_query');

  it('finds the prompts that document the tool', () => {
    // Guards against a vacuous pass: if the extraction breaks, every assertion below is trivially
    // true because there is nothing to check.
    expect(prompts.length, 'no prompt mentions codegraph_query — the sweep found nothing to check')
      .toBeGreaterThan(0);
    expect(prompts.map((p) => p.file)).toContain('estate-survey.json');
  });

  it('EVERY advertised call form is accepted by the real plugin', () => {
    const rejected: string[] = [];
    let checked = 0;

    for (const { file, body } of prompts) {
      // codegraph_query(mode="X", a="…", b="…") — take EVERY named field in the call, not just
      // the first. `codeline` is orthogonal to mode (it says which repository to answer from), so
      // a form that leads with it is still valid and the mode's own field appears after it.
      // Asserting on the first field alone read `codeline` as the mode's field and rejected a
      // correct call — the guard caught that within seconds of the prompt changing.
      for (const m of body.matchAll(/codegraph_query\((mode=\\?"\w+\\?"[^)]*)\)/g)) {
        const call = m[1];
        const mode = (call.match(/mode=\\?"(\w+)\\?"/) || [])[1];
        if (!mode) continue;
        const fields = [...call.matchAll(/(\w+)=/g)].map((f) => f[1]).filter((f) => f !== 'mode');
        checked++;
        const input: Record<string, string> = { mode };
        for (const f of fields) input[f] = 'X';
        const r = buildArgv(input);
        if (!r.ok) rejected.push(`${file}: mode="${mode}" ${fields.join(',')} → ${r.error}`);
      }
    }

    expect(checked, 'no call forms were extracted — the regex no longer matches the prompts')
      .toBeGreaterThan(0);
    expect(rejected, `prompts advertise ${rejected.length} call form(s) the tool refuses:\n${rejected.join('\n')}`)
      .toEqual([]);
  });

  it('NO PROMPT ADVERTISES THE POSITIONAL FORM — it has no mode and always fails', () => {
    // The literal defect. `codegraph_query explore "..."` produces a call with no mode key.
    const offenders = prompts
      .filter(({ body }) => /codegraph_query +[a-z|]+ +\\?"/.test(body))
      .map((p) => p.file);
    expect(offenders,
      `these prompts still show a CLI-style call the tool rejects: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('the positional form really is rejected — this is not a style preference', () => {
    // Proves the assertion above is about behaviour, by running what the old prompt produced.
    expect(buildArgv({ args: 'explore fare age' }).ok,
      'the positional form is accepted after all, so the prompt was not the defect').toBe(false);
    expect(buildArgv({ args: 'explore fare age' }).error).toMatch(/mode must be one of/);
    // …and the named form the prompt now shows does work.
    expect(buildArgv({ mode: 'explore', terms: 'fare age' }).ok).toBe(true);
  });

  it('the survey tells the agent what to do when the tool will not work', () => {
    // 16 identical-ish failing calls and then a blind report is the failure that cost the run.
    // The agent must be told to read the error, stop repeating, and fall back to reading files.
    const survey = prompts.find((p) => p.file === 'estate-survey.json')!;
    expect(survey.body, 'nothing tells the agent to stop repeating a failing call')
      .toMatch(/same call again unchanged|identical repeat/i);
    expect(survey.body, 'nothing gives the agent a fallback when the tool fails')
      .toMatch(/read_file/);
  });
});
