/**
 * The spec agent must be able to BUILD its prompt.
 *
 * Live mock1 run 8, 2026-07-27. Step 1 died with:
 *
 *   spec-mode: openspec returned null for MOCK-HW-1 (attempt 2/4) — retrying transient failure
 *   ... x4
 *   spec-mode: FATAL — openspec returned null after 4 attempt(s).
 *
 * Nothing was transient. runSpecAgent interpolates
 * `${publishedContracts(repoPath, story)}` into its prompt — the MC-2 contract
 * injection — and `repoPath` was never bound in that function's scope. Every
 * other use of that name in the module is a local inside a DIFFERENT function,
 * so the reference resolved to nothing and threw ReferenceError while the
 * template literal was being evaluated.
 *
 * That throw happened BEFORE the try block, before runAgentForJson, before any
 * model call. Proof from the live log: `spec-mode: fast-path openrouter/...` printed
 * exactly ONCE — for the coordinator — and never for openspec, and no
 * MOCK-HW-1-openspec-spec.log was written at all. Four "retries" re-ran the same
 * unconditional crash and burned the run.
 *
 * The retry loop reported it as a provider problem because it catches with
 * `catch (err) { agentResult = null; }` — the error object is discarded at both
 * sites. A programming error was laundered into a transient-failure message
 * pointing the operator at SPEC_MODE_* models and RUNCLAUDE_TIMEOUT_MS, none of
 * which had anything to do with it. Retrying a deterministic crash is not
 * resilience; it is four times the delay before the same failure.
 *
 * These tests do not mock the prompt builder. They call the real runSpecAgent
 * with an executable that cannot succeed, so the model layer returns nothing and
 * the function returns null — the ONLY thing under test is that it gets that far
 * on its own feet.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runner = require('../../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const STORY = {
  id: 'MOCK-HW-1',
  title: 'Hello world greeting should say hello dolly',
  description: 'getGreeting() returns the wrong string',
  acceptanceCriteria: [],
  agentRole: 'typescript-engineer',
  agentGroup: 'main',
  dependencies: [],
  technicalNotes: { files: ['src/hello.ts'] },
};

/** An executable that always fails — the model layer must be the thing that
 *  returns nothing, so any throw is the prompt builder's own. */
const DEAD_EXEC = { cmd: '/bin/false', args: [] };

describe('runSpecAgent builds its prompt without crashing', () => {
  it('does not throw a ReferenceError for an unbound identifier', async () => {
    const logDir = tmp('spec-prompt-');
    let err: unknown = null;
    try {
      await runner.runSpecAgent({
        promptExec: DEAD_EXEC, agent: 'openspec', story: STORY,
        phase: 'core', runId: 'test-run', logDir,
      });
    } catch (e) { err = e; }

    // A ReferenceError here means the prompt cannot be assembled at all, so the
    // agent fails 100% of the time and the retry loop reports it as transient.
    expect(err instanceof ReferenceError ? String(err) : null,
      'runSpecAgent throws while building its prompt — every attempt fails ' +
      'identically and the run aborts blaming the provider')
      .toBe(null);
  });

  it('returns null rather than throwing when the model produces nothing', async () => {
    const logDir = tmp('spec-prompt-null-');
    await expect(runner.runSpecAgent({
      promptExec: DEAD_EXEC, agent: 'openspec', story: STORY,
      phase: 'core', runId: 'test-run', logDir,
    })).resolves.toBeNull();
  });

  it('builds the prompt for speckit too', async () => {
    // Same interpolation, same unbound name — speckit was equally broken.
    const logDir = tmp('spec-prompt-speckit-');
    let err: unknown = null;
    try {
      await runner.runSpecAgent({
        promptExec: DEAD_EXEC, agent: 'speckit', story: STORY,
        phase: 'core', runId: 'test-run', logDir,
      });
    } catch (e) { err = e; }
    expect(err instanceof ReferenceError ? String(err) : null).toBe(null);
  });
});

/**
 * The other half: a crash must not be reported as a provider problem.
 *
 * The retry loop caught with `catch (err) { agentResult = null; }` at both
 * sites, discarding the error. A spec agent that crashed and a provider that
 * timed out became the same event, and the operator was pointed at the
 * SPEC_MODE model vars and RUNCLAUDE_TIMEOUT_MS for a ReferenceError.
 */
describe('a crash is not laundered into a transient failure', () => {
  const SRC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('no spec-agent catch discards the error object', () => {
    expect(SRC,
      'a catch block throws the error away, so a crash is indistinguishable ' +
      'from a provider timeout and gets retried as transient')
      .not.toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*agentResult\s*=\s*null;?\s*\}/);
  });

  it('surfaces the error rather than only the null result', () => {
    expect(SRC, 'nothing reports WHY the spec agent produced nothing')
      .toMatch(/_specAgentFailed/);
  });

  it('stops immediately on a programming error instead of retrying it', () => {
    // Four attempts at a deterministic crash is not resilience.
    const i = SRC.indexOf('function _specAgentFailed');
    expect(i, 'no failure classifier exists').toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 1400);
    expect(body, 'a ReferenceError is still treated as retryable')
      .toMatch(/throw err/);
  });

  it('classifies provider failures as retryable', () => {
    // The retry budget must still exist for what it was built for.
    const i = SRC.indexOf('function _specAgentFailed');
    expect(SRC.slice(i, i + 1400),
      'every failure now aborts, so a genuine provider blip kills the run')
      .toMatch(/return null/);
  });
});

describe('publishedContracts tolerates a story with no resolvable repository', () => {
  it('returns a string when the repo path is missing', () => {
    // path.join(null, '.contracts') throws. A story whose codeline cannot be
    // resolved is normal — mocks, greenfield, a lane not yet created — and must
    // not take the whole spec pass down with it.
    for (const p of [null, undefined, '']) {
      expect(typeof runner.publishedContracts(p as any, STORY),
        `publishedContracts threw or returned a non-string for repoPath=${JSON.stringify(p)}`)
        .toBe('string');
    }
  });

  it('returns the contract text when one has been published', () => {
    const repo = tmp('spec-contracts-');
    mkdirSync(join(repo, '.contracts'), { recursive: true });
    writeFileSync(join(repo, '.contracts', `${STORY.id}.md`), '## exported surface\nexport function getGreeting(): string');
    expect(runner.publishedContracts(repo, STORY)).toMatch(/getGreeting/);
  });

  it('returns empty for a repo with no contracts directory', () => {
    expect(runner.publishedContracts(tmp('spec-nocontracts-'), STORY)).toBe('');
  });
});
