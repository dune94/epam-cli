/**
 * THREE SETS WERE FIXED BY NAMING THEIR RUNNER "claude". CODEMIE WAS NOT.
 *
 * apply_runner_settings is called with `basename "$CLAUDE_CMD"`, and CLAUDE_CMD is "claude" under
 * every set — llm-defaults.openrouter.json:235 says so in the codebase's own words:
 *
 *   "apply_runner_settings is called with the BASENAME of CLAUDE_CMD, which is 'claude' under
 *    every set, so a set declaring no runner by that name resolves nothing and the flags, env and
 *    scrubs of whatever ran before are simply carried over."
 *
 * claude, openrouter and mockserver each declare a runner literally named "claude", so they
 * resolve. The codemie set declares "codemie-claude" — the binary it actually invokes — and
 * therefore resolves NOTHING.
 *
 * What is lost is not cosmetic. codemie's only alwaysFlags entry is `-s`, and its own declaration
 * calls it "a CORRECTNESS requirement, not a preference. Without it the wrapper opens an
 * INTERACTIVE menu ... in a pipeline that is a HANG, not a failure: the run waits for a keypress
 * until its timeout."
 *
 * THE RULE: a runner declaration is resolved by the CLI THAT IS ACTUALLY INVOKED, falling back to
 * the CLAUDE_CMD basename for the sets whose declarations predate this. First hit wins, so the
 * three working sets keep resolving exactly as before and codemie starts resolving at all.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/runner-settings.sh');
const CONFIG = join(ROOT, 'orchestrations/config');

/** Run apply_runner_settings for a set and report what RUNNER_FLAGS came out. */
function applyFor(set: string, invokedCli: string) {
  const d = mkdtempSync(join(tmpdir(), 'runner-'));
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash
set -uo pipefail
export EPAM_PROVIDER_SET="${set}"
export EPAM_LLM_DEFAULTS_FILE="${join(CONFIG, `llm-defaults.${set}.json`)}"
RUNNER_FLAGS=()
source "${LIB}"
apply_runner_settings "${invokedCli}" "" || true
printf '%s\\n' "\${RUNNER_FLAGS[@]+\${RUNNER_FLAGS[@]}}"
`);
  const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
  rmSync(d, { recursive: true, force: true });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}


/** Exactly what the call sites do: resolve the runner NAME first, then apply it. */
function applyAsCaller(set: string, provider: string, claudeCmdBasename: string) {
  const d = mkdtempSync(join(tmpdir(), 'runner-c-'));
  const f = join(d, 'h.sh');
  writeFileSync(f, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `export EPAM_PROVIDER_SET="${set}"`,
    `export EPAM_LLM_DEFAULTS_FILE="${join(CONFIG, `llm-defaults.${set}.json`)}"`,
    'RUNNER_FLAGS=()',
    `source "${LIB}"`,
    `apply_runner_settings "$(runner_name_for "${provider}" "${claudeCmdBasename}")" "" || true`,
    'printf "%s\\n" "${RUNNER_FLAGS[@]+${RUNNER_FLAGS[@]}}"',
  ].join('\n'));
  const r = spawnSync('bash', [f], { encoding: 'utf8', timeout: 60_000 });
  rmSync(d, { recursive: true, force: true });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

describe('a runner declaration is resolved by the CLI actually invoked', () => {
  it('the fixture really is the asymmetry: only codemie declares no "claude" runner', () => {
    const has = (set: string) => {
      const j = JSON.parse(readFileSync(join(CONFIG, `llm-defaults.${set}.json`), 'utf8'));
      return Object.keys(j.runners || {});
    };
    expect(has('claude')).toContain('claude');
    expect(has('openrouter')).toContain('claude');
    expect(has('mockserver')).toContain('claude');
    expect(has('codemie'), 'codemie now declares a "claude" runner — this test is stale')
      .not.toContain('claude');
    expect(has('codemie')).toContain('codemie-claude');
  });

  it('resolves codemie-claude when codemie-claude is what gets invoked', () => {
    const r = applyFor('codemie', 'codemie-claude');
    expect(r.out.split('\n').filter(Boolean),
      'the library itself resolves fine when handed the right name').toContain('-s');
  });

  /**
   * THE DEFECT IS IN THE CALLERS, NOT THE LIBRARY. Both call sites pass
   * `basename "$CLAUDE_CMD"`, and CLAUDE_CMD is "claude" under every set — nothing sets it from
   * provider_to_cli, and the codemie arms invoke the literal string `codemie-claude`
   * (claude.sh:10326, llm-handler.sh:307) while CLAUDE_CMD stays "claude".
   */
  it('THE DEFECT: the caller resolves by CLAUDE_CMD, so codemie gets nothing', () => {
    // Exactly what the callers do today: CLAUDE_CMD unset -> "claude", under the codemie set.
    const asCallerDoesIt = applyAsCaller('codemie', 'codemie-claude', 'claude');
    expect(asCallerDoesIt.out.split('\n').filter(Boolean),
      'codemie resolved nothing: -s is never passed, and its own declaration calls -s ' +
      '"a CORRECTNESS requirement ... without it the wrapper opens an INTERACTIVE menu ... ' +
      'a HANG, not a failure"').toContain('-s');
  });

  it('the call sites resolve by the CLI they will actually invoke', () => {
    for (const rel of ['orchestrations/scripts/llm-handler.sh', 'orchestrations/scripts/claude.sh']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(/apply_runner_settings "\$\(basename "\$\{?CLAUDE_CMD/.test(src),
        `${rel} still resolves the runner from CLAUDE_CMD, which is "claude" under every set`)
        .toBe(false);
      expect(src.includes('runner_name_for'),
        `${rel} does not use the shared resolver`).toBe(true);
    }
  });

  it('still resolves the three sets that name their runner "claude" — no regression', () => {
    // Their provider name resolves nothing, so the CLAUDE_CMD fallback must still find "claude".
    for (const set of ['claude', 'openrouter', 'mockserver']) {
      const r = applyAsCaller(set, set, 'claude');
      expect(r.err, `${set} errored: ${r.err.slice(0, 200)}`).not.toMatch(/error|not found/i);
    }
  });

  it('a set that declares neither name resolves nothing rather than inheriting silently', () => {
    const r = applyFor('codemie', 'some-unknown-binary');
    expect(r.out.split('\n').filter(Boolean),
      'an unknown binary picked up another runner\'s flags').not.toContain('-s');
  });
});
