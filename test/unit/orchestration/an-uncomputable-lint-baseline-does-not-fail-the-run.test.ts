/**
 * A BASELINE WE COULD NOT COMPUTE IS NOT A BASELINE OF ZERO FINDINGS.
 *
 * WRITTEN BEFORE THE FIX. RED WHEN WRITTEN.
 *
 * Live 2026-08-14, AMSD-2041 on next.metrolinx.com. The lint gate builds its baseline by checking
 * the baseline commit out into a throwaway worktree and symlinking the project's declared vendor
 * directory in, because it is gitignored and `worktree add` will not check it out.
 *
 * That symlink gives the linter TWO paths to the same physical plugin directory. next.metrolinx.com
 * carries a nested duplicate of its lint plugin -- pinned in the client's own committed lockfile
 * since 2026-06-03 by an upstream framework upgrade, and entirely harmless to the client, whose own
 * lint run resolves each plugin by exactly one path. Through the symlink it resolves by two, so the
 * linter refused to start and wrote ZERO BYTES.
 *
 * The invocation ends in `|| true`, and the result is judged only by `[ -s "$cache" ]`. So
 * "the linter crashed" and "the baseline is clean" are the same value, and the gate charged the run
 * with eight violations dating from 2025-01 to 2026-04. Two repair attempts could not remove them --
 * they are not this run's to remove -- and the run was killed at 113 minutes with its work already
 * committed and its review already APPROVED.
 *
 * next.gotransit.com passed the same gate the previous day with a flat plugin tree. Same code, same
 * commit, two different vendor topologies.
 *
 * THE RULE. Findings whose provenance we could not establish are reported, not charged. Failing a
 * run for a defect it did not introduce, and cannot fix without editing code outside its story, is
 * a false accusation the run has no way to answer.
 *
 * AND THE GUARD THAT MATTERS MORE. This must not become a blanket pass. When the baseline IS
 * computable and the run DID introduce a finding, the gate must still fail -- otherwise this fix
 * has quietly disabled lint enforcement for every project.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const GATE = join(ROOT, 'orchestrations/scripts/lib/eslint-baseline-gate.sh');

/**
 * A real git repo with one committed source file, the project's own declaration of what to lint,
 * and a STUBBED linter so the test controls exactly what the baseline and current runs report.
 */
