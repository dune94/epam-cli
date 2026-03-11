# Run-Agent-Orchestration Failover Plan

## Objective
Ensure `orchestrations/scripts/run-agent-orchestration.sh` can anticipate token-usage outages for any configured provider/model and seamlessly switch queued or running work to an approved backup without losing session context.

## References
- Provider/model metadata stories: `orchestrations/prd.json:1530-1651`, `phasesConfig` defaults at `orchestrations/prd.json:3281-3320`.
- Cutover policy story EPAM-029: `orchestrations/prd.json:1716-1754`.
- Execution flow touchpoints: `orchestrations/scripts/run-agent-orchestration.sh` (CPA stage 222-259, planning 286-355, worktree launch 356-587, cost sync 601-676, summaries 885-929).
- Provider wrapper mapping: `run-agent-orchestration.sh:20-28` and `orchestrations/scripts/claude.sh:44-139`.

## Plan
1. **Per-Story Provider Tuples**  
   - Extend the execution-plan phase so every queued story stores `{primary_provider, primary_model, backup_provider, backup_model}` derived from (a) explicit story overrides, (b) `phasesConfig` defaults, and (c) a new `configuration.aiRuntime.providerPolicies` block that lists legal fallback chains and token ceilings per provider/model.  
   - Materialize this map immediately after the existing jq filters (around lines 286-347) so downstream steps can consult `story_provider_plan[$story]`.

2. **Token Quota Forecast**  
   - Insert a pre-flight budget step between the CPA pass and Step-1 execution loop (≈ lines 222-355).  
   - Aggregate `phase-cost.jsonl` plus any provider telemetry emitted by wrappers (e.g., `normalize_provider_json` in `claude.sh`).  
   - Compare rolling totals to the ceilings in `providerPolicies[*].tokenCeiling` (support env overrides) and emit WARN/BLOCK statuses, pre-staging reallocations by running `provider-cutover.sh` in report mode to surface which stories would move first (aligned with EPAM-029 acceptance criteria).

3. **run_with_token_guard Helper**  
   - Wrap each `CLAUDE_SH` invocation (sequential runs ~519-520 and both worktree launches 549-587) with a helper that: (a) executes the story under the primary provider, (b) tails the per-story JSONL cost output, (c) updates an in-memory ledger, and (d) classifies the status (OK / nearing limit / exhausted).  
   - When the helper detects a token-limit exit code or ledger overflow, it looks up the backup tuple and immediately retries with `EPAM_ORCHESTRATION_PROVIDER` / `MODEL_OVERRIDE` pointing to the backup. Because provider selection already funnels through the wrapper mapping, the retry path works uniformly for codemie-claude, copilot, openai, qwen, cursor, claude, etc.

4. **Shared Ledger + Cutover Automation**  
   - Before launching parallel worktrees (lines 356-403), persist the provider plan and ledger to `logs/agent-status.json`.  
   - When a guard escalates to "provider exhausted," emit a monitor event via `update-monitor.sh` (mirror the CPA events at 244-259), then call `provider-cutover.sh --from <primary> --to <backup> --phase $PHASE --apply` so remaining queued stories respect the canonical PRD decisions.  
   - Both primary and worktree processes should watch for a sentinel file such as `$LOG_DIR/provider-failover.json` to pick up updated provider/model assignments before starting their next story.

5. **Observability & Reporting**  
   - Enhance the post-run cost sync (lines 601-676) and final summaries (885-929) to include ceilings vs. actuals, number of automatic failovers, and the stories re-run under backups.  
   - Annotate each failover event in `phase-cost.jsonl` (e.g., `notes[]=token_failover`) so FinOps and auditing flows can trace when and why provider switches occurred.  
   - Feed the aggregated data into the dashboards targeted by EPAM-027 (provider/model visibility).

## Notes
- This plan keeps failover context in-process. For cross-process continuity (e.g., if future work distributes stories to fresh workers), reuse the CLI session export/import helpers plus Redis SessionStore hooks described in `src/context/RedisSessionStore.ts` and `src/cli/repl` commands.
- Document new env vars (token ceilings, backup chains) in `CLAUDE.md` or an ops runbook so platform teams can manage provider quotas consistently across orchestration and CLI flows.
