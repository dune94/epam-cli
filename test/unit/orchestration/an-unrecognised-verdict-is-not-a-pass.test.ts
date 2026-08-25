/**
 * AN UNRECOGNISED VERDICT IS NOT A PASS.
 *
 * The batched roster review aggregated its batches like this:
 *
 *   verdict: results.some(r => r.part.verdict === 'defects_found') ? 'defects_found' : 'sound'
 *
 * Anything that is not `defects_found` becomes `sound`. The `_unexamined` guard only catches
 * `nothing_to_review` or a falsy verdict, so a value outside the declared enum falls straight
 * through to a clean pass.
 *
 * Live 2026-08-24, replayed from the killed run's own six batch replies: batch2 returned
 * `"verdict": "warn"` — a value the schema does not allow — and batch5 returned no verdict at all.
 * `warn` would have been counted as `sound`.
 *
 * I introduced this while fixing a different fail-open the same morning, which is the whole reason
 * the rule below is written against the TOOL DEFINITION's enum rather than a list in this file: a
 * hand-maintained list of legal verdicts drifts from the schema and reintroduces the hole.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

/** The verdicts the CONTRACT allows — read from the tool definition, never restated here. */
const legalVerdicts = (): string[] => {
  const t = spec.TOOL_ROSTER_REVIEW;
  return (t?.parameters?.properties?.verdict?.enum || []) as string[];
};

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  const agents: Record<string, unknown> = {};
  const canon: Record<string, string> = {};
  for (let i = 0; i < 2; i += 1) {
    canon[`a-${i}`] = `CANON-${i}`;
    agents[`a-${i}`] = { persona: `DERIVED-${i}`, kind: 'seam', ancestor: `a-${i}` };
  }
  const rosterPath = join(dir, 'roster.json');
  const canonicalPath = join(dir, 'canonical.json');
  writeFileSync(rosterPath, JSON.stringify({ agents }));
  writeFileSync(canonicalPath, JSON.stringify(canon));
  return { rosterPath, canonicalPath };
};

/** A real executable — runClaude spawns a process; a stubbed function is never called. */
const answering = (reply: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-stub-'));
  const capture = join(dir, 'p');
  const stub = join(dir, 'stub.sh');
  writeFileSync(stub, ['#!/usr/bin/env bash', `printf x >> "${capture}"`, 'cat > /dev/null',
    "cat <<'JSONEOF'", JSON.stringify(reply), 'JSONEOF', ''].join('\n'), { mode: 0o755 });
  return {
    promptExec: { cmd: stub, args: [] },
    calls: () => (existsSync(capture) ? readFileSync(capture, 'utf8').length : 0),
  };
};

const review = (r: ReturnType<typeof answering>) => {
  const f = fixture();
  return spec.reviewProjectRoster({
    promptExec: r.promptExec, rosterPath: f.rosterPath, canonicalPath: f.canonicalPath,
    codelines: [{ name: 'cl', path: '/tmp/cl' }], logDir: null, repoPath: '', toolGrant: 'read-only',
  });
};

describe('the contract states which verdicts are legal', () => {
  it('the tool definition declares an enum — the premise', () => {
    expect(legalVerdicts().length, 'no enum on the roster-review tool; this suite would prove nothing')
      .toBeGreaterThan(1);
    expect(legalVerdicts()).toContain('sound');
  });
});

describe('a verdict outside the enum never becomes a pass', () => {
  it("refuses 'warn' — the value the killed run actually returned", async () => {
    const r = answering({ verdict: 'warn', findings: [] });
    const out = await review(r);
    expect(r.calls(), 'the reviewer was never invoked').toBeGreaterThan(0);
    expect(out.verdict, "'warn' was aggregated into a passing verdict").not.toBe('approved');
  });

  it('refuses any invented verdict, not just the one we happened to see', async () => {
    const r = answering({ verdict: 'looks-fine-to-me', findings: [] });
    const out = await review(r);
    expect(out.verdict).not.toBe('approved');
  });

  it('says WHY, naming the offending value so it is findable', async () => {
    const r = answering({ verdict: 'warn', findings: [] });
    const out = await review(r);
    expect(String(out.reason || '')).toMatch(/warn/);
  });

  it('still approves a genuinely sound review', async () => {
    const r = answering({ verdict: 'sound', findings: [] });
    const out = await review(r);
    expect(out.verdict, 'a legal sound verdict was refused').toBe('approved');
  });

  it('still reports defects when they are found', async () => {
    const r = answering({
      verdict: 'defects_found',
      findings: [{ agent: 'a-0', severity: 'blocking', claim: 'c', checked: 'k', found: 'f' }],
    });
    const out = await review(r);
    expect(out.verdict).not.toBe('approved');
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it('every legal verdict is handled — none falls through by accident', async () => {
    for (const v of legalVerdicts()) {
      // eslint-disable-next-line no-await-in-loop
      const out = await review(answering({ verdict: v, findings: [] }));
      expect(['approved', 'review_failed', 'changes_requested', 'defects_found'],
        `legal verdict '${v}' produced an unhandled result: ${out.verdict}`).toContain(out.verdict);
    }
  });
});
