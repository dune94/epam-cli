/**
 * AN AGENT PUBLISHES ITS OUTPUT ONCE. EVERY OTHER AGENT CONSUMES IT BY NAME.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Today SEVEN scripts know the detective's internal data shape and each hand-writes how
 * fixSiteAnalysis becomes prompt text: claude.sh, team-lead-review.sh, spec-mode-runner.js,
 * run-agent-orchestration.sh, contextualize-stories.sh, brownfield-repro-test-writer.sh and
 * detective-rerun-step.js.
 *
 * That is the hardcoding. Not a filename — the COUPLING: every consumer reaches into another
 * agent's data and decides for itself what it means.
 *
 * Proven live 2026-08-13, within hours: deliveryRole was added to the detective's output and
 * wired into ONE renderer (the writer's). The reviewer's copy of the same rendering never got
 * it. Two copies of one thing, drifted immediately, by the person who wrote both.
 *
 * THE RULE:
 *   - the PRODUCER renders its own output — it is the only actor that knows what its fields mean
 *   - the output is published ONCE, carrying provenance
 *   - a consumer DECLARES which kinds it wants and receives them rendered
 *   - no consumer names another agent's fields, ever
 *
 * Provenance travels with the content because the consumer must be able to tell "the plan says"
 * from "the reviewer demands" — today the writer gets sixteen sections of which three separately
 * claim to be the highest priority, and cannot rank them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/agent-io.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run a script against the real lib in a throwaway store. */
function sh(body: string): { out: string; rc: number } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-io-')); dirs.push(dir);
  try {
    const out = execFileSync('bash', ['-c', `set -uo pipefail
      export AGENT_IO_DIR=${JSON.stringify(join(dir, 'io'))}
      . ${JSON.stringify(LIB)}
      ${body}`], { encoding: 'utf8' });
    return { out, rc: 0 };
  } catch (e: any) {
    return { out: (e.stdout || '') + (e.stderr || ''), rc: e.status ?? -1 };
  }
}

describe('the framework exists', () => {
  it('lib/agent-io.sh is present', () => {
    expect(existsSync(LIB),
      'agent outputs are still assembled by each consumer by hand').toBe(true);
  });
});

describe('PUBLISH ONCE, CONSUME BY NAME', () => {
  it('a published output comes back to a consumer that asks for its kind', () => {
    const { out } = sh(`
      publish_agent_output detective prescription S-1 "fix the fetch in pageService"
      collect_agent_inputs S-1 prescription`);
    expect(out, 'a published output did not reach a consumer').toContain('fix the fetch in pageService');
  });

  it('the rendered input carries WHO produced it', () => {
    // The writer receives sixteen sections today and cannot tell a plan from a demand.
    const { out } = sh(`
      publish_agent_output detective prescription S-1 "the plan"
      collect_agent_inputs S-1 prescription`);
    expect(out, 'the consumer cannot tell which agent said this').toMatch(/detective/i);
  });

  it('kinds a consumer did NOT ask for are not delivered', () => {
    const { out } = sh(`
      publish_agent_output detective prescription S-1 "PLAN-TEXT"
      publish_agent_output reviewer review-feedback S-1 "FEEDBACK-TEXT"
      collect_agent_inputs S-1 prescription`);
    expect(out).toContain('PLAN-TEXT');
    expect(out, 'an undeclared input was delivered anyway').not.toContain('FEEDBACK-TEXT');
  });

  it('several kinds arrive in the order the CONSUMER declared', () => {
    // "What the plan says" must precede "what the reviewer objected to"; the order is the
    // consumer's business, not the order things happened to be published in.
    const { out } = sh(`
      publish_agent_output reviewer review-feedback S-1 "SECOND"
      publish_agent_output detective prescription S-1 "FIRST"
      collect_agent_inputs S-1 prescription review-feedback`);
    expect(out.indexOf('FIRST'), 'inputs came back in publication order, not declared order')
      .toBeLessThan(out.indexOf('SECOND'));
  });
});