function fixture(opts: { baselineSha: string; baselineFindings: number; currentFindings: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'lintgate-'));
  const logs = join(dir, 'logs');
  mkdirSync(join(dir, 'proj/src'), { recursive: true });
  mkdirSync(logs, { recursive: true });
  const proj = join(dir, 'proj');

  writeFileSync(join(proj, 'src/a.ts'), 'export const a = 1;\n');
  mkdirSync(join(proj, '.epam'), { recursive: true });
  writeFileSync(join(proj, '.epam/dependency-check.json'), JSON.stringify({
    scanFileExtensions: ['.ts'],
    moduleRoots: ['src'],
    vendorDirs: ['vendor'],
  }));
  mkdirSync(join(proj, 'vendor'), { recursive: true });

  for (const cmd of [
    ['init', '-q'], ['add', '-A'],
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'],
  ]) spawnSync('git', ['-C', proj, ...cmd], { encoding: 'utf8' });

  const head = spawnSync('git', ['-C', proj, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  // The linter stub. It reports `currentFindings` when run from the real project root and
  // `baselineFindings` when run from anywhere else (i.e. the baseline worktree).
  const bin = join(dir, 'stub-linter');
  writeFileSync(bin, `#!/usr/bin/env bash
if [ "$PWD" = "${proj}" ]; then N=${opts.currentFindings}; else N=${opts.baselineFindings}; fi
if [ "$N" -lt 0 ]; then echo "linter refused to start" >&2; exit 2; fi   # crash => zero bytes
MSGS=""
for i in $(seq 1 "$N"); do
  [ -n "$MSGS" ] && MSGS="$MSGS,"
  MSGS="$MSGS{\\"ruleId\\":\\"no-any\\",\\"message\\":\\"Unexpected any.\\",\\"line\\":$i,\\"column\\":1}"
done
echo "[{\\"filePath\\":\\"${proj}/src/a.ts\\",\\"messages\\":[$MSGS]}]"
`);
  chmodSync(bin, 0o755);

  writeFileSync(join(logs, 'phase-baseline-sha.txt'), opts.baselineSha === 'HEAD' ? head : opts.baselineSha);
  writeFileSync(join(logs, 'story-outputs-core.txt'), 'src/a.ts\n');

  return { dir, proj, logs, bin, head };
}

function runGate(fx: ReturnType<typeof fixture>) {
  const lintLog = join(fx.logs, 'lint.log');
  const script = `
    set -uo pipefail
    warning() { echo "WARN: $*"; }
    error()   { echo "ERROR: $*"; }
    success() { echo "OK: $*"; }
    info()    { echo "INFO: $*"; }
    export PHASE=core
    source '${GATE}'
    eslint_baseline_gate '${fx.proj}' '${fx.bin}' '${fx.logs}' '${lintLog}'
    echo "GATE_RC=$?"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/GATE_RC=(\d+)/);
  return { out, rc: m ? Number(m[1]) : -1 };
}

describe('THE HARNESS DRIVES THE REAL GATE', () => {
  it('the gate function exists and runs', () => {
    const fx = fixture({ baselineSha: 'HEAD', baselineFindings: 0, currentFindings: 0 });
    const { rc, out } = runGate(fx);
    expect(out, 'the gate produced no output — the harness is not driving it').toMatch(/lint/i);
    expect(rc, 'a clean run should pass').toBe(0);
  });
});

describe('AN UNCOMPUTABLE BASELINE IS REPORTED, NOT CHARGED', () => {
  // A baseline SHA that does not exist in the repo: `worktree add` fails exactly as it does when
  // the linter refuses to start, and the cache is left empty.
  const bogus = '0000000000000000000000000000000000000000';

  it('does not fail the run when the baseline could not be computed', () => {
    const fx = fixture({ baselineSha: bogus, baselineFindings: 0, currentFindings: 3 });
    const { rc, out } = runGate(fx);
    expect(out, 'the gate did not report that the baseline was uncomputable')
      .toMatch(/could not compute baseline/i);
    expect(rc,
      'the run was FAILED on findings whose provenance could not be established — exactly what ' +
      'killed AMSD-2041 on 2026-08-14, on violations older than the story')
      .toBe(0);
  });

  it('still reports the findings, so nothing is hidden', () => {
    const fx = fixture({ baselineSha: bogus, baselineFindings: 0, currentFindings: 3 });
    const { out } = runGate(fx);
    expect(out, 'the findings were suppressed entirely — unattributable is not invisible')
      .toMatch(/no-any|Unexpected any/);
  });
});

describe('THE GATE IS NOT DISABLED', () => {
  it('STILL fails when the baseline is computable and the run introduced a finding', () => {
    // The guard. If this ever passes, the fix above has turned lint enforcement off for everyone.
    const fx = fixture({ baselineSha: 'HEAD', baselineFindings: 0, currentFindings: 2 });
    const { rc, out } = runGate(fx);
    expect(out).not.toMatch(/could not compute baseline/i);
    expect(rc,
      'a genuinely new finding against a good baseline no longer fails the gate — the fix for ' +
      'unattributable findings has disabled enforcement entirely')
      .toBe(1);
  });

  it('passes when the baseline is computable and the findings are pre-existing', () => {
    const fx = fixture({ baselineSha: 'HEAD', baselineFindings: 2, currentFindings: 2 });
    const { rc } = runGate(fx);
    expect(rc, 'pre-existing findings were charged to the run despite a good baseline').toBe(0);
  });
});
