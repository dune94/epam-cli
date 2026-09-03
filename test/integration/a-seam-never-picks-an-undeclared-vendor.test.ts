/**
 * A SEAM NEVER PICKS A VENDOR THE ACTIVE STACK DOES NOT DECLARE.
 *
 * ac-gate.js resolved its provider like this:
 *
 *     getArg('--provider', ORCH_GATE_PROVIDER || EPAM_ORCHESTRATION_PROVIDER || 'openrouter')
 *
 * A hardcoded vendor as the last resort. It fires under exactly the condition that produced the
 * discovery defect — the project env failing to reach the child — but where discovery DIED, this
 * one succeeds against the wrong vendor. On a run launched as `claude`, that is real spend on a
 * stack the operator did not choose, with nothing in the log saying so.
 *
 * The correct last resort is the ACTIVE SET's own provider, which llm-handler.sh already resolves
 * when it is not told one. A seam that cannot resolve a provider must defer to the set, never
 * name a vendor of its own.
 *
 * Asserted at the receiver: ac-gate is run for real with the runner stubbed underneath, and the
 * assertion reads the argument vector the runner was handed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LADDERS } from '../helpers/seam-receiver';

const REPO = join(__dirname, '../..');
const AC_GATE = join(REPO, 'orchestrations/scripts/lib/ac-gate.js');

/** Vendors any declared set can route to — read from the sets, never listed here. */
function declaredProviders(): Set<string> {
  const out = new Set<string>();
  const src = readFileSync(join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
  for (const m of src.matchAll(/^\s{4,}([a-z][a-z0-9-]*)\)\s+CLAUDE_SH=/gm)) out.add(m[1]);
  return out;
}

/** Run ac-gate with the runner stubbed, and report what the runner was given. */
function runAcGate(env: Record<string, string>) {
  const work = mkdtempSync(join(tmpdir(), 'ac-gate-receiver-'));
  const argvLog = join(work, 'argv.log');
  const stub = join(work, 'stub-run.sh');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf -- '--CALL--\\n' >> ${JSON.stringify(argvLog)}`,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done`,
    'cat > /dev/null',
    `printf '%s' '{"classifications":[]}'`,
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);

  const issues = join(work, 'issues.json');
  // The shape ac-gate reads: it renders __STORY_KEY__ and __STORY_TITLE__ from jiraKey/title, and
  // the prompt refuses to render without them — which is correct, and is why a Jira-shaped fixture
  // never reached the runner.
  // The shape ac-gate reads. It renders __STORY_KEY__/__STORY_TITLE__ from jiraKey/title, and
  // derives __CODELINE_LIST__, __CODELINE_BULLETS__, __SPLIT_AC_LINES__ and __SCHEMA_AC_FIELDS__
  // from the codelines the stories declare — so a story with none makes the prompt refuse to
  // render, correctly, and the runner is never reached.
  writeFileSync(issues, JSON.stringify([{
    jiraKey: 'AB-1',
    title: 'Email confirm case sensitivity',
    description: 'the confirm email field is case sensitive',
    codelines: ['alphashop', 'betashop'],
    acceptanceCriteria: ['The confirm email field accepts any case'],
  }]));

  const r = spawnSync(process.execPath, [AC_GATE, '--issues', issues, '--out', join(work, 'out.json')], {
    encoding: 'utf8', timeout: 120000, cwd: REPO,
    env: {
      // The ladder environment a run exports. Without it the seam refuses to resolve a model at
      // all — correctly — and never reaches the runner, so the vector could not be observed.
      ...process.env, ...LADDERS,
      AI_RUNNER_CMD: stub,
      // resolveCodelines() reads JIRA_CODELINES or codeline-* labels — not the story field. Its
      // own warning says so, and without it every codeline-derived value renders empty and the
      // prompt refuses, so the runner is never reached.
      JIRA_CODELINES: 'alphashop,betashop',
      LOG_DIR: work,
      AC_GATE_TIMEOUT_MS: '30000',
      ...env,
    },
  });

  const vectors: string[][] = [];
  if (existsSync(argvLog)) {
    for (const line of readFileSync(argvLog, 'utf8').split('\n')) {
      if (line === '--CALL--') { vectors.push([]); continue; }
      if (vectors.length) vectors[vectors.length - 1].push(line);
    }
    for (const v of vectors) if (v.length && v[v.length - 1] === '') v.pop();
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', vectors, work };
}