describe('ABSENT IS ABSENT — NO CONDITIONALS ANYWHERE', () => {
  it('a kind nobody published contributes nothing, and is not an error', () => {
    const r = sh(`collect_agent_inputs S-1 prescription review-feedback; echo "RC=$?"`);
    expect(r.out, 'a missing input produced a heading with nothing under it')
      .not.toMatch(/prescription|review-feedback/i);
    expect(r.out).toContain('RC=0');
  });

  it('publishing EMPTY after real content CLEARS it — the stale-input defect', () => {
    // THE DEFECT THIS WEEK BEGAN WITH: a review written on 2026-08-09 was still being handed to
    // the writer on 2026-08-12 as "your previous attempt", because nothing removed it when the
    // producer had nothing to say. An agent that falls silent must not keep speaking through an
    // old answer. Caught by mutation: deleting the clear left every other assertion green.
    const { out } = sh(`
      publish_agent_output reviewer review-feedback S-1 "OLD-FEEDBACK"
      publish_agent_output reviewer review-feedback S-1 ""
      collect_agent_inputs S-1 review-feedback`);
    expect(out.trim(), 'a superseded input was still delivered after the producer fell silent')
      .toBe('');
  });

  it('two delivered inputs are separated, not run together', () => {
    const { out } = sh(`
      publish_agent_output detective prescription S-1 "AAA"
      publish_agent_output reviewer review-feedback S-1 "BBB"
      collect_agent_inputs S-1 prescription review-feedback`);
    expect(out, 'inputs ran together with no separation').toMatch(/AAA\n\n## review-feedback/);
  });

  it('publishing an EMPTY output is the same as not publishing', () => {
    const { out } = sh(`
      publish_agent_output detective prescription S-1 ""
      collect_agent_inputs S-1 prescription`);
    expect(out.trim(), 'an empty output rendered an empty section').toBe('');
  });
});

describe('ONE STORY DOES NOT SEE ANOTHER STORY', () => {
  it('outputs are scoped to the story that produced them', () => {
    const { out } = sh(`
      publish_agent_output detective prescription S-1 "FOR-S1"
      publish_agent_output detective prescription S-2 "FOR-S2"
      collect_agent_inputs S-2 prescription`);
    expect(out).toContain('FOR-S2');
    expect(out, 'a story received another story input').not.toContain('FOR-S1');
  });
});

describe('THE LATEST OUTPUT WINS', () => {
  it('a re-published kind replaces the previous one', () => {
    // A second attempt supersedes the first. Accumulating them is how a writer ends up acting
    // on a three-day-old review, which is the defect that started this week.
    const { out } = sh(`
      publish_agent_output reviewer review-feedback S-1 "STALE"
      publish_agent_output reviewer review-feedback S-1 "CURRENT"
      collect_agent_inputs S-1 review-feedback`);
    expect(out).toContain('CURRENT');
    expect(out, 'a superseded output was still delivered').not.toContain('STALE');
  });
});

describe('NO CONSUMER NAMES ANOTHER AGENT\'S FIELDS', () => {
  it('the lib itself knows no agent-specific field name', () => {
    // The framework must be generic: it moves opaque text with provenance. The moment it knows
    // what a fix site is, it becomes the eighth place that has to change.
    const src = readFileSync(LIB, 'utf8');
    for (const field of ['fixSiteAnalysis', 'deliveryRole', 'changeRequired', 'verificationCriteria']) {
      expect(src, `agent-io.sh knows about '${field}' — it is not generic`).not.toContain(field);
    }
  });
});

describe('ONE STORE, REACHED FROM BOTH LANGUAGES', () => {
  // Producers live in both: claude.sh and team-lead-review.sh are shell, while the detective's
  // answer is persisted by spec-mode-runner.js. If the shell store and the JavaScript store were
  // two implementations, they would drift — which is the defect this whole framework removes. So
  // the seam is tested from both sides, in both directions.
  const ROOT_DIR = join(__dirname, '../../../');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const io = require(join(ROOT_DIR, 'orchestrations/scripts/lib/agent-io.js'));

  it('what JavaScript publishes, the shell collects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-io-x-')); dirs.push(dir);
    const store = join(dir, 'io');
    io.publish('detective', 'fix-plan', 'S-9', 'PUBLISHED-BY-JS', { AGENT_IO_DIR: store });
    const out = execFileSync('bash', ['-c', `set -uo pipefail
      export AGENT_IO_DIR=${JSON.stringify(store)}
      . ${JSON.stringify(LIB)}
      collect_agent_inputs S-9 fix-plan`], { encoding: 'utf8' });
    expect(out, 'a JavaScript producer published where the shell consumer cannot see it')
      .toContain('PUBLISHED-BY-JS');
    expect(out, 'provenance was lost crossing the language boundary').toContain('detective');
  });

  it('what the shell publishes, JavaScript collects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-io-x-')); dirs.push(dir);
    const store = join(dir, 'io');
    execFileSync('bash', ['-c', `set -uo pipefail
      export AGENT_IO_DIR=${JSON.stringify(store)}
      . ${JSON.stringify(LIB)}
      publish_agent_output reviewer review-feedback S-9 "PUBLISHED-BY-SHELL"`], { encoding: 'utf8' });
    const out = io.collect('S-9', ['review-feedback'], { AGENT_IO_DIR: store });
    expect(out).toContain('PUBLISHED-BY-SHELL');
    expect(out).toContain('reviewer');
  });

  it('content that would break a shell survives the round trip intact', () => {
    // Prompt text is full of quotes and backticks. A producer holds its rendering in a variable
    // and passes "$var" — as every real caller does — and it must arrive as TEXT. This pipeline
    // has executed prompt prose as shell before, which is why the content channel is stdin.
    const dir = mkdtempSync(join(tmpdir(), 'agent-io-x-')); dirs.push(dir);
    const store = join(dir, 'io');
    const nasty = 'a "quoted" thing, `date`, $(whoami), \'single\', and a\nnewline';
    execFileSync('bash', ['-c', `set -uo pipefail
      export AGENT_IO_DIR=${JSON.stringify(store)}
      . ${JSON.stringify(LIB)}
      publish_agent_output detective fix-plan S-9 "$RENDERED"`],
      { encoding: 'utf8', env: { ...process.env, AGENT_IO_DIR: store, RENDERED: nasty } });
    const out = io.collect('S-9', ['fix-plan'], { AGENT_IO_DIR: store });
    expect(out, 'the shell ate or executed part of the content').toContain(nasty);
  });
});
