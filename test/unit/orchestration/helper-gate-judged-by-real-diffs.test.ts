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

const ROOT = join(__dirname, '../../..');
const SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const GOTRANSIT = '/home/bradleyjerome/projects/metrolinx/next.gotransit.com';
const MOCKA = '/home/bradleyjerome/projects/mock3/mock-a';
const CDTS = '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts';

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
  it.runIf(have(GOTRANSIT))('ACCEPTS gotransit\'s SHIPPED AMSD-2041 — 9 files, working in production', () => {
    const diff = gitDiff(GOTRANSIT, '70df4ea2..e780a8b7');
    expect(diff.length, 'the real diff did not load; this would pass vacuously').toBeGreaterThan(1000);
    // ContentstackFactory is absent from this diff — the OLD gate rejected it for that alone.
    expect(diff.includes('ContentstackFactory'), 'fixture drift: the helper is present').toBe(false);
    const r = judge(GOTRANSIT, diff, 'ContentstackFactory');
    expect(r.rc, `rejected a shipped, working implementation. ${r.out}`).toBe(0);
  });

  it.runIf(have(MOCKA))('ACCEPTS the mock3 defect fix — the green-run baseline', () => {
    const diff = gitDiff(MOCKA, 'HEAD~1..HEAD');
    expect(diff.length, 'the real diff did not load').toBeGreaterThan(50);
    const r = judge(MOCKA, diff, 'CONCESSION_FARE_CENTS');
    expect(r.rc, `rejected the mock3 fix that shipped green. ${r.out}`).toBe(0);
  });

  it.runIf(have(CDTS))('REJECTS the 2026-07-26 hand-rolled separator — the defect the gate exists for', () => {
    // RECONSTRUCTED, and labelled as such: the defective change is not in git history. The REPO
    // and the OWNING MODULE are real — dispatch-line-item-key.ts declares `const DIVIDER = '#'` —
    // and the added line is quoted verbatim in the commit that created the gate (674dfe1).
    const diff = [
      '--- a/src/services/submit-reservations/discounts.ts',
      '+++ b/src/services/submit-reservations/discounts.ts',
      '-      (lineItem) => lineItem.id === discount.lineItemId,',
      "+      (lineItem) => lineItem.id === discount.lineItemId",
      "+        || lineItem.id.startsWith(discount.lineItemId + '-'),",
    ].join('\n');
    const r = judge(CDTS, diff, 'getDispatchLineItemKey');
    expect(r.rc,
      "the change invents '-' as the separator while dispatch-line-item-key.ts owns '#' — " +
      `this shipped a fix that could never match. ${r.out}`).toBe(1);
  });

  it.runIf(have(CDTS))('ACCEPTS the same change once it USES the helper', () => {
    const diff = [
      '+ import { getDispatchLineItemKey } from "~/services/helpers/order/dispatch-line-item-key";',
      '+      (lineItem) => lineItem.id === getDispatchLineItemKey(discount.lineItemId, true),',
    ].join('\n');
    expect(judge(CDTS, diff, 'getDispatchLineItemKey').rc, 'rejected the correct fix').toBe(0);
  });

  it.runIf(have(CDTS))('ACCEPTS a change that touches nothing the helper owns', () => {
    const diff = ['+ export const unrelated = (n: number) => n + 1;'].join('\n');
    expect(judge(CDTS, diff, 'getDispatchLineItemKey').rc, 'absence alone must not reject').toBe(0);
  });
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

  it.runIf(have(GOTRANSIT))('ACCEPTS gotransit\'s shipped commit range', () => {
    const diff = gitDiff(GOTRANSIT, '70df4ea2..e780a8b7');
    for (const h of ['ContentstackFactory', 'getSinglePageEntry']) {
      expect(diff.includes(h), `fixture drift: ${h} is present`).toBe(false);
      expect(judge(GOTRANSIT, diff, h).rc, `${h}: rejected shipped, working code`).toBe(0);
    }
  });

  it.runIf(have(CDTS))('still REJECTS the format duplication it exists for', () => {
    const diff = [
      '+      (lineItem) => lineItem.id === discount.lineItemId',
      "+        || lineItem.id.startsWith(discount.lineItemId + '-'),",
    ].join('\n');
    expect(judge(CDTS, diff, 'getDispatchLineItemKey').rc, 'the real defect is no longer caught').toBe(1);
  });
});
