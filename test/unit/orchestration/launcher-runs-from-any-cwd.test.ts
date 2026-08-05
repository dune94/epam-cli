/**
 * THE TEST THAT SHOULD HAVE CAUGHT IT.
 *
 * EPAM_CODELINE_FILTER shipped with tests proving it produces a coherent single-lane PRD.
 * None of them proved a single-lane run EXECUTES. It did not: the first real one died at
 *
 *   bash: orchestrations/scripts/run-agent-orchestration.sh: No such file or directory
 *   [ERROR] Phase 'core' for 'metrolinx' failed (exit 127)
 *
 * because every launcher invoked the orchestrator by RELATIVE path. The orchestrator
 * re-invokes itself per codeline (`bash "$0" --reset`), so a relative $0 resolves against
 * whatever cwd the lane loop last set — the CLIENT repo. Multi-lane runs never exposed it:
 * the parallel branch (gated on >1 lane) runs each lane in a SUBSHELL, so its `cd` cannot
 * leak. One lane falls to the sequential branch, same shell, and the latent bug became
 * reachable the moment single-lane became possible.
 *
 * This EXECUTES the launcher's real run_phase against a stub orchestrator that records the
 * path it was invoked as, from a cwd that is NOT the repo root — the condition the lane
 * loop creates. A source-level check that "the string looks absolute" would not have
 * proven the invocation survives a cd; this does.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const launchers = readdirSync(SCRIPTS).filter(
  (f) => /^tier\d.*-run\.sh$/.test(f) &&
    /run-agent-orchestration\.sh/.test(readFileSync(join(SCRIPTS, f), 'utf8')),
);

/**
 * Run a launcher's real run_phase() with a stubbed orchestrator, from a foreign cwd.
 * Returns what the orchestrator was invoked as, and whether the call worked.
 */
function invokeFromForeignCwd(launcher: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cwd-'));
  const fakeScripts = join(dir, 'scripts');
  const foreignCwd = join(dir, 'client-repo');
  mkdirSync(fakeScripts, { recursive: true });
  mkdirSync(foreignCwd, { recursive: true });

  // A stub orchestrator that records how it was reached.
  const record = join(dir, 'invoked-as.txt');
  const stub = join(fakeScripts, 'run-agent-orchestration.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' "$0" > ${JSON.stringify(record)}\nexit 0\n`);
  chmodSync(stub, 0o755);

  const src = readFileSync(join(SCRIPTS, launcher), 'utf8');
  const start = src.indexOf('run_phase() {');
  if (start === -1) return { skipped: true } as const;
  const body = src.slice(start, src.indexOf('\n}', start) + 2);

  // Stub EVERY sibling script this run_phase calls, not just the orchestrator. Two
  // launchers run prd-remediate.sh first and `fail` if it is missing — so without this the
  // harness never reaches the invocation under test and reports a false problem.
  for (const m of body.matchAll(/\$SCRIPT_DIR\/([A-Za-z0-9._-]+\.sh)/g)) {
    const sibling = join(fakeScripts, m[1]);
    if (!existsSync(sibling)) {
      writeFileSync(sibling, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(sibling, 0o755);
    }
  }

  const runner = join(dir, 'run.sh');
  writeFileSync(
    runner,
    [
      'set -uo pipefail',
      'info(){ :; }; log(){ :; }; success(){ :; }; warning(){ :; }; error(){ :; }',
      'fail(){ echo "FAIL: $*"; exit 9; }',
      `SCRIPT_DIR=${JSON.stringify(fakeScripts)}`,
      `REPO_ROOT=${JSON.stringify(dir)}`,
      `LOG_FILE=${JSON.stringify(join(dir, 'launch.log'))}`,
      // Define every OTHER shell variable this body references. run_phase differs per
      // launcher (some run a PRD remediation step first), and under `set -u` an undefined
      // one aborts before the invocation under test — a harness fault reported as a
      // product fault, which is worse than no test.
      ...[...new Set(
        [...body.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)].map((m) => m[1]),
      )]
        .filter((v) => !['SCRIPT_DIR', 'REPO_ROOT', 'LOG_FILE', 'PIPESTATUS'].includes(v))
        .map((v) => `${v}=\"\"`),
      body,
      // THE CONDITION THE LANE LOOP CREATES: cwd is the client repo, not the repo root.
      `cd ${JSON.stringify(foreignCwd)}`,
      'run_phase core; echo "RC=$?"',
    ].join('\n'),
  );

  const r = spawnSync('bash', [runner], { encoding: 'utf8', timeout: 30000, cwd: foreignCwd });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (process.env.DEBUG_CWD_TEST) console.log(`--- ${launcher} ---\n${out}`);
  return {
    skipped: false,
    out,
    invokedAs: existsSync(record) ? readFileSync(record, 'utf8') : null,
  } as const;
}

describe('a launcher reaches the orchestrator from any working directory', () => {
  it('there are launchers to check — otherwise this proves nothing', () => {
    expect(launchers.length).toBeGreaterThan(0);
  });

  it.each(launchers)('%s invokes the orchestrator after a cd into a client repo', (f) => {
    const r = invokeFromForeignCwd(f);
    if (r.skipped) return;

    expect(
      r.out,
      `${f} could not reach the orchestrator once cwd moved — the exact exit-127 failure a ` +
        `single-lane run hits, because the orchestrator re-invokes itself via $0 after the ` +
        `lane loop cds into the codeline. Output:\n${r.out}`,
    ).not.toMatch(/No such file or directory|command not found/);

    expect(r.invokedAs, `${f} never invoked the orchestrator at all`).toBeTruthy();
    expect(
      r.invokedAs!.startsWith('/'),
      `${f} invoked the orchestrator as '${r.invokedAs}' — a relative $0 is what breaks the ` +
        `orchestrator's own per-codeline re-invocation`,
    ).toBe(true);
  });
});
