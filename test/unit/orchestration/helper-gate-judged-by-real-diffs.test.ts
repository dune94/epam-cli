// THE HELPER GATE, JUDGED BY REAL RUN DIFFS.
//
// The gate rejected any change where a helper the spec marked fixVerified was absent from the
// diff. That premise holds only for DEFECT stories, where the prescribed helper sits on the line
// being changed by construction:
//
//   mock3 MOCK3-1  kind=defect  helper CONCESSION_FARE_CENTS @ src/fares.ts   (2 files, +4/-1)
//                  the fix IS `age > 65` -> `age >= 65` on the line returning that constant
//
// It fails for FEATURE stories, where helper placement is a design choice:
//
//   AMSD-2041      kind=novel   5 helpers across 5 files      (gotransit: 9 files, +379/-10)
//                  gotransit SHIPPED this working, using 3 of the 5
//
// So absence is not the signal. The 2026-07-26 defect the gate was built for hand-rolled a FORMAT
// the repository already parses — `startsWith(id + '-')` where the owning module declares
// `const DIVIDER = '#'`. DUPLICATION is the signal: the change performs format surgery with its
// own separator while the prescribed helper's module owns that format.
//
// These tests replay the rule over REAL artefacts. They fail in BOTH directions — an over-strict
// rule fails the two accept cases, an inert rule fails the reject case — which is what the
// original fixture tests could not do.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { replayRepo } from '../../support/replay-codeline';
import { readFileSync } from 'node:fs';

const ROOT = join(__dirname, '../../..');
const SH = join(ROOT, 'orchestrations/scripts/claude.sh');

// THE CORPUS IS DATA. Which real changes are correct is a human judgement that cannot be
// discovered — but the estate it comes from is one client's facts, and those do not belong in
// engine test code. Entries resolve through the roots the project configs declare, and an entry
// whose repository or refs are missing SKIPS WITH ITS REASON rather than passing silently.
const CORPUS: {
  repo: string; range: string; helper: string; paths?: string;
  verdict: 'accept' | 'reject'; minDiffBytes?: number; helperAbsentFromDiff?: boolean; why?: string;
  helpers?: string[]; inlineDiff?: string[];
}[] = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/helper-gate-corpus.json'), 'utf8')).entries;

/** Executes the REAL rule: does this diff duplicate a format the helper's module owns? */
function judge(repo: string, diff: string, helper: string): { rc: number; out: string } {
  // The diff goes through a HEREDOC, never through JSON.stringify: a JS-escaped string arrives at
  // bash as ONE line containing a literal backslash-n, so `grep '^+'` matches nothing and every
  // case silently passes. That exact bug bit this session twice before being caught.
  const script = `
set +e
${extract('_helper_module_separators')}
${extract('_change_duplicates_owned_format')}
DIFF=$(cat <<'EPAM_DIFF_EOF'
${diff}
EPAM_DIFF_EOF
)
# Guard: if the diff did not survive the boundary, fail loudly rather than pass vacuously.
if [ "$(printf '%s\n' "$DIFF" | grep -c '^+')" -eq 0 ]; then echo "RC=99"; exit 0; fi
_change_duplicates_owned_format ${JSON.stringify(repo)} ${JSON.stringify(helper)} "$DIFF"
echo "RC=$?"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? -1), out };
}

function extract(fn: string): string {
  return `eval "$(awk '/^${fn}\\(\\) \\{/,/^\\}/' ${JSON.stringify(SH)})"`;
}

const have = (p: string) => existsSync(join(p, '.git'));
const gitDiff = (repo: string, range: string, paths = 'src') =>
  execFileSync('git', ['-C', repo, 'diff', range, '--', paths], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

describe('the rule is judged by real run artefacts, not fixtures', () => {
  it('the corpus is not empty', () => {
    expect(CORPUS.length, 'no judged entries — every assertion below would vanish').toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    const repo = replayRepo(entry.repo);
    const reason = repo ? '' : ' [SKIPPED: repository not found under any declared root]';
    it(`${entry.verdict.toUpperCase()}S ${entry.helper} @ ${entry.range}${reason}`, () => {
      if (!repo) return;
      // An entry either replays a real commit range or carries the exact lines under judgement
      // (a defect reduced to its two significant lines is still the real defect, not a fixture).
      let diff = '';
      if (entry.inlineDiff) {
        diff = entry.inlineDiff.join('\n');
      } else {
        try { diff = gitDiff(repo, entry.range, entry.paths || 'src'); } catch { return; }
      }
      expect(diff.length, 'the diff did not load; this would pass vacuously')
        .toBeGreaterThan(entry.minDiffBytes ?? 50);
      for (const helper of entry.helpers ?? [entry.helper]) {
        if (entry.helperAbsentFromDiff) {
          expect(diff.includes(helper), `corpus drift: ${helper} is present in this diff`).toBe(false);
        }
        const r = judge(repo, diff, helper);
        if (entry.verdict === 'accept') {
          expect(r.rc, `${helper}: rejected a change confirmed correct. ${entry.why || ''} ${r.out}`).toBe(0);
        } else {
          expect(r.rc, `${helper}: accepted a change confirmed wrong. ${entry.why || ''} ${r.out}`).not.toBe(0);
        }
      }
    });
  }
});


// THE SECOND ENFORCEMENT POINT. _committed_change_uses_helpers judges the COMMITTED diff and, on
// 2026-08-19, failed a story whose commit succeeded and whose type check passed — then halted the
// codeline. It was left blocking when verify_prescribed_helper_used was made advisory, because I
// disabled the site I remembered instead of searching for the class. There is a third
// enforcement (ReuseGuard -> EPAM_REQUIRED_SYMBOLS -> WriteFile.ts) which is scoped and capped,
// so it cannot deadlock; these two were not.
describe('the committed-change gate uses the same rule', () => {
  it('is wired to the duplication rule, not to absence', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('node:fs').readFileSync(SH, 'utf8');
    const fn = src.slice(src.indexOf('_committed_change_uses_helpers() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body, 'still keying on absence — this is what halted the run')
      .toContain('_change_duplicates_owned_format');
  });

});
