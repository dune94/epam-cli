# Forensic sweep — before the next pause-1 run

**Zero tokens spent.** Every finding below comes from static analysis or from replaying the
**real outputs the two dead AMSD-1919 runs actually produced**, through the **real** parser,
validator and contract code. Nothing here is hypothetical, and nothing is fixed — dev is frozen.

Two of my own earlier diagnoses were wrong and are corrected at the bottom.

---

## P1 — will affect the next pause-1 run

### 1. An unrecognised verdict is counted as a PASS *(mine, introduced today)*

`spec-mode-runner.js:4473`

```js
verdict: _results.some((r) => r.part.verdict === 'defects_found') ? 'defects_found' : 'sound',
```

`warn` is neither `defects_found` nor caught by the `_unexamined` check (which only tests
`nothing_to_review` or falsy) — so it silently becomes **`sound`**.

**This is not hypothetical.** Replaying the six real batch replies from the killed run:

| batch | verdict returned | findings |
|---|---|---|
| 1 | `defects_found` | 0 — evidence-free (already handled) |
| 2 | **`warn`** — not in the schema enum | 0 |
| 3 | `sound` | 0 |
| 4 | `defects_found` | 1 |
| 5 | **`undefined`** — no verdict at all | 0 |
| 6 | `defects_found` | 4 |

Batch 2's `warn` would be aggregated as a clean pass. I wrote this fail-open this morning while
fixing a different fail-open.

### 2. Four seams bind an output schema that is never validated

`lib/agent-output-schema.js` maps only six tags. Cross-referencing against tags actually used at
`runAgentForJson` call sites:

**Unvalidated: `ESTATE_SURVEY`, `PROJECT_AGENTS`, `ROSTER_REVIEW`, `ROLE_ASSIGNMENTS`**

For these, `validateTaggedOutput()` returns `ok: true` **whatever came back**. Proven directly:

```
validateTaggedOutput('ROSTER_REVIEW', {verdict:'warn', findings:[]})  -> {ok:true}
validateTaggedOutput('ROSTER_REVIEW', {findings:[]})                  -> {ok:true}   // no verdict
```

The validator also checks **types only** — `string`/`number`/`boolean`/`array` — and never an
`enum`, so even a mapped tag would accept `warn`. The enum in the tool schema is decorative.

Every one of those four seams runs before pause 1.

### 3. Six placeholders a caller can leave empty, not declared `mayBeEmpty`

Same class as the `__PREVIOUS_REFUSAL__` bug that killed run 1. In the pre-pause-1 path:

| template | placeholder | supplied by | risk |
|---|---|---|---|
| `ac-gate-codeline-assignment` | `__DESCRIPTION__` | `issue.description \|\| ''` | **real** — a ticket with no description fails ingest |
| `estate-survey` | `__CODELINE_BLOCK__` | `_named.map(...).join('\n')` | **real** if no codeline is named |
| `agent-name-refusal` | `__SHAPES__` | `allowed.map(...).join(' or ')` | **real** if the allowed set is empty |
| `ac-gate-codeline-assignment` | `__TITLE__` | `issue.title \|\| ''` | low — Jira always has a summary |
| `project-roster-review` | `__ROSTER_PATH__` | `String(rosterPath \|\| '')` | low — the mint always passes one |
| `project-roster-review` | `__CANONICAL_PATH__` | `String(canonicalPath \|\| '')` | low |

Checked against AMSD-1919's real ingested data: description present, gotransit named — so none
blocks *this* ticket. They block a different one.

---

## P2 — real, but after pause 1

### 4. `prd-change-reviewer` passes when it fails

`spec-mode-runner.js:8907` and its `catch`:

```js
return { verdict: m ? m[1] : 'pass', issues: [] };          // unparseable -> pass
...
console.warn(`... call failed ... — defaulting to pass`);
return { verdict: 'pass', issues: [] };                      // exception -> pass
```

A gate that passes on both unparseable output and its own exception.

### 5. A missing coordinator verdict is written to disk as `approved`

`spec-mode-runner.js:2183` — `verdict: review.verdict || 'approved'`, persisted into
`story.specification.coordinatorReview` and read later by other gates.

---

## Checked and NOT defects

- **`spec-mode-runner.js:4752`** — `findings.length ? 'defects_found' : 'sound'`. Flagged by the
  scanner, cleared on reading: the verdict is *derived* from findings precisely so a model cannot
  list defects and call the roster sound. Correct by design.
- **`spec-mode-runner.js:1853`** — `verdict === 'fail' ? 'reverted' : 'pass'` is a **log field**,
  not a gate decision. Mislabels an entry; lets nothing through.
- **`project-prompt-builder.js`** — uses direct string substitution, so the blank-payload guard
  cannot fire on it.
- **`roster-specialiser.log` returning prose** — expected; its deliverable is the file it writes.

---

## Corrections to my own earlier diagnoses

1. **"The batches were truncated mid-JSON."** Wrong. All six ended with complete, well-formed
   JSON. I read `tail -c 300` of a log that contains prompt *and* output and mistook the middle
   for the end.
2. **"The leading prose broke the parser."** Wrong. `extractTaggedJson` warns and repairs; three
   batches began with quoted persona text and still parsed.

**Consequence:** the five `maxOutputTokens` increases (changes 5–8, 12) were justified by a cause
that did not occur. They are defensible on their own terms — the roster artefact doubled, and the
reviewer quotes canonical *and* derived text — but the `_why_maxOutputTokens` notes I wrote into
the registry state truncation as the reason, and that is **factually wrong and should be
corrected**.

---

## What this sweep does not cover

It closes the classes I have *seen*. It cannot prove the absence of a class we have not met.
Specifically untested: anything after pause 1 in a live path, and whether the model's intermittent
malformed output has causes beyond those observed here.
