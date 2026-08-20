/**
 * THE GUARD CHECKED ONE HELPER OUT OF FOUR.
 *
 * Live 2026-08-09. The spec identified FOUR fix sites for one codeline, every one fixVerified:true
 * with a named helper:
 *
 *     a service module        + its config helper
 *     a context provider      + its accessor hook
 *     a data-fetch module     + its entry getter
 *     a consuming hook        + its value reader
 *
 * The writer changed the first and nothing else — 12 lines wiring one config option. That cannot
 * satisfy its own verification criterion (the rendered page must display DRAFT values), which
 * needs the fetch path to pass preview parameters and the context to hold the state. The story
 * was committed and reported complete.
 *
 * verify_prescribed_helper_used exists to catch precisely "the agent hand-rolled instead of
 * reusing the helper we verified". Its selection is:
 *
 *     map(select(fixVerified == true and helper != "")) | (.[0].helper // "")
 *
 * ONE helper. The writer used `options`, the guard fell silent, and the other three verified
 * sites were never asked about.
 *
 * MY OWN FAILURE HERE, stated because it shapes the tests below. Asked to review every gate, I
 * ran a mutation sweep asking "does removing this gate's rejection break a test?". Every gate
 * passed and I reported the class closed. That question only finds a gate whose rejection is
 * entirely untested; it cannot find a gate that rejects correctly on the WRONG SET. Nine test
 * files touch this guard and not one declares more than a single verified helper.
 *
 * So every test below enumerates the FULL set and asserts the guard covers all of it — not that
 * it fires.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const i = SRC.indexOf(`${name}() {`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  return SRC.slice(i, SRC.indexOf('\n}\n', i) + 3);
}

/** The live shape: N verified fix sites, each with its own helper; the change uses `used`. */
function fixture(helpers: string[], used: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'helpers-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  // Every helper genuinely EXISTS in the repository — that is the precondition for the guard.
  for (const h of helpers) {
    writeFileSync(join(dir, 'src', `${h}.ts`), `export const ${h} = (x: string) => x;\n`);
  }
  writeFileSync(join(dir, 'src', 'work.ts'), 'export const start = 1;\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  git('remote', 'add', 'origin', dir);
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');

  // The change: imports only the helpers in `used`.
  writeFileSync(join(dir, 'src', 'work.ts'),
    used.map(h => `import { ${h} } from "./${h}";`).join('\n') +
    `\nexport const start = ${used.length ? used.map(h => `${h}("x")`).join(' + ') : '2'};\n`);

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{
      id: 'S1',
      fixSiteAnalysis: helpers.map(h => ({
        file: `src/${h}.ts`, helper: h, fixVerified: true, fix: `use ${h}`,
      })),
    }],
  }));
  return { dir, prd };
}

function runGuard(helpers: string[], used: string[]) {
  const { dir, prd } = fixture(helpers, used);
  const out = execFileSync('bash', ['-c',
    `set +e
     EPAM_BROWNFIELD=1
     PROJECT_ROOT=${JSON.stringify(dir)}
     MAIN_PRD_FILE=${JSON.stringify(prd)} PRD_FILE=${JSON.stringify(prd)}
     LOG_DIR=${JSON.stringify(dir)}
     VERIFICATION_FAILURE="" DETERMINISTIC_CHECK_FAILURE=0
     warning() { echo "WARN:$*"; }; error() { :; }; log() { :; }; info() { :; }; success() { :; }
     # WITHOUT THIS THE SUITE IS VACUOUS. The gate resolves its baseline through
     # _resolved_baseline_ref when LOG_DIR has no phase-baseline-sha.txt. Undefined, that is
     # command-not-found, _ref is empty, the rev-parse verify fails, and the gate returns 0
     # from a guard that has nothing to do with helpers — so every assertion below was passing on
     # an early return. Confirmed by hand 2026-08-19.
     _resolved_baseline_ref() { echo "origin/develop"; }
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
${lift('_helper_module_separators')}
${lift('_change_duplicates_owned_format')}
${lift('verify_prescribed_helper_used')}
     verify_prescribed_helper_used S1; echo "RC=$?"
     echo "FLAG=\${DETERMINISTIC_CHECK_FAILURE:-0}"
     echo "__VF__"; printf '%s' "$VERIFICATION_FAILURE"`,
  ], { encoding: 'utf8' });
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1]),
    flag: Number((out.match(/FLAG=(\d+)/) || [])[1]),
    vf: (out.split('__VF__')[1] ?? '').trim(),
    out,
  };
}

/**
 * Synthetic, deliberately. A fixture built from one project's helper names only ever exercises
 * that project's vocabulary, and the guard is supposed to work from whatever the spec produced.
 * Four of them because the live shape had four verified sites — the COUNT is the fixture's
 * point, not the names.
 */
const FOUR = ['helperAlpha', 'helperBeta', 'helperGamma', 'helperDelta'];

// WHAT THIS SUITE CAN AND CANNOT PROVE.
//
// Every fixture here declares a helper in a module that owns NO format
// (`export const helperX = (x: string) => x;` — no separator literal). Under the rule adopted
// 2026-08-19 the gate keys on DUPLICATION, not absence: a change that does not re-create a format
// the helper owns is not a finding, so these fixtures can only ever demonstrate the NEGATIVE case.
//
// That is exactly what they are kept for. The gate's history is a history of false positives —
// it rejected gotransit's shipped AMSD-2041 (e780a8b7, 9 files, +379) and halted a live codeline
// on 2026-08-19 — so a suite that pins "no rejection without duplication" is guarding the failure
// mode that actually occurred.
//
// The POSITIVE case cannot be proved here, and is deliberately not attempted: it is replayed
// against the real repository and the real owning module in
// helper-gate-judged-by-real-diffs.test.ts, which is the authority for this gate.
describe('a helper that owns no format is never a finding', () => {
  it('the fixture genuinely declares no separator — else this suite proves nothing', () => {
    const { dir } = fixture(FOUR, ['options']);
    const src = readFileSync(join(dir, 'src', `${FOUR[0]}.ts`), 'utf8');
    expect(src, 'fixture drift: the helper module now owns a literal').not.toMatch(/=\s*['"][^a-zA-Z0-9 ]{1,3}['"]/);
  });

  it('using only one of four verified helpers is NOT rejected', () => {
    const r = runGuard(FOUR, ['options']);
    expect(r.rc, 'absence alone rejected the change — this is what rejected gotransit').toBe(0);
    expect(r.flag, 'absence alone set the failure flag').toBe(0);
    expect(r.vf, 'absence alone entered the retry-rejection channel').toBe('');
  });

  it.each([1, 2, 3])('using only helper #%i of four is NOT rejected either', (i) => {
    const r = runGuard(FOUR, [FOUR[i]]);
    expect(r.rc).toBe(0);
    expect(r.flag).toBe(0);
  });

  it('using three of four is NOT rejected', () => {
    expect(runGuard(FOUR, FOUR.slice(0, 3)).rc).toBe(0);
  });

  it('using ALL four is NOT rejected', () => {
    expect(runGuard(FOUR, FOUR).rc).toBe(0);
  });

  it('a single verified helper, unused, is NOT rejected', () => {
    const r = runGuard([FOUR[0]], []);
    expect(r.rc).toBe(0);
    expect(r.flag).toBe(0);
  });

  it('no verified helpers at all is a no-op', () => {
    expect(runGuard([], []).rc).toBe(0);
  });
});
