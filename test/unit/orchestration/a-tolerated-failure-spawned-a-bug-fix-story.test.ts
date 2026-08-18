// A FAILURE THE RUN WAS TOLD TO TOLERATE COULD STILL SPAWN A BUG-FIX STORY.
//
// The regression guard records, at run start, which tests already fail in the codeline and writes
// them to regression-guard-baseline-<phase>.json:
//
//   {"stable": true, "failures": ["src/.../ProductContainer.spec.tsx"]}
//
// That record exists so later gates can tell "this change broke it" from "it was already broken —
// inherit what the codeline had, never add to it". Exactly one consumer reads it: the regression
// DELTA gate. The loop that turns failing test files into bug-fix stories does not.
//
// So a pre-existing, explicitly tolerated failure can be parsed out of the test output and turned
// into a story — putting a writer to work on a defect the run had already decided was not its
// business, and charging the phase for it.
//
// The baseline is the same file, read the same way as the delta gate reads it. A failing file on
// it is skipped with a line saying so; anything not on it is a real new failure and still becomes
// a story. When there is no baseline — the guard was skipped, as writer-only mode does — nothing
// is tolerated and every failure counts, which is the safe direction.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tolerated-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the extracted helper against a baseline file. */
function tolerated(file: string, baseline: unknown | null, phase = 'core') {
  const src = readFileSync(ORCH, 'utf8');
  const m = src.match(/^_failure_is_tolerated\(\)\s*\{[\s\S]*?\n\}/m);
  if (!m) throw new Error('run-agent-orchestration.sh has no _failure_is_tolerated()');
  if (baseline !== null) {
    writeFileSync(join(dir, `regression-guard-baseline-${phase}.json`), JSON.stringify(baseline));
  }
  const r = spawnSync('bash', ['-c',
    `LOG_DIR=${JSON.stringify(dir)}\n${m[0]}\n`
    + `if _failure_is_tolerated ${JSON.stringify(file)} ${JSON.stringify(phase)}; then echo YES; else echo NO; fi`,
  ], { encoding: 'utf8' });
  return `${r.stdout}`.trim();
}

const BASELINE = { stable: true, failures: ['src/legacy/Broken.spec.tsx', 'test/old.test.ts'] };

describe('a tolerated failure spawned a bug-fix story', () => {
  it('A FAILURE ON THE BASELINE IS TOLERATED — the run already decided this', () => {
    expect(tolerated('src/legacy/Broken.spec.tsx', BASELINE), 'a tolerated failure would still become a story').toBe('YES');
  });

  it('A FAILURE NOT ON THE BASELINE IS NOT — this change broke it', () => {
    expect(tolerated('src/new/Thing.spec.tsx', BASELINE), 'a genuinely new failure was suppressed').toBe('NO');
  });

  it('WITH NO BASELINE NOTHING IS TOLERATED — the safe direction', () => {
    // writer-only mode skips the regression guard, so no baseline exists; every failure counts.
    expect(tolerated('src/legacy/Broken.spec.tsx', null)).toBe('NO');
  });

  it('an unstable baseline tolerates nothing — it proved nothing', () => {
    expect(tolerated('src/legacy/Broken.spec.tsx', { stable: false, failures: ['src/legacy/Broken.spec.tsx'] })).toBe('NO');
  });

  it('a malformed or empty baseline tolerates nothing rather than everything', () => {
    writeFileSync(join(dir, 'regression-guard-baseline-core.json'), '{ not json');
    const src = readFileSync(ORCH, 'utf8');
    const m = src.match(/^_failure_is_tolerated\(\)\s*\{[\s\S]*?\n\}/m)![0];
    const r = spawnSync('bash', ['-c',
      `LOG_DIR=${JSON.stringify(dir)}\n${m}\nif _failure_is_tolerated "x" "core"; then echo YES; else echo NO; fi`,
    ], { encoding: 'utf8' });
    expect(`${r.stdout}`.trim()).toBe('NO');
    expect(tolerated('anything', { stable: true, failures: [] })).toBe('NO');
  });

  it('THE BUG-FIX LOOP CONSULTS IT — a helper nobody calls is the same defect', () => {
    const src = readFileSync(ORCH, 'utf8');
    const loop = src.indexOf('while IFS= read -r failing_file; do');
    expect(loop, 'the bug-fix loop moved — this check is blind').toBeGreaterThan(-1);
    const body = src.slice(loop, loop + 2500);
    // A CALL, not the name. Asserting the name appears in the slice passed with the condition
    // replaced by `if false` — the helper's own definition satisfied the match.
    expect(body, 'the loop never CALLS the tolerated-failure check')
      .toMatch(/if\s+_failure_is_tolerated\s+"\$failing_file"/);
  });
});
