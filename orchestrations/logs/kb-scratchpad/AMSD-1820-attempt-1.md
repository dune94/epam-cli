CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below.

   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/create-reservations/create-reservations.mappers.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/process-order/process-zero-amount-order.service.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/submit-reservations/apply-report-discounts.service.ts (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/mappers/line-item/map-line-item-return-trip-modification.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/functions/http-mozio-webhook.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
---

Implement user story AMSD-1820: [Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation

## Story Description
[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation

## Acceptance Criteria
- 


## Root Cause Analysis & Prescribed Fix (AUTHORITATIVE — start here, do not re-trace)
A code investigation already traced this bug to its cause and prescribed the minimal fix below. This is the plan of record. Apply it; do NOT re-read the whole codebase to re-derive it.

The Acceptance Criteria above describe the desired END BEHAVIOR to VERIFY — they are NOT an implementation blueprint. Do not re-architect, split values, or add new fields/abstractions to satisfy an AC literally when the prescribed minimal fix already makes that AC pass. Implement the fix below; the ACs are how you check you got it right.

HARD RULES:
- Make the SMALLEST change that fixes the root cause. Fewer lines of code is always better.
- REUSE existing functions. Before writing any new helper, search the repo for an existing util/parser/formatter that already does what you need (use the CodeGraph tool documented below) and call it. Writing novel code when a helper already exists is a defect to be rejected in review.
- **src/services/submit-reservations/apply-report-discounts.service.ts** (`applyReportDiscountsService`): This function COMPUTES dispatch.report.price.discount — the promo amount that ends up in the Mozio email. The matching logic on lines 17–21 decides which discounts apply to which dispatch's line items. For return trips, the discount's lineItemId may carry the #return suffix (from getDispatchLineItemKey), but the dispatch line item may use the base ID — or vice versa — and the current two-condition check only handles one direction, causing return-trip discounts to be missed entirely.
  - **Minimal fix:** On lines 17–21, add a third OR condition using the existing parseDispatchLineItemKey helper to strip any #return suffix from discount.lineItemId before comparing. Change the filter to: lineItem.id === discount.lineItemId || lineItem.id === getDispatchLineItemKey(discount.lineItemId, true) || lineItem.id === parseDispatchLineItemKey(discount.lineItemId).id. Import parseDispatchLineItemKey from '~/services/helpers/order' (same module that already exports getDispatchLineItemKey). This covers the case where discount.lineItemId already has the #return suffix but the dispatch line item uses the base ID, which is the missing direction that causes return-trip promo amounts to not be matched and thus not computed into the report.

## Reviewer Feedback — ADDRESS THESE (a prior code review requested changes)
The team-lead reviewer examined your previous attempt and requested the changes below. This is the highest priority: make the SMALLEST edits that resolve each point. If a point says the change is over-engineered or a more concise change/existing helper would do, REMOVE the excess and use the minimal approach — do not add more code.
- [blocker] review-agent output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.

## Verification Criteria (what a tester will CONFIRM — your change must satisfy every one)
These are observable checks, derived from the acceptance criteria and description. They describe WHAT is observed, not how to build it. Make the minimal change that makes all of these true; your accompanying test should assert them:
- The behavior described in the ticket is observed to be correct after the change: "[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation".
- Existing behavior related to this area is unchanged (no regression).

## Tests are NOT your job this turn
A dedicated test-writer agent runs immediately after your fix commits and owns the bug-reproducing test. Do NOT write, edit, or create any test file (*.test.*, *.spec.*, __tests__/). Write ONLY the fix. Adding a test here wastes your turn budget and has caused repeated failures.

## The helper to reuse is ALREADY identified — do NOT search
The Root Cause Analysis above names the exact existing helper to reuse (`parseDispatchLineItemKey`). Do NOT run CodeGraph or explore the codebase to re-find it — that wastes your turn budget. Import it, apply the prescribed minimal fix, write your file(s), and stop. Only search if you hit something the prescribed fix genuinely does not cover.





## Technical Notes
- files: ["src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts","src/services/create-reservations/create-reservations.mappers.ts","src/services/process-order/process-zero-amount-order.service.ts","src/services/submit-reservations/apply-report-discounts.service.ts","src/services/mappers/line-item/map-line-item-return-trip-modification.ts","src/functions/http-mozio-webhook.ts"]

## Existing File Contents (injected once, deterministically — do NOT ReadFile these unless you need more than shown)

### /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/submit-reservations/apply-report-discounts.service.ts
```
import type { OrderLineItem } from '~/types/models/order';
import { PriceDiscountType } from '~/types/models/price';
import { getPreciseFloatNumber } from '~/utils/get-precise-float-number';

import type { PriceDiscount } from '../types';
import type { MozioDispatchPayload } from './types';

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

    if (discountsForDispatch.length === 0) {
      return;
    }

    const isAllDiscountsApplied = discountsForDispatch.every(
      (d) => d.amount.value === 0,
    );

    if (isAllDiscountsApplied) {
      return;
    }

    const currency = discountsForDispatch.at(0)?.amount.currency;

    if (!currency) {
      return;
    }

    dispatch.report.price.discount = dispatch.report.price.discount ?? {
      name: '',
      amount: {
        value: 0,
        currency,
      },
    };

    discountsForDispatch.forEach((discount) => {
      const currentSellingPrice = dispatch.report.price.selling.value;

      if (currentSellingPrice === 0 || discount.amount.value === 0) {
        return;
      }

      // making ts happy. This stuff is defined above
      if (!dispatch.report.price.discount) {
        return;
      }

      const appliedDiscountNames = dispatch.report.price.discount?.name;
      const discountedAmount = getPreciseFloatNumber(
        currentSellingPrice - discount.amount.value,
      );
      const remainingDiscount = Math.abs(Math.min(0, discountedAmount));

      const appliedDiscount = getPreciseFloatNumber(
        discount.amount.value - remainingDiscount,
      );

      dispatch.report.price.selling.value = getPreciseFloatNumber(
        Math.max(0, discountedAmount),
      );

      dispatch.report.price.discount.name = appliedDiscountNames
        ? `${appliedDiscountNames},${getDiscountName(discount)}`
        : getDiscountName(discount);

      dispatch.report.price.discount.amount.value = getPreciseFloatNumber(
        dispatch.report.price.discount.amount.value + appliedDiscount,
      );

      discount.amount.value = remainingDiscount;
    });
  });

  return mozioDispatches;
}

function getDiscountName(discount: PriceDiscount) {
  switch (discount.type) {
    case PriceDiscountType.AUTOMATIC:
      return `Auto:${discount.id}`;
    case PriceDiscountType.MANUAL:
      return 'Manual';
    case PriceDiscountType.CODE:
      return `Code:${discount.metadata.code}`;
  }
}

type LineItemDiscount = PriceDiscount & {
  lineItemId: string;
};

function getUniqDiscounts(lineItems: OrderLineItem[]): LineItemDiscount[] {
  const discountsMap: Record<string, LineItemDiscount> = {};

  lineItems.forEach((lineItem) => {
    const discounts = lineItem.prices.flatMap((p) => p.discounts);

    discounts.forEach((d) => {
      discountsMap[`${d.id + lineItem.id}`] = {
        id: d.id,
        lineItemId: lineItem.id,
        amount: d.amount,
        type: d.type,
        metadata: d.metadata,
      } as LineItemDiscount;
    });
  });

  return Object.values(discountsMap);
}
```

## Files to Create/Modify (EXACT ABSOLUTE PATHS — write to these paths exactly)
src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts, src/services/create-reservations/create-reservations.mappers.ts, src/services/process-order/process-zero-amount-order.service.ts, src/services/submit-reservations/apply-report-discounts.service.ts, src/services/mappers/line-item/map-line-item-return-trip-modification.ts, src/functions/http-mozio-webhook.ts

## Dependencies
None



## Instructions
CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below.
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/create-reservations/create-reservations.mappers.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/process-order/process-zero-amount-order.service.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/submit-reservations/apply-report-discounts.service.ts (content already injected below — do not ReadFile it unless you need lines beyond what's shown)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/services/mappers/line-item/map-line-item-return-trip-modification.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
   - /home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/src/functions/http-mozio-webhook.ts (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)
**The content of every file listed above is already shown in ## Existing File Contents — use that, do not spend a tool call re-reading them. Use Edit for targeted changes to existing files — do NOT overwrite an existing file wholesale with WriteFile.**

1. Use the injected ## Existing File Contents above to verify what actually exists (exports, types, existing utilities) before writing any code — do not guess, and do not re-read a file already shown in full
2. Implement all acceptance criteria for this story
3. Follow the project's existing code patterns and conventions
4. Do NOT create tests unless explicitly required in acceptance criteria

After implementation, provide a brief summary of what was created/modified.

## Relevant Knowledge Base Entries
The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:

- [2026-07-06T18:11:26Z] Use vi.fn().mockResolvedValue(value) to make a mock return a resolved Promise.
- [2026-07-06T20:31:11Z] Use `test: { passWithNoTests: true }` in vitest.config.ts or create a stub test file when no *.test.ts files exist.
- [2026-07-06T20:33:03Z] Enable globals:true in vitest.config.ts so describe, it, and expect work without imports, reducing boilerplate in test files.
- [2026-07-06T23:47:34Z] Use CommonJS-compatible patterns in src/server.ts: avoid `import.meta.url` and top-level `await`; gate listen with `if (require.main === module)`.
- [2026-07-07T02:35:30Z] Always include a non-test source file in src/ alongside any src/*.test.ts file, since tsconfig.json excludes test files from tsc --noEmit.
- [2026-07-07T19:01:34Z] Only modify or create files explicitly listed in the story's acceptance criteria. Do not touch files belonging to other stories or outside the current task scope.
- [2026-07-07T20:17:57Z] [unreviewed-fallback] Avoid using deprecated TypeScript compiler options like 'moduleResolution=node10'; use 'moduleResolution=node' instead.
- [2026-07-17T20:20:58Z] Always: Before importing a module or referencing a type/property, always read the actual source file to verify the export exists, its exact path, its properties, and its constructor/factory signatures
- [2026-07-23T01:15:16Z] Always: In tsconfig.json, always use moduleResolution 'node' (not 'node10' or 'Node10') — 'node10' was removed in TypeScript 5.x. The correct value for CommonJS + Node resolution is 'node'.
- [2026-07-23T14:30:00Z] CORRECTION to a prior entry (2026-07-23T01:17:52Z, now removed): that entry wrongly claimed 'moduleResolution: node' itself is removed and must become 'node16'/'nodenext'. Root-caused via mock1 (epam-cli orchestration test): 'node' is valid and correct through TypeScript 5.x (confirmed on 5.9.3) — it was only removed in TypeScript 7.x. The real defect was an unpinned `typescript` devDependency letting a fallback `npm install` pull latest (7.x) instead of the project's intended version. Do NOT rewrite a working tsconfig.json's moduleResolution in response to a TS5108 error — first check `node_modules/typescript/package.json`'s version; if it's 7.x and the rest of the project expects 5.x, the fix is pinning/reinstalling the correct typescript version, not changing moduleResolution.

## Knowledge Base Contribution (do this LAST — after writing all implementation files)
Your assigned KB entry ID for this run: **KB-014**

IMPORTANT: Write ALL implementation files first. Only AFTER writing every required file should you optionally append a KB entry.
Do NOT read orchestrations/agents/KB.md before writing implementation files. The relevant KB entries are already injected above.

If (and only if) you discover a non-obvious pattern during implementation, append one entry to `orchestrations/agents/KB.md`:

```markdown
## KB-014 -- 2026-07-25

**Category:** <backend|frontend|infrastructure|testing|orchestration>
**AgentRole:** <your agentRole from the story>
**Tags:** <comma-separated tech keywords, e.g. typescript, node, cli>
**Trigger:** <retry|first-success>
**StoryRef:** AMSD-1820

<One concise paragraph: the specific pattern, gotcha, or anti-pattern.>
```

Only write an entry if the knowledge is genuinely non-obvious. Skip trivial observations.