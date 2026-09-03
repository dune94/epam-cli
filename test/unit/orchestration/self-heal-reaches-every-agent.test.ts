/**
 * SELF-HEAL IS FOR EVERY AGENT, AND IT IS SENT WHAT ACTUALLY CAME BACK.
 *
 * agent-attempt-analyst.sh is the self-heal for an agent that fails by producing no usable output.
 * Its own header has said "Used by: brownfield-repro-test-writer.sh (now), the code-graph-detective
 * (next)" since the day it was written, and "next" never arrived: ONE seam of forty had self-heal
 * and the other thirty-nine retried blind.
 *
 * Live 2026-08-27, runs 13 and 14: seven prompt generations were refused and retried, the roster
 * specialiser was refused and retried, the detective returned unparseable JSON and retried — and
 * not one of those failures ever reached the analyst. The refusal text went back to the model; no
 * episode was recorded and no constraint was synthesised from what the agent actually produced.
 *
 * The operator's rule: self-heal available to ALL agents after retry, and the previous failure
 * OUTPUT sent to the analyst. No exceptions.
 *
 * These tests cost nothing. The analyst's own contract is that a provider/infra class has no agent
 * behaviour to correct, so it emits nothing and exits 0 WITHOUT calling a model — which is exactly
 * the path that proves the wiring is reachable and the three-valued exit contract is honoured.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selfHeal, classify } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/self-heal.js'));

/** Every JS retry loop in the pipeline, and the file it lives in. */
const RETRY_LOOPS: Array<[string, string]> = [
  ['the shared retry helper', 'orchestrations/scripts/lib/content-retry.js'],
  ['prompt generation', 'orchestrations/scripts/lib/project-prompt-builder.js'],
  ['roster specialisation', 'orchestrations/scripts/lib/project-roster.js'],
  ['the code-graph detective', 'orchestrations/scripts/spec-mode-runner.js'],
];

describe('self-heal reaches every agent that retries', () => {
  it('the analyst exists — otherwise nothing below means anything', () => {
    expect(existsSync(join(REPO_ROOT, 'orchestrations/scripts/agent-attempt-analyst.sh'))).toBe(true);
  });

  for (const [name, file] of RETRY_LOOPS) {
    it(`${name} invokes the analyst on a refused attempt`, () => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(src, `${file} retries without ever reaching self-heal`).toMatch(/self-heal\.js/);
      // AND IT SENDS THE OUTPUT. A reason string says which rule was broken; only the bytes the
      // agent produced say why it broke it. This is the half that was explicitly required.
      expect(src, `${file} calls self-heal without passing the failed output`)
        .toMatch(/selfHeal\(\{[\s\S]{0,400}?output:/);
    });
  }

  it('classifies a failure from what the caller saw, never a guess', () => {
    expect(classify('the response had no JSON at all', 'prose')).toBe('no-json');
    expect(classify('timed out after 300s', 'x')).toBe('provider');
    expect(classify('dropped placeholder(s)', 'text')).toBe('malformed');
    expect(classify('', '')).toBe('no-output');
  });

  it('runs the real analyst and honours its three-valued exit contract', () => {
    // 'provider' is the analyst's declared skip path: no model call, no corrective, exit 0.
    const r = selfHeal({
      agent: 'self-heal-probe', storyId: 'S1',
      reason: 'timed out after 300s', output: 'partial output that failed',
    });
    expect(r.ran, 'the analyst was never invoked').toBe(true);
    expect(r.rc, 'the analyst itself failed (rc=2) — a retry would run with no guidance').not.toBe(2);
  });

  it('never throws, so a broken diagnostic cannot fail the run it diagnoses', () => {
    expect(() => selfHeal({} as any)).not.toThrow();
    expect(() => selfHeal({ output: null, reason: null } as any)).not.toThrow();
  });

  it('writes the FULL text of an object answer, never "[object Object]"', () => {
    // codeline-discovery.js's `call` returns callLlm(...) — an already-parsed object, not a
    // string — and content-retry.js hands that straight to selfHeal as `output`. The analyst
    // reads outFile as ITS ONLY EVIDENCE of what the agent produced; a coercion that discards
    // the object's content leaves it diagnosing a failure it cannot see.
    //
    // selfHeal never returns or cleans up its temp dir, so this reads the real artefact it
    // wrote — the same file agent-attempt-analyst.sh reads — rather than inspecting a mock.
    const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith('self-heal-')));
    selfHeal({
      agent: 'codeline-discovery', storyId: 'S1', reason: 'no tagged JSON',
      output: { codelines: ['apps/web'], note: 'refused: missing blacklist' },
    });
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith('self-heal-'));
    const created = after.filter((d) => !before.has(d))
      .map((d) => join(tmpdir(), d))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    expect(created.length, 'selfHeal never created its temp dir').toBeGreaterThan(0);
    const outFile = join(created[0], 'failed-output.txt');
    expect(existsSync(outFile), 'selfHeal never wrote failed-output.txt').toBe(true);
    const written = readFileSync(outFile, 'utf8');
    expect(written).not.toBe('[object Object]');
    expect(written).toContain('apps/web');
    expect(written).toContain('missing blacklist');
  });
});