/** The state the defect needs: no provider anywhere in the environment. */
const NO_PROVIDER = {
  ORCH_GATE_PROVIDER: '', EPAM_ORCHESTRATION_PROVIDER: '', AI_PROVIDER: '',
  EPAM_PROVIDER_SET: 'claude',
};

/**
 * ac-gate refuses to render 'ac-classification' without codeline context and schema fields — a
 * correct guard — so reaching its runner needs a project whose prompts have been PROVISIONED, and
 * provisioning calls a model. The assertions that need the runner are gated on that rather than
 * quietly passing: a receiver test that cannot reach the receiver must say so, not report green.
 */
const reachable = (() => {
  const r = runAcGate(NO_PROVIDER);
  return { ok: r.vectors.length > 0, why: r.stderr.slice(-300) };
})();
const itReceiver = reachable.ok ? it : it.skip;

describe('a seam never picks a vendor the active stack does not declare', () => {
  it('says plainly whether the runner is reachable', () => {
    // Not an assertion that it IS reachable — a statement of which half of this file ran.
    if (!reachable.ok) {
      // eslint-disable-next-line no-console
      console.warn('  ac-gate receiver assertions SKIPPED — it never reached a runner:\n  '
        + reachable.why.split('\n').slice(-2).join('\n  '));
    }
    expect(typeof reachable.ok).toBe('boolean');
  }, 120_000);

  itReceiver('with no provider configured, it does not name a vendor of its own', () => {
    // The defect: 'openrouter' hardcoded as the last resort, on a run launched as claude.
    const r = runAcGate(NO_PROVIDER);
    for (const argv of r.vectors) {
      const i = argv.indexOf('--provider');
      if (i === -1) continue;                       // deferring to the set is the correct answer
      expect(argv[i + 1], 'a provider was invented when none was configured')
        .not.toBe('openrouter');
    }
  }, 120_000);

  itReceiver('and whatever it does pass is a provider the dispatch accepts', () => {
    const accepted = declaredProviders();
    expect(accepted.size, 'no providers parsed from the dispatch — the shape has changed')
      .toBeGreaterThan(2);
    const r = runAcGate(NO_PROVIDER);
    for (const argv of r.vectors) {
      const i = argv.indexOf('--provider');
      if (i === -1) continue;
      expect([...accepted], `ac-gate routes to '${argv[i + 1]}', which the dispatch does not accept`)
        .toContain(argv[i + 1]);
    }
  }, 120_000);

  itReceiver('a configured provider is still honoured — the negative half', () => {
    // Removing the fallback must not stop a caller choosing a provider.
    const r = runAcGate({ ...NO_PROVIDER, EPAM_ORCHESTRATION_PROVIDER: 'claude' });
    const argv = r.vectors[0] || [];
    const i = argv.indexOf('--provider');
    expect(i, `--provider was dropped although one was configured: ${argv.join(' ')}`)
      .toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('claude');
  }, 120_000);

  itReceiver('no flag in the vector is followed by another flag', () => {
    // The same class as discovery: an empty value leaves its flag pointing at the next flag.
    const r = runAcGate(NO_PROVIDER);
    for (const argv of r.vectors) {
      for (let i = 0; i < argv.length - 1; i += 1) {
        if (!argv[i].startsWith('--')) continue;
        expect(argv[i + 1].startsWith('--'),
          `${argv[i]} is followed by ${argv[i + 1]}: its value was empty and the shell dropped it`
          + `\n  vector: ${argv.join(' ')}`).toBe(false);
      }
    }
  }, 120_000);
});
