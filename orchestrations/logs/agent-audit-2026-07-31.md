# Full Agent Audit — epam-cli brownfield orchestration pipeline
Date: 2026-07-31. Scope: read-only source inspection + execution of EXISTING vitest tests only. No new live LLM calls made, no pipeline edits, no files changed.

## Roster confirmed
`orchestrations/agents/profiles.json` declares 51 roles. **28 are actually wired** (referenced from `claude.sh` / `run-agent-orchestration.sh` / `spec-mode-runner.js` beyond their own profile entry). The other 23 are confirmed **dead** — zero references anywhere outside `profiles.json` itself:
`agent-skills-agent, agent-systems-engineer, api-doc-generator, architecture-doc-agent, billing-engineer, changelog-agent, cli-ux-engineer, dashboard-orchestrator-agent, dashboard-test-agent, dashboard-update-agent, dedup-detector, doc-coordinator, doc-index-builder, doc-reviewer, doc-search-agent, doc-site-builder, docstring-agent, frontend-engineer, grooming-coordinator, guide-author, prd-project-manager-agent, project-initiator-agent, readiness-checker, spike-agent, ui-engineer`
(matches the pre-existing "Documentation Phase Not Wired" finding — this just confirms it's broader than just the doc-* set.)

## Verdict summary — 28 wired agents

| # | Agent | Verdict | One-line issue |
|---|---|---|---|
| 1 | code-graph-detective | CLEAN | Tool grant exactly matches prompt's grounding demands; 52/53 structural + real opt-in live test |
| 2 | openspec-agent | CLEAN | Tool-less by design, prompt never implies verification capability |
| 3 | speckit-agent | CLEAN | Prompt explicitly disclaims tool access (post-incident hardening); 126/126 pass |
| 4 | spec-coordinator-agent | CLEAN | Tool-less matches actual need (data pre-injected) |
| 5 | prd-model-coordinator | CLEAN* | *Uncapped tool grant (no EPAM_MAX_TOOL_CALLS) vs. every other gate agent — hygiene note only |
| 6 | **prd-change-reviewer** | **GAP-MISMATCH** | Prompt demands manifest/source verification; **zero tool access at both call sites**; live incident already occurred |
| 7 | spec-validator | GAP-LIVE | Correctly wired, but documented live incident of model self-reporting "untestable" instead of using tools |
| 8 | typescript-engineer | GAP-STRUCTURAL | Dead prompt instruction (hand-write contract) superseded by deterministic writer — misleading, harmless |
| 9 | test-engineer | CLEAN | Forces source-verification via prompt; budget/timeout tuned with documented root cause |
| 10 | tc-writer-agent | CLEAN* | *No EPAM_MAX_TOOL_CALLS budget — cost hygiene only, output is validated downstream |
| 11 | story-ac-remediator | CLEAN | Tools deliberately OFF, deterministic apply, tested |
| 12 | **generator** | GAP-STRUCTURAL | No execution-based test proves reduced iteration/token budget actually applies |
| 13 | retry-extension-coordinator | CLEAN | Deterministic pre-gate, fail-closed, no tool grant needed |
| 14 | profile-augmentor | CLEAN* | *No EPAM_MAX_TOOL_CALLS budget; disk-write independently verified, dual-gated (grounding + reviewer) |
| 15 | **team-lead-agent** | **GAP-MISMATCH** | Profile claims WriteFile capability the grant doesn't provide; describes a stale write mechanism (actual: deterministic apply) |
| 16 | review-agent | CLEAN | Real diff injection, tuned budget, fail-safe JSON extraction, most heavily regression-tested (92 tests) |
| 17 | **sast-sentinel** | **GAP-MISMATCH** | Static profile mandates grep-verification; runtime prompt forbids tool use on primary path |
| 18 | **review-ranger** | **GAP-MISMATCH** | Same contradiction as sast-sentinel |
| 19 | **mutant-hunter** | GAP-STRUCTURAL | Evidence silently truncated (100/60 lines) with no truncation marker, unlike siblings |
| 20 | fuzz-weaver | CLEAN | Best-verified gate in the pipeline — execution-based grounding, genuinely behavioral tests |
| 21 | **perf-sentinel** | GAP-STRUCTURAL | Grounding is self-consistency-only (not execution-verified) unlike sibling fuzz-weaver; untested |
| 22 | failure-analyst | CLEAN | Fixed this session; structural test passes, live test correctly present (creds-gated) |
| 23 | **test-coordinator-agent** | GAP-STRUCTURAL | **Phantom agent** — elaborate profile, never invoked as an LLM call anywhere |
| 24 | **kb-change-reviewer** | GAP-MISMATCH | One rejection rule (profile-compatibility check) references data never injected, no tool to fetch it |
| 25 | gate-finding-analyst | CLEAN* | *Two different mechanisms grant tools at its two call sites — works, but inconsistent (refactor risk) |
| 26 | **codeline-bridge-agent** | **GAP-STRUCTURAL (live-corroborated)** | Profile hard-requires ReadFile+WriteFile; invocation grants no tools under actual configured providers (qwen/openai); archived logs show the exact retry-burn signature this produces |
| 27 | playwright-agent | CLEAN | Same bug class already fixed 2026-07-08; structurally tested |
| 28 | lightpanda-agent | CLEAN | Same call path/fix/tests as playwright-agent |

**16 CLEAN, 5 GAP-MISMATCH, 6 GAP-STRUCTURAL, 1 GAP-LIVE.**

## Findings ranked by priority

### P0 — same bug class as the failure-analyst incident, currently live
1. **codeline-bridge-agent** (`run-agent-orchestration.sh:2446`, dispatched via `run_orch_prompt`). Profile requires the agent to read source files and `WriteFile` its output exactly once. `run_orch_prompt` never sets `AI_GATE_ALLOW_TOOLS` — under every tier3 script's actual configured gate provider (`qwen` or `openai`), `ai-run.sh` defaults to `--no-tools`. **Live-corroborated**: `orchestrations/logs/archive/pre-run-20260729T001545Z/agent-activity.jsonl` shows 3 consecutive cost entries for the same story/lane — the retry-burn signature of an agent told to WriteFile with no tool to do it. The purpose-built registry test (`agent-tool-access.test.ts`) that already caught this exact class for 6 other sites has **no entry for this call site** — it was never enumerated.
2. **prd-change-reviewer** (`claude.sh:4837` / `spec-mode-runner.js:4259`, both call sites). Prompt requires judging profile/TC additions against "the manifests, config and source actually present in THIS codeline" — zero tool access at either site. A live incident already occurred (rejected correct Contentstack advice for Metrolinx with no way to check the real stack — previously masked by a frozen stack/model allowlist that was itself removed this session as over-fitted). No test guards this specific gap. Bonus finding: the two call sites use inconsistent model-tier resolution (`claude.sh` honors `ESCALATION_MODEL_HIGH`, `spec-mode-runner.js`'s `buildGateExec` does not).

### P1 — could silently pass a wrong verdict or block a clean pipeline
3. **perf-sentinel** (`run-agent-orchestration.sh:8421`). Grounding check for a "fail" verdict only checks the agent's own JSON for internal self-consistency (`blockerCount>0 AND (filesAnalysed>0 OR blockerCount>0)`) — never confirms the claimed hotspot/leak actually exists in the named file/line. Its structural sibling fuzz-weaver (right next to it in the same file) instead *executes* the agent's own claimed test against real code before trusting a fail. An agent could hallucinate a self-consistent finding and incorrectly block the pipeline. The weaker path is also untested — only the "no structured output" case has a regression test.
4. **kb-change-reviewer** (`claude.sh:4837`, `change_type=kb_entry`). One of its rejection rules ("contradicts the agentRole's profile in profiles.json") references the target profile's text, which is never injected into its prompt and it has no tool to fetch it. It cannot meaningfully apply that specific rule — narrower in scope than the P0 items since its other rules are self-contained and correctly gated.

### P2 — documentation/prompt drift, currently mitigated but worth fixing
5. **team-lead-agent**. Profile text claims "full tool access (ReadFile, WriteFile, Bash...)" and describes updating `prd.json` directly — the actual grant excludes `write_file` and `EPAM_ALLOWED_WRITE_PATHS=""` is set deliberately; a prior incident (B18) moved to a safer deterministic-apply design, but the profile document was never updated to match. Not currently exploitable, but confusing for future maintenance and could mislead the model into attempting writes that silently go nowhere.
6. **sast-sentinel** / **review-ranger**. Both static profiles mandate a shell-grep self-verification workflow; both runtime prompts explicitly say "Do NOT attempt to call any shell commands, bash, or tools" on the primary attempt (only flipping to allow tools on retry). Mitigated today by real pre-injected oracle data (Semgrep/npm-audit/tsc for sast-sentinel, real git diff for review-ranger) and grounded verdict parsing — but the documented workflow is currently unreachable, which will confuse the next person who reads the profile expecting it to match the prompt.
7. **mutant-hunter**. Source/test evidence is silently capped (100 lines/file, 60 lines/test) with no truncation marker — unlike review-ranger's diff injection, which explicitly appends a `[TRUNCATED — N total lines...]` notice. A file whose relevant logic sits past line 100 is invisible to the agent with no signal anything was cut.

### P3 — coverage/hygiene only, no live incident, low severity
8. **test-coordinator-agent** — phantom profile, never invoked; dead weight, not a functional risk since nothing depends on it.
9. **typescript-engineer** — dead "hand-write the contract scratchpad" prompt instruction, superseded by a deterministic writer; misleading but harmless.
10. **generator** — intentional zero-context design is untested at the execution level (no test proves the reduced maxIter=3/16384-token budget actually takes effect).
11. Cost-hygiene-only notes (no functional impact): **tc-writer-agent**, **profile-augmentor**, and **prd-model-coordinator** all hold tool access with no `EPAM_MAX_TOOL_CALLS` budget, unlike sibling gate agents that received one after a documented cost incident. **gate-finding-analyst** achieves its (correct) tool grant via two different mechanisms at its two call sites — works today, refactor-fragile.

## What was explicitly NOT found
None of the 28 wired agents reproduced the *exact* failure-analyst shape (zero tools + prompt that assumes verification capability + no test coverage at all) — that specific class has clearly already been hunted down once (`agent-tool-access.test.ts` exists for exactly this purpose) and mostly holds. The residual gaps are narrower variants: one true repeat of the pattern that was simply never enumerated in the registry (codeline-bridge-agent), one long-standing case the registry never covered (prd-change-reviewer), and several verdict-integrity/documentation-drift issues that are a different but related class (self-consistency-only grounding, stale profile text, silent truncation).

## Recommended next step
Given the standing instruction not to add new complexity before one clean run — these are audit findings, not yet fixes. Suggest tackling in priority order: codeline-bridge-agent and prd-change-reviewer first (P0, same class as an incident already paid for once), since either could plausibly be contributing to the zero-clean-runs state directly.

---

# POST-FIX RE-AUDIT (same day, 2026-07-31)

All fixes below were applied and verified: `tsc --noEmit` clean, full `vitest run` — 6322 passed, 1 pre-existing unrelated failure (`metrolinx-preflight.test.ts`, a leftover uncommitted change in the gotransit worktree from an earlier killed run — not touched by any of this work).

The re-audit was run as 4 fresh, independent background agents using the SAME methodology as the original audit, explicitly instructed not to trust the prior verdicts. Verdict changes:

| Agent | Before | After |
|---|---|---|
| codeline-bridge-agent | GAP-STRUCTURAL (live-corroborated) | **CLEAN** |
| prd-change-reviewer | GAP-MISMATCH | **CLEAN** |
| kb-change-reviewer | GAP-MISMATCH | **CLEAN** |
| perf-sentinel | GAP-STRUCTURAL | **CLEAN** |
| typescript-engineer | GAP-STRUCTURAL | **CLEAN** |
| generator | GAP-STRUCTURAL | **CLEAN** |
| team-lead-agent | GAP-MISMATCH | **CLEAN*** |
| sast-sentinel | GAP-MISMATCH | **CLEAN*** |
| review-ranger | GAP-MISMATCH | **CLEAN*** (grounding gap below still open) |
| mutant-hunter | GAP-STRUCTURAL (truncation) | **CLEAN*** (truncation fixed; grounding gap below still open) |
| test-coordinator-agent | GAP-STRUCTURAL | GAP-STRUCTURAL (unchanged by design — disclosed, not removed) |
| spec-validator | GAP-LIVE | GAP-STRUCTURAL (same underlying finding, re-labeled by the fresh auditor — model-reliability risk, mitigated not eliminated) |
| gate-finding-analyst | CLEAN | CLEAN (dual-mechanism inconsistency now has an explanatory comment + regression test) |
| review-agent, fuzz-weaver, code-graph-detective, openspec-agent, spec-coordinator-agent, prd-model-coordinator, test-engineer, tc-writer-agent, story-ac-remediator, retry-extension-coordinator, profile-augmentor, failure-analyst, playwright-agent, lightpanda-agent | CLEAN | CLEAN (unchanged, independently re-confirmed) |

*\*CLEAN after a critical cross-cutting fix described below — the re-audit's most important finding.*

### Critical finding: `profiles.json.original` was missed

Two of the four re-audit batches independently caught the same thing: `orchestrations/scripts/orchestrate.sh` and every `tier3-*-run.sh` script unconditionally `cp profiles.json.original profiles.json` at the start of every run (the standing "restore canonical base state every run" design). The original fix pass updated `profiles.json` and `profiles.canonical.json` but never touched `profiles.json.original` — so team-lead-agent's WriteFile claim, sast-sentinel/review-ranger's unconditional shell-verification mandate, typescript-engineer's dead contract instruction, and test-coordinator-agent's phantom-role disclosure would all have been **silently reverted on the very next live run**. `profiles-canonical.test.ts` only checks key-set presence, not content, so this was invisible to the existing suite.

**Fixed**: all 5 profile-text fixes applied to `profiles.json.original` too. New test `test/unit/orchestration/profiles-original-restore-source.test.ts` (9 tests) asserts content-sync across all three files for the keys touched today, and would have failed loudly under the pre-fix state (mutation-verified).

### New findings surfaced by the re-audit (not part of today's original fix set — backlog, not fixed)

1. **speckit-agent — GAP-MISMATCH (new)**: its VC-review role (`reviewVcViaSpeckit`) routes through `_vcLlmCall`, which resolves `SPEC_MODE_OPENSPEC_MODEL_HIGH`/`ESCALATION_MODEL_HIGH` — **openspec's** model family, not speckit's own (`SPEC_MODE_SPECKIT_MODEL*`). Separately, `validateMidExecutionSplits` reads `speckitResult.payload.splitStories`, but speckit's own prompt permanently forbids ever returning that field (a documented, deliberate rule after a live AMSD-2041 incident) — a dead code path with existing test coverage explicitly noting it's untested by real execution.
2. **review-ranger — GAP-ENFORCEMENT (new)**: unlike sast-sentinel (real Semgrep/tsc/npm-audit oracle) and the now-fixed perf-sentinel (codeSnippet verified against the real file), review-ranger's fail-verdict enforcement is a bare `grep -q '"verdict":"fail"'` on the agent's own self-reported output — nothing confirms any named `file`/`line` in its findings actually exists. The real git-diff evidence fed in is real; nothing stops the agent from citing a plausible but fabricated file:line and still blocking the pipeline.
3. **mutant-hunter — GAP-ENFORCEMENT (new, distinct from the truncation fix)**: same shape as review-ranger — `mutationScore`/kill-count are entirely self-reported with no independent verification.
4. **profile-augmentor — GAP-PERSISTENCE (new)**: any `## Self-Healing Addendum` rule it writes to `profiles.json` mid-run is wiped by the same canonical-restore mechanism at the start of the *next* run — this is the accepted, documented tradeoff behind "Profiles: Canonical Base State Every Run," not a new bug, but the re-audit is the first time it was connected explicitly to this specific agent's stated goal ("preventively warn future story agents").
5. **profiles.canonical.json — broader pre-existing drift (new)**: several keys unrelated to today's fixes (typescript-engineer, test-engineer, review-agent, prd-project-manager-agent, spike-agent, story-ac-remediator, profile-augmentor) differ substantially between `profiles.json` and `profiles.canonical.json` — e.g. canonical's typescript-engineer entry is a much shorter, older version of the whole profile, not just a wording difference. Out of scope for this pass; flagged for separate cleanup.

None of these 5 are fixed yet — recommend treating #1-#3 (review-ranger/mutant-hunter enforcement gaps, speckit model-tier mismatch) as the next priority tier, since they're the same class of "self-reported verdict trusted without grounding" defect already fixed once for perf-sentinel and fuzz-weaver.

---

# ROUND 2: review-ranger + mutant-hunter grounding, canonical.json drift sync, speckit-agent fix (2026-07-31, same day)

Fixed in order: (1) review-ranger enforcement grounding, (2) mutant-hunter enforcement grounding, (3) profiles.canonical.json content-drift sync (7 keys), plus the speckit-agent model-tier + dead-code-path fix from the prior request. Full suite re-verified after each: `tsc --noEmit` clean, 6342 passing throughout, same one pre-existing unrelated failure (`metrolinx-preflight.test.ts`).

**review-ranger**: fixed. Schema now requires a `codeSnippet` field per blocker finding; enforcement (`run-agent-orchestration.sh`) verifies it's a literal substring of the real file on disk before trusting a fail verdict — same pattern as perf-sentinel. `test/unit/orchestration/review-ranger-codesnippet-grounding.test.ts` (5 tests, mutation-verified).

**mutant-hunter**: fixed. Schema now requires `originalCode` per survived mutation; enforcement requires (a) `summary.survived` count agrees with the actual count of `status:survived` entries (self-consistency) AND (b) at least one survived mutation's `originalCode` verified against the real file. `test/unit/orchestration/mutant-hunter-grounding.test.ts` (5 tests, mutation-verified).

**profiles.canonical.json drift**: fully synced — every key present in `profiles.json` is now byte-identical in `profiles.canonical.json` (confirmed: `profiles.json` matched `profiles.json.original` for all 7 drifted keys, so canonical was the stale one). `profiles-original-restore-source.test.ts` updated to assert full key-set content equality, not a scoped subset (mutation-verified).

**Incidental bug found and fixed during this round**: `perf-sentinel-codesnippet-grounding.test.ts`'s python-extraction anchor was too generic (`'log_file, project_root = ...'`) and, once review-ranger's near-identical grounding block was added nearby in the same file, started extracting the WRONG block — a real test-only bug (the shipped shell script was never at risk; its extraction used a specific `re.search` per agent name). Fixed by anchoring all three extraction helpers on their own agent-specific string.

**Full 4-batch re-audit (round 2) results:**
- review-ranger: GAP-ENFORCEMENT → **CLEAN**, independently re-verified in code and via test.
- mutant-hunter: GAP-ENFORCEMENT → **CLEAN**, independently re-verified.
- speckit-agent (from the earlier request): both fixes (role-aware model-tier resolution, `refineExistingChildren` closing the dead code path) confirmed landed and functioning end-to-end, with `speckit-model-tier-and-child-refinement.test.ts` (10 tests) passing.
- All other 25 agents: unchanged from round 1 — no regressions from either fix batch.
- spec-validator, test-coordinator-agent: still GAP-STRUCTURAL, as intended (mitigated risk / disclosed design, not defects to fix).

**New finding, not previously caught (3 independent sub-agents converged on it):** `profiles.canonical.json` is missing **7 keys entirely** — `code-graph-detective`, `codeline-bridge-agent`, `failure-analyst`, `kb-change-reviewer`, `prd-change-reviewer`, `prd-model-coordinator`, `retry-extension-coordinator` — a *different* set from the 7 keys with drifted *content* that were just synced. Confirmed non-functional: no `tier3-*-run.sh`/`orchestrate.sh` script reads `profiles.canonical.json` at runtime; all restore from `profiles.json.original`, which has all 7 keys correct. But both sync tests (`profiles-canonical.test.ts`, `profiles-original-restore-source.test.ts`) only flag a mismatch for keys present in *both* files — a key's total absence from canonical is silently skipped, never asserted. This is a real test blind spot, not yet fixed. Recommended next: add a canonical-completeness assertion (every `profiles.json` key must exist in `profiles.canonical.json`, not just match where present) and backfill the 7 missing keys.
