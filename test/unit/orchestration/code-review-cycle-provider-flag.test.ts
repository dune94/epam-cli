// run_review_prompt() USED TO FORCE "claude" WHENEVER EPAM_ORCHESTRATION_PROVIDER WAS UNSET.
//
// TIER 2 in change-log/SEAM-CONSISTENCY-ANALYSIS.md: AI_RUNNER_CMD is ai-run.sh -> llm-handler.sh,
// which already re-derives PRIMARY_PROVIDER from the active set when no --provider flag is given
// — so the hardcoded literal was redundant, not unsafe on its own. It is fixed anyway to remove
// the competing default, and because passing --provider "" would have been WORSE than omitting
// the flag: llm-handler.sh's own arg parsing overwrites its already-correctly-resolved
// PRIMARY_PROVIDER with whatever --provider says, including an explicit empty string.
//
// This test EXECUTES the real function extracted from the script (a stub AI_RUNNER_CMD records
// its real argv) — a test that greps the source for a flag name would pass on a comment.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/code-review-cycle.sh'), 'utf8');

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

function run(env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'crc-'));
  const runner = join(d, 'fake-runner.sh');
  writeFileSync(runner, '#!/bin/bash\necho "ARGS: $*" >&2\necho \'{"verdict":"approved","issues":[]}\'\n');
  chmodSync(runner, 0o755);
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash\nset -uo pipefail\n${fnText('run_review_prompt')}\nrun_review_prompt "hi"\n`);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, AI_RUNNER_CMD: runner, _CRC_MODEL: 'm', ...env },
  });
  rmSync(d, { recursive: true, force: true });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

describe('run_review_prompt — the --provider flag', () => {
  it('is OMITTED when EPAM_ORCHESTRATION_PROVIDER is unset — never passed as ""', () => {
    const out = run({});
    expect(out).toMatch(/ARGS: --model m/);
    expect(out).not.toMatch(/--provider/);
  });

  it('is INCLUDED with the real value when EPAM_ORCHESTRATION_PROVIDER is set', () => {
    const out = run({ EPAM_ORCHESTRATION_PROVIDER: 'openrouter' });
    expect(out).toMatch(/ARGS: --provider openrouter --model m/);
  });
});
