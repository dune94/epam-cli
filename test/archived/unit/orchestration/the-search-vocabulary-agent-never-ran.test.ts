/**
 * THE SEARCH-TERM VOCABULARY AGENT NEVER RAN — ON ANY STORY, IN ANY RUN.
 *
 * runCodeGraphDetective derives a search vocabulary before seeding the detective's first
 * `explore`, so a rare-but-meaningless token cannot be amplified by IDF into a top
 * discriminator. It asked for that vocabulary like this:
 *
 *     _searchVocab = await deriveGuardVocabulary({ promptExec: opts.promptExec || null, ... })
 *
 * No caller has ever supplied opts.promptExec. The only in-repo call site passes
 * `correctiveContext` alone, and detective-rerun-step.js defaults it to `undefined`. So the
 * expression is always `null`, runAgentForJson dereferences `execSpec.cmd` on it, the TypeError
 * is swallowed by the call site's catch, and the run continues with:
 *
 *     spec-mode: search-term vocabulary unavailable for MOCK3-1 (...) — seeding with an
 *     unfiltered query
 *
 * A degradation that reads as a considered fallback. It was never a fallback: the agent had no
 * chance to run, and the "best-effort at THIS seam only" note above it describes a best effort
 * that was never made.
 *
 * THE FIX IS A DEFAULT, NOT A THREADED ARGUMENT. run() already resolves the exec at line 1382
 * from AI_RUNNER_CMD; the detective can resolve the same one from the same function instead of
 * inventing `null`. Threading it through every call site would leave the next caller free to
 * omit it again — the defect is that omission had a silent, wrong default.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A SEAM PROMPT RENDERS FROM THIS PROJECT'S COPY. The template is never executed directly for an
// agent, so a render with no project declared correctly refuses — and this suite renders exactly
// such prompts. metrolinx is used because its copies exist; nothing here writes to it.
process.env.EPAM_PROJECT_CONFIG_DIR = process.env.EPAM_PROJECT_CONFIG_DIR
  || join(__dirname, '..', '..', '..', 'orchestrations', 'projects', 'metrolinx');

const runner = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));

describe('the search-term vocabulary agent never ran', () => {
  it('OMITTING promptExec YIELDS A REAL EXEC — the default is the runner, not null', () => {
    const exec = runner.promptExecFor({}, { AI_RUNNER_CMD: '/somewhere/ai-run.sh', AI_PROVIDER: 'openrouter' });
    expect(exec, 'omitting promptExec still resolves to nothing to invoke').toBeTruthy();
    expect(exec.cmd, 'the resolved exec has no command to run').toBe('/somewhere/ai-run.sh');
    expect(Array.isArray(exec.args), 'the resolved exec carries no argv').toBe(true);
  });

  it('falls back to the shipped ai-run.sh when the env names none', () => {
    const exec = runner.promptExecFor({}, { AI_PROVIDER: 'openrouter' });
    expect(exec.cmd, 'no runner resolved from a bare environment').toMatch(/ai-run\.sh$/);
  });

  it('an explicitly supplied exec still wins — the default never overrides a caller', () => {
    const mine = { cmd: '/my/runner', args: ['--provider', 'x'] };
    expect(runner.promptExecFor({ promptExec: mine }, {})).toBe(mine);  // no provider needed: never resolved
  });

  it('RESOLVES TO THE SAME THING run() USES — one definition, not a second copy', () => {
    const env = { AI_RUNNER_CMD: '/somewhere/ai-run.sh', AI_MODEL: 'some-model', AI_PROVIDER: 'openrouter' };
    expect(runner.promptExecFor({}, env)).toEqual(runner.resolvePromptExec('/somewhere/ai-run.sh', env));
  });

  it('THE AGENT ACTUALLY RUNS WHEN NO EXEC IS SUPPLIED — the receiver, not the helper', async () => {
    // Stubbed binary, real execution: the runner is a script that records the agent name it was
    // invoked as and fails, so this asserts the INVOCATION happened without calling a model.
    const dir = mkdtempSync(join(tmpdir(), 'vocab-exec-'));
    const stub = join(dir, 'stub-ai-run.sh');
    const seen = join(dir, 'invoked.log');
    writeFileSync(stub, '#!/usr/bin/env bash\necho "$EPAM_AGENT_NAME" >> "$STUB_LOG"\nexit 1\n');
    chmodSync(stub, 0o755);

    const saved = { ...process.env };
    Object.assign(process.env, { AI_PROVIDER: 'openrouter', AI_RUNNER_CMD: stub, STUB_LOG: seen });
    try {
      await runner.deriveGuardVocabulary({
        // promptExec deliberately ABSENT — exactly what runCodeGraphDetective does.
        rule: 'any rule',
        statements: ['a statement with content'],
        story: { id: 'T-1' },
        findings: [], manifestFiles: [], logDir: '', seam: 'search-query', repoPath: '',
      }).catch(() => null);  // the stub exits 1; reaching it is the point
    } finally {
      for (const k of ['AI_PROVIDER', 'AI_RUNNER_CMD', 'STUB_LOG']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }

    const invoked = existsSync(seen) ? readFileSync(seen, 'utf8') : '';
    expect(invoked, 'the vocabulary agent was never invoked — the run degraded silently')
      .toMatch(/guard-vocabulary/);
  });

  it('an explicit null is an omission too — the shape the detective actually passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-exec-null-'));
    const stub = join(dir, 'stub-ai-run.sh');
    const seen = join(dir, 'invoked.log');
    writeFileSync(stub, '#!/usr/bin/env bash\necho "$EPAM_AGENT_NAME" >> "$STUB_LOG"\nexit 1\n');
    chmodSync(stub, 0o755);

    const saved = { ...process.env };
    Object.assign(process.env, { AI_PROVIDER: 'openrouter', AI_RUNNER_CMD: stub, STUB_LOG: seen });
    try {
      await runner.deriveGuardVocabulary({
        promptExec: null,
        rule: 'any rule',
        statements: ['a statement with content'],
        story: { id: 'T-1' },
        findings: [], manifestFiles: [], logDir: '', seam: 'search-query', repoPath: '',
      }).catch(() => null);
    } finally {
      for (const k of ['AI_PROVIDER', 'AI_RUNNER_CMD', 'STUB_LOG']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }

    expect(existsSync(seen) ? readFileSync(seen, 'utf8') : '',
      'a null exec still skips the agent').toMatch(/guard-vocabulary/);
  });

  it('AN UNUSABLE VOCABULARY LEAVES ITS EVIDENCE — the answer is not discarded', async () => {
    // The agent answers, the answer parses, and the vocabulary is still unusable. That used to
    // become a bare `null`: the caller logged "no usable terms" and the payload that said WHY was
    // gone. Here the answer is well-formed and its blacklist is empty — the diagnosis is the file.
    const dir = mkdtempSync(join(tmpdir(), 'vocab-unusable-'));
    const stub = join(dir, 'stub-ai-run.sh');
    const logDir = join(dir, 'logs');
    mkdirSync(logDir);
    writeFileSync(stub,
      '#!/usr/bin/env bash\n'
      + "echo '<GUARD_VOCABULARY>{\"blacklist\":[],\"whitelist\":[]}</GUARD_VOCABULARY>'\n"
      + 'exit 0\n');
    chmodSync(stub, 0o755);

    const saved = { ...process.env };
    Object.assign(process.env, { AI_PROVIDER: 'openrouter', AI_RUNNER_CMD: stub });
    let result: unknown = 'unset';
    try {
      result = await runner.deriveGuardVocabulary({
        rule: 'a rule', statements: ['a statement with content'],
        story: { id: 'T-1' }, findings: [], manifestFiles: [],
        logDir, seam: 'search-query', repoPath: '',
      });
    } finally {
      for (const k of ['AI_PROVIDER', 'AI_RUNNER_CMD']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }

    expect(result, 'an unusable vocabulary must not be handed to a guard').toBeNull();
    const dump = join(logDir, 'vocabulary-unusable-T-1-search-query.json');
    expect(existsSync(dump), 'the unusable answer was discarded — nothing to diagnose from').toBe(true);
    const evidence = JSON.parse(readFileSync(dump, 'utf8'));
    expect(evidence.payload, 'the dump does not carry the answer itself').toBeTruthy();
    expect(evidence.payload.blacklist, 'the dump cannot show why it was unusable').toEqual([]);
    expect(evidence.statements, 'the dump does not say what was being judged')
      .toEqual(['a statement with content']);
  });
});
