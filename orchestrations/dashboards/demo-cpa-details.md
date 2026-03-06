The file cpa-details.html is a locked template in the epam-cli project. You may ONLY change text/data within existing elements. You must NOT add, remove, or rearrange any HTML tags, CSS classes, or structural elements. If a section doesn't apply, leave the element empty — do not remove it. Regenerate the cpa-details.html in the demo project. This is to be ignored outside of a demo project.

Layout (Top down, left to right):
1. Header / Navigation: Sticky header and dashboard links for estimation/CPA docs.
2. Page Intro + Contents: Title, scope statement, and local table of contents.
3. 1. Two-Pass Pipeline: High-level formula pass plus CPA pass overview and command examples.
4. 2. Pass 1 — Formula Estimation: Detailed formula sections (effort inference, complexity, turns, tokens, cache, cost, uncertainty, calibration).
   - 2.1 Effort Tier Inference: humanHours → low/medium/high tier. Note: if story has aiProvider or model set, vendor pricing is resolved automatically from pricing.ts — use --force-effort-tier to override back to Haiku/Sonnet/Opus proxy.
   - 2.6 Cost Formula: Three-priority pricing chain: (1) story.model → pricing.ts exact rate, (2) story.aiProvider → provider default model → pricing.ts, (3) effort-tier proxy fallback. Subscription providers (copilot, cursor) emit $0.00. Vendor model rate table included (gpt-4.1, gemini-2.5-pro, qwen/qwen3-235b-a22b, deepseek/deepseek-r1, etc.).
5. 3. Pass 2 — Contextual Purveyor Agent: TF-IDF retrieval, inference payload, confidence blending, gate logic, and guardrails.
6. 4. Integration with CLI Commands: Command matrix for estimate/phase/orchestrate with relevant flags — includes --force-effort-tier on epam estimate and --provider copilot|openai|qwen|cursor on epam orchestrate. Workflow example updated with provider-scoped orchestration and what-if commands.
7. 5. Reference Constants: Default constants and tuning guidance for retrospective refinement.
