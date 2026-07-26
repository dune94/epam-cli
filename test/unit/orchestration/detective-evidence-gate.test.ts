/**
 * The detective must SHOW the broken code, not just assert a diagnosis.
 *
 * Live metrolinx 2026-07-26. The detective (kimi-k3, after a glm-5.1 ladder
 * escalation) returned clean, parseable JSON naming the right FILE and a
 * plausible-sounding root cause:
 *
 *   "applyReportDiscountsService applies the FULL line-item discount amount to
 *    each matching dispatch — no 0.5 split ... the promo amount sent to Mozio
 *    is double what it should be per leg"
 *   fix: use getPreciseFloatNumber(discount.amount.value * (isReturnTicket ? 0.5 : 1))
 *
 * It was wrong. The real defect is in the matcher one line up:
 *
 *   submit-reservations.mappers.ts:184  id: getDispatchLineItemKey(id, isReturn)
 *     → a return-trip dispatch line item id is `"<id>#return"`
 *   apply-report-discounts.service.ts:17  lineItem.id === discount.lineItemId
 *     → "123#return" === "123" is never true, so discountsForDispatch is empty,
 *       the function returns early, and NO discount is ever set.
 *
 * Which is exactly the ticket's symptom: the promo amount is NOT DISPLAYED. A
 * doubled amount would show a wrong number, not nothing.
 *
 * Every existing guard passed this. `helper` was `getPreciseFloatNumber`, which
 * genuinely exists, so verifyDetectiveHelper returned true. The JSON parsed, so
 * the attempt counted as a success. The pipeline scores this agent on "emitted
 * valid JSON", never on "the claim is true of the code" — the same
 * PRODUCED-vs-VALID gap that has produced every escaped defect here.
 *
 * The cheapest real check: a fix that changes existing code must QUOTE the
 * existing expression it is changing, and that expression must actually appear
 * in the file it names. The wrong prescription invents new logic and can quote
 * nothing; the correct one quotes `lineItem.id === discount.lineItemId`, which
 * is really there. This is a code-level check, not more prompt text.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const { verifyDetectiveEvidence } = require('../../../orchestrations/scripts/spec-mode-runner.js');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo containing the real shape of the live file. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'detective-evidence-'));
  cleanupDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const SERVICE = 'src/services/submit-reservations/apply-report-discounts.service.ts';
const SERVICE_SRC = `import { getPreciseFloatNumber } from '~/utils/get-precise-float-number';

export function applyReportDiscountsService(
  mozioDispatches: MozioDispatchPayload[],
  orderLineItems: OrderLineItem[],
): MozioDispatchPayload[] {
  const uniqDiscounts = getUniqDiscounts(orderLineItems);

  mozioDispatches.forEach((dispatch) => {
    const discountsForDispatch = uniqDiscounts.filter((discount) => {
      return dispatch.lineItems.some(
        (lineItem) => lineItem.id === discount.lineItemId,
      );
    });
  });
}
`;

describe('a prescription that changes existing code must quote that code', () => {
  it('accepts the correct diagnosis — it quotes a line that is really there', () => {
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(
      verifyDetectiveEvidence('lineItem.id === discount.lineItemId', SERVICE, repo),
      'the real broken expression was rejected — the gate would block correct fixes',
    ).toBe(true);
  });

  it('rejects the live wrong diagnosis — it quotes code that does not exist', () => {
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(
      verifyDetectiveEvidence(
        'getPreciseFloatNumber(discount.amount.value * (isReturnTicket ? 0.5 : 1))',
        SERVICE,
        repo,
      ),
      'the halving prescription passed: it invents new logic, quotes nothing real, ' +
      'and every existing guard (helper-exists, JSON-parses) waved it through',
    ).toBe(false);
  });

  it('ignores indentation and wrapping — the model reformats what it quotes', () => {
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(
      verifyDetectiveEvidence('(lineItem) => lineItem.id    === discount.lineItemId', SERVICE, repo),
      'a whitespace difference rejected a genuine quote, which would fail every correct fix',
    ).toBe(true);
  });

  it('tolerates the backticks the prompt itself uses in its example', () => {
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(verifyDetectiveEvidence('`lineItem.id === discount.lineItemId`', SERVICE, repo)).toBe(true);
  });

  it('checks the file the detective NAMED, not the repo at large', () => {
    // Quoting a real line from some other file would otherwise "prove" a
    // diagnosis about a file where that code does not appear.
    const repo = makeRepo({
      [SERVICE]: SERVICE_SRC,
      'src/other.ts': 'const x = lineItem.id === discount.lineItemId;\n',
    });
    expect(
      verifyDetectiveEvidence('lineItem.id === discount.lineItemId', 'src/other-not-named.ts', repo),
      'evidence was accepted from a file other than the one under diagnosis',
    ).toBe(false);
  });

  it('reports false — not null — when the named file does not exist', () => {
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(verifyDetectiveEvidence('anything', 'src/nope.ts', repo)).toBe(false);
  });

  it('returns null when the detective quoted nothing at all', () => {
    // null = "no claim made", distinct from false = "claim made and it is untrue".
    // Only false is evidence of a wrong diagnosis.
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(verifyDetectiveEvidence('', SERVICE, repo)).toBeNull();
    expect(verifyDetectiveEvidence(undefined, SERVICE, repo)).toBeNull();
  });

  it('does not accept a trivially short quote as evidence', () => {
    // `}` or `=>` appears in every file and proves nothing.
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(verifyDetectiveEvidence('}', SERVICE, repo),
      'a one-character "quote" was accepted as proof the diagnosis is grounded').toBe(null);
  });

  it('never escapes the repo it was given', () => {
    const repo = makeRepo({ [SERVICE]: SERVICE_SRC });
    expect(verifyDetectiveEvidence('root:x:0:0', '../../../etc/passwd', repo)).toBe(false);
  });
});

describe('the gate is wired into the detective, not merely available', () => {
  const SPEC = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('asks the model for the broken expression', () => {
    expect(SPEC, 'the output schema never requests the quoted code, so there is nothing to verify')
      .toMatch(/brokenLine/);
  });

  it('records the verdict on each finding', () => {
    expect(SPEC).toMatch(/evidenceVerified/);
  });

  it('retries when nothing in the answer is grounded in real code', () => {
    // An ungrounded answer is the failure this exists to catch; accepting it on
    // attempt 1 would leave the defect exactly as it was.
    expect(SPEC).toMatch(/evidenceVerified[\s\S]{0,400}(retry|attempt)/i);
  });

  it('still surfaces a last-attempt answer rather than failing the story', () => {
    // The detective is load-bearing: no fix site means the implementer gets
    // symptom ACs with no root cause. Flag it, do not discard it.
    expect(SPEC).toMatch(/UNGROUNDED|ungrounded/);
  });
});
