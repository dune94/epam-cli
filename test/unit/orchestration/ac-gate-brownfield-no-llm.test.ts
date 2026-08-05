/**
 * THE RULE (user, 2026-08-05): if a story HAS acceptance criteria, take it through the
 * openspec/speckit AC processing as designed — brownfield or greenfield, no exception. If
 * it is BROWNFIELD AND HAS NO ACs, skip AC processing entirely: it is wasteful in time and
 * tokens, and there is nothing to process.
 *
 * So the trigger is the ABSENCE OF ACs in brownfield — not brownfield itself.
 *
 * ACs do not apply to brownfield: they stay immutable, and the VCs are derived from the
 * ticket description instead. ingest-jira-tickets.sh says so in its own log line —
 * "brownfield proceeds (ACs stay immutable; VCs derived from the description; the
 * detective decides sufficiency). No human halt."
 *
 * The gate ran anyway, on every brownfield ingest: a planning call plus an answer call per
 * story, to produce a `verdict` that NOTHING enforces (acGateVerdict is written once and
 * read only to print a tally), and — with AC_GATE_AUTO_ELABORATE=1 — a further call that
 * GENERATES acceptance criteria. That elaboration is what produced the 8 fabricated ACs
 * frozen into the metrolinx PRD template for AMSD-1820, a ticket whose Jira record never
 * had any.
 *
 * One output of that same call IS load-bearing: `codeline`, which routes the story to its
 * lane(s). So the fix is not to skip the call — it is to stop doing the ACCEPTANCE-CRITERIA
 * half in brownfield while keeping the routing half.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GATE = join(__dirname, '../../../orchestrations/scripts/lib/ac-gate.js');

/**
 * Run the REAL gate with `epam` replaced by a recorder, so every LLM invocation is
 * counted. A test that merely asserted "no tokens" without executing would prove nothing.
 */
