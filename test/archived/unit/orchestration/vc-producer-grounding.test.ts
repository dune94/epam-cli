/**
 * THE VC PRODUCER WAS WRITING OBSERVABLE CRITERIA FOR CODE IT HAD NEVER SEEN.
 *
 * Live run 20260804T162414Z, three lanes, one ticket:
 *
 *   gotransit  resolution=partial       4 VCs  (kept blind first-pass)
 *   upexpress  resolution=regenerated   5 VCs  (detective-grounded)
 *   metrolinx  resolution=partial       1 VC   (kept blind first-pass, 4 of 5 dropped)
 *
 * The ONE lane whose criteria went through regeneration produced the largest, cleanest
 * set and lost nothing. Regeneration is the only VC path that receives the detective's
 * fixSiteAnalysis (regenerateVcViaOpenspec takes `findings`). The first pass does not.
 *
 * Inside runSpecAgent the order was: build prompt -> call the model (first-pass VCs are
 * written HERE) -> runCodeGraphDetective -> enforceVerificationCriteria. A 2026-07-25 fix
 * moved the detective before VC *enforcement*; the producer was never included. Its own
 * comment states the intent — "The detective runs FIRST so its findings can ground VC
 * generation" — and the producer is exactly the stage that missed out.
 *
 * The four criteria metrolinx lost all named mechanisms the producer could only guess at
 * (an SDK, a websocket, a hook's internal function). Asking an agent to describe
 * observable behaviour for a codebase it cannot read, then rejecting it for describing
 * mechanism, is not a model failure — it is a missing input.
 *
 * TWO INPUTS ARE ADDED, both grounded in facts this pipeline already computes:
 *   - the detective's located fix sites, by running it BEFORE the prompt is built
 *   - the CONTENTS of the declared manifest files (we already resolve and stat those exact
 *     paths for manifestEvidence; reading them is the same operation)
 *
 * CONFIGURABLE, never hardcoded — byte budgets are env-tunable and the excerpt block is
 * omitted entirely when the budget is zero. Nothing here names a project or vendor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { manifestFileExcerpts, runSpecAgent } = spec;

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vc-producer-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'useContent.ts'),
    'export function useContent(key: string) {\n  return getContentByKey(key);\n}\n');
  writeFileSync(join(root, 'src', 'big.ts'), 'X'.repeat(50_000));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const prd = () => ({ project: { outputDir: root } });
const story = (files: string[]) => ({
  id: 'ST-1',
  title: 'A capability described in the ticket',
  description: 'the ticket prose',
  technicalNotes: { files },
});

describe('manifestFileExcerpts — the producer can read the files it must reason about', () => {
  it('REPRODUCES THE GAP: the declared file\'s CONTENTS reach the prompt', () => {
    const block = manifestFileExcerpts(story(['src/useContent.ts']), prd());
    expect(
      block,
      'the producer saw file NAMES and a call graph, never the code. Every lane\'s ' +
        'reviewer flagged it: speckit_unread_files_caveat, derived_without_source_inspection.',
    ).toContain('getContentByKey');
    expect(block).toContain('src/useContent.ts');
  });

  /**
   * SUPERSEDED 2026-08-06. Silently skipping an unresolvable path is how an EMPTY
   * DECLARED FILES block went unnoticed for the life of this feature: a prompt with no
   * section reads exactly like a story that declares no files. On the live run the block was
   * absent from both agents' prompts and nothing said so.
   *
   * A path that cannot be read is now named, with an explicit instruction not to reason about
   * it — the agent learns the file was expected and is unavailable, rather than never hearing
   * of it. It is still not fatal, and it still does not throw.
   */
  it('reports a path that does not exist instead of silently dropping it', () => {
    const block = manifestFileExcerpts(story(['src/useContent.ts', 'src/nope.ts']), prd());
    expect(block).toContain('src/useContent.ts');
    expect(block, 'the missing file is invisible, which reads as "not declared"').toContain('src/nope.ts');
    expect(block).toMatch(/could not be read/i);
    expect(block, 'the agent must be told not to reason about it').toMatch(/do not reason about/i);
  });

  it('returns empty for a story with no declared files', () => {
    expect(manifestFileExcerpts(story([]), prd())).toBe('');
  });

  it('caps a single file so one large file cannot swallow the prompt', () => {
    const block = manifestFileExcerpts(story(['src/big.ts']), prd(), { perFileBytes: 500 });
    expect(block.length, 'a 50KB file was inlined whole — that is token bloat').toBeLessThan(2000);
    expect(block, 'a truncated excerpt must SAY it was truncated').toMatch(/truncat/i);
  });

  it('caps the TOTAL, so many files cannot swallow the prompt either', () => {
    const many = Array.from({ length: 40 }, () => 'src/useContent.ts');
    const block = manifestFileExcerpts(story(many), prd(), { totalBytes: 1000 });
    expect(block.length).toBeLessThan(3000);
  });

  it('is CONFIGURABLE from the environment, not the source', () => {
    const small = manifestFileExcerpts(story(['src/big.ts']), prd(),
      {}, { SPEC_FILE_EXCERPT_BYTES: '200' });
    const large = manifestFileExcerpts(story(['src/big.ts']), prd(),
      {}, { SPEC_FILE_EXCERPT_BYTES: '4000' });
    expect(large.length).toBeGreaterThan(small.length);
  });

  it('a ZERO budget disables the block entirely — an explicit off switch', () => {
    expect(manifestFileExcerpts(story(['src/useContent.ts']), prd(),
      {}, { SPEC_FILE_EXCERPT_BYTES: '0' })).toBe('');
  });

  it('names no project, codeline or vendor', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const i = src.indexOf('function manifestFileExcerpts');
    expect(src.slice(i, i + 2500)).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});

