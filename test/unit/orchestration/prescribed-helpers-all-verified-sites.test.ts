/**
 * THE GUARD CHECKED ONE HELPER OUT OF FOUR.
 *
 * Live 2026-08-09. The spec identified FOUR fix sites for gotransit, every one fixVerified:true
 * with a named helper:
 *
 *     src/services/contentstack.ts        options
 *     src/context/ContentstackContext.tsx useContentstackContext
 *     src/services/pageService.ts         getEntry
 *     src/hooks/useContent.ts             getValue
 *
 * The writer changed contentstack.ts and nothing else — 12 lines wiring a live_preview option
 * onto the Stack. That cannot satisfy its own verification criterion ("the rendered page displays
 * the DRAFT content values"), which needs the fetch path to pass preview params and the context
 * to hold the hash. The story was committed and reported complete.
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
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
${lift('verify_prescribed_helper_used')}
     verify_prescribed_helper_used S1; echo "RC=$?"
     echo "__VF__"; printf '%s' "$VERIFICATION_FAILURE"`,
  ], { encoding: 'utf8' });
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1]),
    vf: (out.split('__VF__')[1] ?? '').trim(),
    out,
  };
}

const FOUR = ['options', 'useContentstackContext', 'getEntry', 'getValue'];

describe('the fixture reproduces the live shape', () => {
  it('four verified helpers, all existing in the repo', () => {
    const { prd } = fixture(FOUR, ['options']);
    const sites = JSON.parse(readFileSync(prd, 'utf8')).stories[0].fixSiteAnalysis;
    expect(sites).toHaveLength(4);
    expect(sites.every((s: { fixVerified: boolean }) => s.fixVerified)).toBe(true);
  });
});

describe('THE DEFECT: every verified helper is checked, not just the first', () => {
  it('using ONLY the first helper is rejected — the exact live case', () => {
    const r = runGuard(FOUR, ['options']);
    expect(
      r.rc,
      'the guard checked .[0].helper only, so satisfying one verified site silenced it for the ' +
      'other three — the story shipped 1 of 4 fix sites and was reported complete',
    ).not.toBe(0);
  });

  it.each([1, 2, 3])('using only helper #%i of four is rejected', (i) => {
    expect(runGuard(FOUR, [FOUR[i]]).rc).not.toBe(0);
  });

  it('using three of four is still rejected', () => {
    expect(runGuard(FOUR, FOUR.slice(0, 3)).rc).not.toBe(0);
  });

  it('the message names the helpers that are MISSING, not just one', () => {
    const { vf } = runGuard(FOUR, ['options']);
    for (const h of FOUR.slice(1)) {
      expect(vf, `${h} was never mentioned, so the writer cannot know it is required`).toMatch(h);
    }
  });

  it('and does not demand the one already used', () => {
    const { vf } = runGuard(FOUR, ['options']);
    const missingSection = vf.slice(vf.search(/missing|not appear|MUST/i));
    expect(missingSection).not.toMatch(/\boptions\b(?![a-zA-Z])/);
  });
});

describe('it does not over-reject', () => {
  it('using ALL four passes', () => {
    expect(runGuard(FOUR, FOUR).rc).toBe(0);
  });

  it('a single verified helper, used, still passes — the original case is intact', () => {
    expect(runGuard(['options'], ['options']).rc).toBe(0);
  });

  it('a single verified helper, NOT used, still fails — no regression', () => {
    expect(runGuard(['options'], []).rc).not.toBe(0);
  });

  it('an UNVERIFIED site is not required', () => {
    // fixVerified:false means the spec guessed. Demanding it would fail stories for a candidate.
    const { dir, prd } = fixture(['options'], ['options']);
    const cfg = JSON.parse(readFileSync(prd, 'utf8'));
    cfg.stories[0].fixSiteAnalysis.push({ file: 'src/guess.ts', helper: 'speculative', fixVerified: false });
    writeFileSync(prd, JSON.stringify(cfg));
    const out = execFileSync('bash', ['-c',
      `set +e
       EPAM_BROWNFIELD=1 PROJECT_ROOT=${JSON.stringify(dir)}
       MAIN_PRD_FILE=${JSON.stringify(prd)} PRD_FILE=${JSON.stringify(prd)} LOG_DIR=${JSON.stringify(dir)}
       VERIFICATION_FAILURE="" DETERMINISTIC_CHECK_FAILURE=0
       warning() { :; }; error() { :; }; log() { :; }; info() { :; }; success() { :; }
       is_truthy() { return 1; }
${lift('verify_prescribed_helper_used')}
       verify_prescribed_helper_used S1; echo "RC=$?"`,
    ], { encoding: 'utf8' });
    expect(Number((out.match(/RC=(\d+)/) || [])[1])).toBe(0);
  });

  it('no verified helpers at all is a no-op', () => {
    expect(runGuard([], []).rc).toBe(0);
  });
});

describe('the rejection still reaches the next attempt', () => {
  it('sets both the message and the routing flag', () => {
    const { vf, out } = runGuard(FOUR, ['options']);
    expect(vf).not.toBe('');
    expect(lift('verify_prescribed_helper_used')).toMatch(/DETERMINISTIC_CHECK_FAILURE=1/);
    expect(out).toMatch(/WARN:/);
  });
});
