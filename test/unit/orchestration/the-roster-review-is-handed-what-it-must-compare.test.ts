/**
 * THE ROSTER REVIEW IS HANDED THE TEXT IT MUST COMPARE, IN BATCHES.
 *
 * project-roster-review was given two file paths and told to read both. A canonical roster and
 * its derived copy are ~270KB together — about 74k tokens of tool output before it can form a
 * single judgement. The seam could not perform the comparison it was asked for and answered
 * 'nothing_to_review'; that was translated (correctly) to review_failed, the judge was retried,
 * and every retry met the same wall. Live 2026-08-23, three times.
 *
 * An input that does not fit is not a wording problem. The pairs are built by the caller and
 * reviewed in batches, each batch a whole number of agents — an agent's canonical and derived
 * personas are one unit of meaning and are never split.
 *
 * These assertions drive the real function with a stubbed model, so what is asserted is what the
 * seam is actually handed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));

/** A roster of `n` agents, each persona `size` characters long. */
const fixture = (n: number, size = 500) => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-review-'));
  const agents: Record<string, unknown> = {};
  const canon: Record<string, string> = {};
  for (let i = 0; i < n; i += 1) {
    const name = `agent-${i}`;
    canon[name] = `CANON-${i} `.padEnd(size, 'c');
    agents[name] = { persona: `DERIVED-${i} `.padEnd(size, 'd'), kind: 'seam', ancestor: name };
  }
  const rosterPath = join(dir, 'roster.json');
  const canonicalPath = join(dir, 'canonical.json');
  writeFileSync(rosterPath, JSON.stringify({ agents }));
  writeFileSync(canonicalPath, JSON.stringify(canon));
  return { rosterPath, canonicalPath };
};

/**
 * A REAL STUBBED BINARY, NOT A STUBBED FUNCTION.
 *
 * runClaude spawns execSpec.cmd and writes the prompt to its stdin, so a fake `promptExec`
 * function is never called and proves nothing about what the seam is handed. This is a genuine
 * executable that records each prompt it receives and answers with the verdict the test chose —
 * the same shape the pipeline really runs through.
 */
const recorder = (reply: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-stub-'));
  const capture = join(dir, 'prompts');
  const stub = join(dir, 'stub.sh');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '<<<PROMPT>>>' >> "${capture}"`,
    `cat >> "${capture}"`,
    `cat <<'JSONEOF'`,
    JSON.stringify(reply),
    'JSONEOF',
    '',
  ].join('\n'), { mode: 0o755 });
  const promptExec = { cmd: stub, args: [] };
  const prompts = (): string[] => {
    if (!existsSync(capture)) return [];
    return readFileSync(capture, 'utf8').split('<<<PROMPT>>>').filter((x) => x.trim());
  };
  return { prompts, promptExec };
};

const review = (f: ReturnType<typeof fixture>, promptExec: unknown) => spec.reviewProjectRoster({
  promptExec, rosterPath: f.rosterPath, canonicalPath: f.canonicalPath,
  codelines: [{ name: 'cl', path: '/tmp/cl' }], logDir: null, repoPath: '', toolGrant: 'read-only',
});

describe('the personas reach the prompt', () => {
  it('puts BOTH texts in front of the reviewer, not just paths', async () => {
    const f = fixture(2);
    const r = recorder({ verdict: 'sound', findings: [] });
    await review(f, r.promptExec);
    const all = r.prompts().join('\n');
    expect(r.prompts().length, 'the reviewer was never invoked').toBeGreaterThan(0);
    expect(all, 'the canonical text never reached the prompt').toMatch(/CANON-0/);
    expect(all, 'the derived text never reached the prompt').toMatch(/DERIVED-0/);
    expect(all).toMatch(/AGENT: agent-0/);
  });

  it('splits a large roster into several batches', async () => {
    // 40 agents x ~1000 chars of pairs exceeds one batch, so more than one pass must happen.
    const f = fixture(40, 1000);
    const r = recorder({ verdict: 'sound', findings: [] });
    await review(f, r.promptExec);
    expect(r.prompts().length, 'a roster far over the batch budget was sent as one prompt')
      .toBeGreaterThan(1);
  });

  it('covers EVERY agent across the batches — none is silently dropped', async () => {
    const f = fixture(40, 1000);
    const r = recorder({ verdict: 'sound', findings: [] });
    await review(f, r.promptExec);
    const all = r.prompts().join('\n');
    for (let i = 0; i < 40; i += 1) {
      expect(all, `agent-${i} was never put in front of the reviewer`).toContain(`AGENT: agent-${i}`);
    }
  });

  it('never splits one agent across two batches', async () => {
    const f = fixture(40, 1000);
    const r = recorder({ verdict: 'sound', findings: [] });
    await review(f, r.promptExec);
    for (const p of r.prompts()) {
      const heads = (p.match(/--- AGENT: (agent-\d+)/g) || []);
      for (const h of heads) {
        const name = h.replace('--- AGENT: ', '');
        expect(p, `${name} appears without its derived text`).toContain(`DERIVED-${name.split('-')[1]}`);
      }
    }
  });
});

describe('a batch that did not look does not pass for the rest', () => {
  it('reports review_failed when any batch answers nothing_to_review', async () => {
    const f = fixture(2);
    const r = recorder({ verdict: 'nothing_to_review', findings: [] });
    const out = await review(f, r.promptExec);
    expect(out.verdict, "'nothing_to_review' was reported as a real review").toBe('review_failed');
    expect(out.reason, 'the caller cannot tell the roster was not implicated')
      .toMatch(/not implicated/i);
  });

  it('an examined-and-sound roster is approved', async () => {
    const f = fixture(2);
    const r = recorder({ verdict: 'sound', findings: [] });
    const out = await review(f, r.promptExec);
    expect(out.verdict).toBe('approved');
  });

  it('findings from a batch survive into the verdict', async () => {
    const f = fixture(2);
    const r = recorder({
      verdict: 'defects_found',
      findings: [{ agent: 'agent-0', severity: 'blocking', claim: 'c', checked: 'k', found: 'f' }],
    });
    const out = await review(f, r.promptExec);
    expect(out.verdict).not.toBe('approved');
    expect(out.findings.length, 'a blocking finding was dropped').toBeGreaterThan(0);
  });


  it('refuses defects_found with an EMPTY finding list — a condemnation naming nothing', async () => {
    // Live 2026-08-23: {"findings": [], "verdict": "defects_found"}. Read as a rejection, it
    // deletes a roster that passed its mechanical contract and pays to regenerate it, with no
    // evidence anyone can act on. The judge failed to substantiate; the artefact is not implicated.
    const f = fixture(2);
    const r = recorder({ verdict: 'defects_found', findings: [] });
    const out = await review(f, r.promptExec);
    expect(out.verdict, 'an evidence-free condemnation was blamed on the roster')
      .toBe('review_failed');
    expect(out.reason).toMatch(/not implicated/i);
  });
  it('an unreadable roster is a failed review, not a sound one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-empty-'));
    const rosterPath = join(dir, 'roster.json');
    writeFileSync(rosterPath, JSON.stringify({ agents: {} }));
    const out = await spec.reviewProjectRoster({
      promptExec: recorder({ verdict: 'sound', findings: [] }).promptExec,
      rosterPath, canonicalPath: rosterPath, codelines: [], logDir: null, repoPath: '',
      toolGrant: 'read-only',
    });
    expect(out.verdict, 'an empty roster was approved').toBe('review_failed');
  });
});
