The file cpa-details.html is a locked template in the epam-cli project. You may ONLY change text/data within existing elements. You must NOT add, remove, or rearrange any HTML tags, CSS classes, or structural elements. If a section doesn't apply, leave the element empty — do not remove it. Regenerate the cpa-details.html in the demo project. This is to be ignored outside of a demo project.

Layout (Top down, left to right):
1. Header / Navigation: Sticky header and dashboard links for estimation/CPA docs.
2. Page Intro + Contents: Title, scope statement, and local table of contents (7 top-level sections).
3. 1. Two-Pass Pipeline: High-level formula pass plus CPA pass overview and command examples.
4. 2. Pass 1 — Formula Estimation: Detailed formula sections (effort inference, complexity, turns, tokens, cache, cost, uncertainty, calibration).
   - 2.1 Effort Tier Inference: humanHours → low/medium/high tier. Note: if story has aiProvider or model set, vendor pricing is resolved automatically from pricing.ts — use --force-effort-tier to override back to Haiku/Sonnet/Opus proxy.
   - 2.6 Cost Formula: Three-priority pricing chain: (1) story.model → pricing.ts exact rate, (2) story.aiProvider → provider default model → pricing.ts, (3) effort-tier proxy fallback. Subscription providers (copilot, cursor) emit $0.00. Vendor model rate table included (gpt-4.1, gemini-2.5-pro, qwen/qwen3-235b-a22b, deepseek/deepseek-r1, etc.).
5. 3. Pass 2 — Contextual Purveyor Agent: TF-IDF retrieval, inference payload, confidence blending, gate logic, and guardrails.
6. 4. Integration with CLI Commands: Command matrix for estimate/phase/orchestrate with relevant flags — includes --force-effort-tier on epam estimate and --provider copilot|openai|qwen|cursor on epam orchestrate. Workflow example updated with provider-scoped orchestration and what-if commands.
7. 5. Provider Layer (NEW): Documents the multi-provider orchestration architecture.
   - 5.1 Provider Routing: EPAM_ORCHESTRATION_PROVIDER env var routes to copilot.sh/openai.sh/qwen.sh/cursor.sh, each a thin wrapper execs claude.sh. provider_to_cli() table showing all 6 provider mappings. EPAM_CLI variable (default: epam) as the injection point.
   - 5.2 Per-Story aiProvider & model Fields: How aiProvider drives execution routing and cost estimation. resolve_model_from_story() reads .model from prd.json for epam-run providers, overrides effort-tier default.
   - 5.3 Cost Normalization: epam run --json camelCase output mapped to snake_case orchestration schema (cost_usd→total_cost_usd, inputTokens→input_tokens, outputTokens→output_tokens). Raw file preserved alongside normalized file.
   - 5.4 Story Selection Rules: Execution mode filters completed==false only (no status string check). Estimate mode has no filter (all stories). Dry-run applies same filter as execution but skips work. Infra test gate documented.
   - 5.5 Zero-Token Testing: EPAM_CLI=mock-epam-run.sh intercepts all epam-run calls. 19/19 tests pass with zero tokens. Mock logs --provider/--model for assertion.
8. 6. Reference: Default Constants (formerly section 5): Constant cards grid unchanged.
