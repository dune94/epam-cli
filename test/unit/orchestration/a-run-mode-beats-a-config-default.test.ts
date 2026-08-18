/**
 * A RUN MODE OVERRIDES A CONFIG DEFAULT, AND STILL YIELDS TO THE OPERATOR.
 *
 * WRITTEN BEFORE THE FIX. Found live 2026-08-13: EPAM_RUN_MODE=writer-only set five of its six
 * variables and the regression guard ran anyway, because config.env carries
 * SKIP_REGRESSION_GUARD=false and is loaded BEFORE the mode is applied. The mode's "never
 * overwrite what is already set" rule then read a config-file default as a deliberate choice and
 * yielded to it — so a named intent was silently half-applied, which is worse than not having one.
 *
 * The three-way precedence that is actually wanted:
 *
 *     operator environment  >  run mode  >  config-file default
 *
 * "Operator environment" means set before any config file was read — which is exactly what a
 * launcher can capture, and exactly what a config file cannot fake.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/run-modes.sh');
const MODES = join(ROOT, 'orchestrations/config/run-modes.json');

/** Apply the mode with a given pre-config snapshot and a config-file default already in place. */
function apply(opts: { operatorSet?: string; configDefault?: string }): string {
  const script = `set -uo pipefail
error() { printf 'ERROR %s\\n' "$*"; }
RUN_MODES_FILE=${JSON.stringify(MODES)}
NODE_BIN=${JSON.stringify(process.execPath)}
export RUN_MODES_FILE NODE_BIN
${opts.operatorSet ? `export ${opts.operatorSet}` : ''}
# the launcher snapshots the operator's environment BEFORE reading any config file
. ${JSON.stringify(LIB)}
snapshot_operator_env
${opts.configDefault ? `export ${opts.configDefault}   # as config.env does, with preserve semantics` : ''}
apply_run_mode writer-only
printf 'SKIP_REGRESSION_GUARD=%s\\n' "${'$'}{SKIP_REGRESSION_GUARD:-unset}"
printf 'SKIP_CPA=%s\\n' "${'$'}{SKIP_CPA:-unset}"`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('THE MODE BEATS A CONFIG-FILE DEFAULT', () => {
  it('a config default does not stop the mode applying', () => {
    // THE LIVE DEFECT: config.env sets SKIP_REGRESSION_GUARD=false, and the whole point of
    // writer-only is that the regression baseline does not run.
    const out = apply({ configDefault: 'SKIP_REGRESSION_GUARD=false' });
    expect(out, 'a config default silently defeated the mode')
      .toContain('SKIP_REGRESSION_GUARD=true');
  });

  it('the rest of the mode still applies alongside it', () => {
    expect(apply({ configDefault: 'SKIP_REGRESSION_GUARD=false' })).toContain('SKIP_CPA=1');
  });
});

describe('THE OPERATOR STILL WINS', () => {
  it('a value set BEFORE any config file was read is left alone', () => {
    // writer-only WITH the regression baseline is a legitimate thing to ask for, and asking for
    // it must not require knowing which file sets what.
    const out = apply({ operatorSet: 'SKIP_REGRESSION_GUARD=false' });
    expect(out, "the mode overrode the operator's own setting")
      .toContain('SKIP_REGRESSION_GUARD=false');
  });

  it('and the rest of the mode still applies', () => {
    expect(apply({ operatorSet: 'SKIP_REGRESSION_GUARD=false' })).toContain('SKIP_CPA=1');
  });
});

describe('WITH NO SNAPSHOT AT ALL, THE MODE IS STILL APPLIED', () => {
  it('a launcher that never snapshots does not lose the mode', () => {
    // Fail SAFE: a caller that has not been updated gets the mode, not a silently empty one.
    const script = `set -uo pipefail
error() { printf 'ERROR %s\\n' "$*"; }
RUN_MODES_FILE=${JSON.stringify(MODES)}
NODE_BIN=${JSON.stringify(process.execPath)}
export RUN_MODES_FILE NODE_BIN
. ${JSON.stringify(LIB)}
apply_run_mode writer-only
printf 'SKIP_CPA=%s\\n' "${'$'}{SKIP_CPA:-unset}"`;
    expect(execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toContain('SKIP_CPA=1');
  });
});