/**
 * THE ORDERING, ASSERTED BY EXECUTION. runSpecAgent is run for real with a stubbed model
 * and a stubbed detective, and the prompt it builds is captured. A source-order grep would
 * pass on a call that is dead or unreachable.
 */
describe('the detective runs BEFORE the producer writes its criteria', () => {
  const FINDINGS = [{
    file: 'src/useContent.ts', function: 'useContent',
    reason: 'the single point every content read passes through',
  }];

  /**
   * A REAL stub runner, not a fake function. runAgentForJson spawns execSpec.cmd and pipes
   * the prompt over stdin — and it REPLACES execSpec.args with its own provider flags — so
   * the only faithful way to capture the prompt is a script that ignores its arguments,
   * reads stdin, and answers. This is the stubbed-binary pattern used elsewhere in this
   * directory; it exercises the real spawn path rather than a function I invented.
   */
  async function capturePrompt(opts: Record<string, unknown> = {}) {
    const tag = Math.random().toString(36).slice(2);
    const capture = join(root, `prompt-${tag}.txt`);
    const marker = join(root, `detective-ran-${tag}`);
    const order = join(root, `order-${tag}.txt`);
    const stub = join(root, `stub-${tag}.sh`);
    // ORDER IS OBSERVED, NOT INFERRED. The stub records whether the detective's marker
    // already existed at the moment the model was spawned. An earlier version of this test
    // pushed "model" onto the array AFTER reading the capture file, which made
    // detective-before-model true by construction — a vacuous pass proving nothing.
    writeFileSync(stub,
      '#!/usr/bin/env bash\n' +
      `if [ -f ${JSON.stringify(marker)} ]; then echo DETECTIVE_FIRST > ${JSON.stringify(order)}; ` +
      `else echo MODEL_FIRST > ${JSON.stringify(order)}; fi\n` +
      `cat > ${JSON.stringify(capture)}\n` +
      `echo '<SPEC_AGENT>{"storyId":"ST-1","agent":"openspec"}</SPEC_AGENT>'\n`,
      { mode: 0o755 });

    const calls: string[] = [];
    const runDetective = () => {
      calls.push('detective');
      writeFileSync(marker, 'ran');
      return Promise.resolve(FINDINGS);
    };

    const prevProv = process.env.EPAM_ORCHESTRATION_PROVIDER;
    const prevSpec = process.env.SPEC_MODE_PROVIDER;
    delete process.env.SPEC_MODE_PROVIDER;          // else args/cmd are re-derived
    process.env.EPAM_ORCHESTRATION_PROVIDER = 'stub';
    try {
      await runSpecAgent({
        promptExec: { cmd: stub, args: [] },
        agent: 'openspec',
        story: { ...story(['src/useContent.ts']), codeline: 'x' },
        phase: 'core',
        runId: 'R1',
        logDir: root,
        runDetective,
        prd: prd(),
        ...opts,
      });
    } catch { /* the stub answers minimally; the PROMPT is what is under test */ }
    finally {
      if (prevProv === undefined) delete process.env.EPAM_ORCHESTRATION_PROVIDER;
      else process.env.EPAM_ORCHESTRATION_PROVIDER = prevProv;
      if (prevSpec !== undefined) process.env.SPEC_MODE_PROVIDER = prevSpec;
    }

    let prompt = '';
    try { prompt = readFileSync(capture, 'utf8'); calls.push('model'); } catch { /* never ran */ }
    let observedOrder = '';
    try { observedOrder = readFileSync(order, 'utf8').trim(); } catch { /* model never ran */ }
    return { calls, prompt, observedOrder };
  }

  it('THE LIVE DEFECT: the detective is called before the model, not after', async () => {
    const { calls, observedOrder } = await capturePrompt();
    expect(calls, `call order was ${calls.join(' -> ')}`).toContain('detective');
    expect(calls, 'the model was never spawned, so ordering proves nothing').toContain('model');
    expect(
      observedOrder,
      'the producer wrote its criteria first and the fix site was located afterwards — ' +
        'so the first-pass VCs were never grounded in it. The one lane that reached ' +
        'regeneration (which DOES receive findings) produced 5 clean criteria; the two ' +
        'that kept first-pass output went partial, one down to a single criterion.',
    ).toBe('DETECTIVE_FIRST');
  });

  it('the located fix site appears in the producer\'s prompt', async () => {
    const { prompt } = await capturePrompt();
    // Assert the DISTINCTIVE text only the detective supplies. Checking the file path
    // alone passed even with findings removed, because the declared-file excerpt names
    // the same path — a test that passed for the wrong reason.
    expect(
      prompt,
      'the fix-site reasoning never reached the producer',
    ).toContain('the single point every content read passes through');
    expect(prompt).toMatch(/LOCATED FIX SITE/);
    expect(prompt).toContain('useContent');
  });

  it('the file CONTENTS appear in the producer\'s prompt', async () => {
    const { prompt } = await capturePrompt();
    expect(
      prompt,
      'the producer still cannot see the code it is asked to write observable criteria for',
    ).toContain('getContentByKey');
  });

  it('a detective that finds nothing does not break the prompt', async () => {
    const { prompt } = await capturePrompt({ runDetective: () => Promise.resolve([]) });
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('a detective that THROWS does not fail the spec pass', async () => {
    const { prompt } = await capturePrompt({
      runDetective: () => Promise.reject(new Error('codegraph unavailable')),
    });
    expect(
      prompt.length,
      'grounding is an enhancement — losing it must not take the whole spec pass with it',
    ).toBeGreaterThan(0);
  });
});