function runGate(env: Record<string, string>, issue: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'acgate-'));
  const issues = join(dir, 'issues.json');
  const out = join(dir, 'gate.json');
  const calls = join(dir, 'llm-calls.txt');
  writeFileSync(issues, JSON.stringify([issue]));

  // Stub `epam` — every invocation appends a line, then returns a valid classification.
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'epam');
  const prompts = join(dir, 'prompts.txt');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(calls)}\n` +
      `cat >> ${JSON.stringify(prompts)}\n` +
      `printf '%s' '{"verdict":"enrichable","reason":"stub","gaps":[],"enrichedAcs":[],"codeline":"both"}'\n`,
  );
  chmodSync(stub, 0o755);

  const r = spawnSync(process.execPath, [GATE, '--issues', issues, '--out', out], {
    encoding: 'utf8',
    timeout: 60000,
    // JIRA_DEFAULT_CODELINE is a LAST-RESORT fallback in the gate. Inheriting it masked a
    // dropped routing decision — the mutation that reproduces the live failure still passed.
    // Cleared so the classifier's own output is what these assertions see.
    env: { ...process.env, JIRA_DEFAULT_CODELINE: '', PATH: `${bin}:${process.env.PATH}`, EPAM_CLI: stub, ...env },
  });
  return {
    status: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    llmCalls: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0,
    prompts: existsSync(prompts) ? readFileSync(prompts, 'utf8') : '',
    result: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
  };
}

/** A brownfield ticket exactly like AMSD-2041: no ACs, one vague sentence. */
const THIN_ISSUE = {
  jiraKey: 'AAA-1',
  title: 'Live Preview of Content in CMS',
  description: 'AS a Content Author, I WANT to preview draft entries, SO THAT I can see how content will be shown.',
  acceptanceCriteria: [],
  // NO codeline field — a Jira issue does not carry one. The gate's classification is what
  // assigns it. My first fixture set it by hand, which hid the fact that skipping the call
  // left the story unroutable: "Codeline 'metrolinx': no stories — skipping".
};

/** A brownfield ticket that DOES carry acceptance criteria — must be processed as designed. */
const ISSUE_WITH_ACS = {
  jiraKey: 'AAA-2',
  title: 'Discount shown on return leg',
  description: 'The confirmation email omits the discount for the return leg.',
  acceptanceCriteria: [
    'The confirmation email shows the discount amount on the return leg line item.',
    'The displayed amount matches the discount applied to the outbound leg.',
    'A booking with no discount shows no discount line on either leg.',
  ],
};

describe('brownfield with NO ACs spends nothing on acceptance criteria', () => {
  it('THE WASTE: the model is never asked to judge acceptance criteria', () => {
    const skipped = runGate({ EPAM_BROWNFIELD: '1', AC_GATE_AUTO_ELABORATE: '1' }, THIN_ISSUE);
    // Call COUNT is the wrong measure: ai-run.sh does a plan+answer pass either way. What
    // matters is what the model is ASKED to do — the tokens are in the prompt.
    expect(
      skipped.prompts,
      `brownfield still sent acceptance-criteria reasoning to the model:\n` +
        skipped.prompts.slice(0, 400),
    ).not.toMatch(/sufficiency gate|acceptance criteria are sufficient|enrichedAcs|gaps/i);
    expect(skipped.prompts, 'the codeline question must still be asked').toMatch(/codeline/i);
  });

  it('greenfield IS asked to judge them — the skip must not leak', () => {
    const g = runGate({ EPAM_BROWNFIELD: '0', AC_GATE_AUTO_ELABORATE: '1' }, THIN_ISSUE);
    expect(g.prompts).toMatch(/sufficiency|acceptance criteria/i);
  });

  it('ROUTING SURVIVES: the story still gets a codeline, so it reaches a lane', () => {
    const r = runGate({ EPAM_BROWNFIELD: '1' }, THIN_ISSUE);
    const story = (r.result || [])[0] || {};
    expect(
      story.codeline,
      'a Jira issue carries no codeline — the gate assigns it. Skipping that left the ' +
        'story unroutable and the live run logged "Codeline: no stories — skipping".',
    ).toBeTruthy();
  });

  it('never fabricates acceptance criteria, even with auto-elaborate on', () => {
    const r = runGate({ EPAM_BROWNFIELD: '1', AC_GATE_AUTO_ELABORATE: '1' }, THIN_ISSUE);
    const story = (r.result || [])[0] || {};
    expect(story.enrichedAcs ?? [], 'brownfield ACs are immutable — nothing may invent them')
      .toEqual([]);
  });

  it('still emits a usable verdict, computed deterministically', () => {
    const r = runGate({ EPAM_BROWNFIELD: '1' }, THIN_ISSUE);
    const story = (r.result || [])[0] || {};
    expect(story.verdict, `no verdict emitted. Output:\n${r.out}`).toBeTruthy();
  });

  it('STILL ROUTES: the codeline survives, because that half IS load-bearing', () => {
    const r = runGate({ EPAM_BROWNFIELD: '1' }, THIN_ISSUE);
    const story = (r.result || [])[0] || {};
    expect(
      story.codeline,
      'codeline assignment drives which lane(s) the story runs on — skipping the whole ' +
        'call to save tokens would break routing',
    ).toBeTruthy();
  });
});

describe('a story WITH ACs is processed as designed — brownfield included', () => {
  it('brownfield + ACs still goes through AC processing', () => {
    const r = runGate({ EPAM_BROWNFIELD: '1' }, ISSUE_WITH_ACS);
    expect(
      r.llmCalls,
      'the rule keys off the ABSENCE of ACs, not the mode. A brownfield story that carries ' +
        'real acceptance criteria has something to process, and skipping it would discard ' +
        'the ticket\'s own contract.',
    ).toBeGreaterThan(0);
  });

  it('greenfield + ACs is processed', () => {
    expect(runGate({ EPAM_BROWNFIELD: '0' }, ISSUE_WITH_ACS).llmCalls).toBeGreaterThan(0);
  });

  it('greenfield with NO ACs is STILL processed — ACs are its contract, so they get built', () => {
    const r = runGate({ EPAM_BROWNFIELD: '0', AC_GATE_AUTO_ELABORATE: '1' }, THIN_ISSUE);
    expect(
      r.llmCalls,
      'greenfield derives its contract FROM the ACs; a greenfield story without them needs ' +
        'the sufficiency judgement and the elaboration. The skip is brownfield-only.',
    ).toBeGreaterThan(0);
  });
});
