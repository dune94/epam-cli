#!/usr/bin/env bash
# mint-and-spec.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (12 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

resolve_prompt_provider() {
    if [ -n "${EPAM_ORCHESTRATION_PROVIDER:-}" ]; then
        echo "$EPAM_ORCHESTRATION_PROVIDER"
        return
    fi
    case "$(basename "$CLAUDE_CMD")" in
        codex|openai|openrouter|cursor|copilot|codemie-claude) echo "$(basename "$CLAUDE_CMD")" ;;
        *) echo "claude" ;;
    esac
}

# GAP-P22: emit a cost record for a pipeline agent invocation.
# Args: agent_type, story_id, model, started_at, cost_usd, tokens_in, tokens_out, turns
# _spec_pass_usage <phase_id>
# Prints "<cost> <tokens_in> <tokens_out> <turns>" for the spec runner's own
# LLM calls in this phase.
#
# spec-mode-runner wires emitCostSnapshot through runClaude — the funnel for the
# detective, openspec, speckit, the spec coordinator, the VC reviewer and the
# PRD change reviewer — so every one of those calls already lands in
# agent-activity.jsonl tagged source="spec-mode-runner". The spec-pass row in
# phase-cost.jsonl was nevertheless written with literal zeros, so the ledger
# every reader sums (dashboard, run report, validate-dashboards.sh) understated
# the run by $0.1077 on gotransit (22%) and $0.0755 on upexpress, measured
# 2026-07-30. Cost tracking that silently reports zero is worse than none: a
# reader cannot tell "free" from "unmeasured".
#
# Filtered on source, NOT on agent name: typescript-engineer and team-lead-agent
# write their own phase-cost rows, so summing them here would double-count the
# run. Overstating is no more true than understating.
#
# Fails soft to zeros — a cost record must never be the thing that breaks a run.
_spec_pass_usage() {
    local _phase="${1:-}"
    local _act="${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}"
    if [ ! -f "$_act" ]; then printf '0 0 0 0\n'; return 0; fi
    # -R (raw) + fromjson? so ONE malformed line cannot void the whole file.
    # Lanes append concurrently, so a torn write is realistic; jq -s would abort
    # on it and silently report zero — the exact failure this function exists to
    # end.
    jq -rRs --arg ph "$_phase" '
        [ (split("\n") | .[] | select(length > 0) | fromjson? // empty)
          | select(type == "object")
          | select(.type == "cost_snapshot")
          | select((.detail.source // "") == "spec-mode-runner")
          | select(($ph == "") or ((.phase // "") == $ph))
          | .detail ]
        | [ (map(.costUsd // 0) | add // 0),
            (map(.tokensIn  // 0) | add // 0),
            (map(.tokensOut // 0) | add // 0),
            (map(.turns     // 0) | add // 0) ]
        | @tsv' "$_act" 2>/dev/null | tr '\t' ' ' || printf '0 0 0 0\n'
}

append_pipeline_cost_record() {
    local agent_type="${1:-pipeline}" story_id="${2:-pipeline}"
    local model="${3:-}" started_at="${4:-}" ended_at
    ended_at=$(date -Iseconds)
    local cost="${5:-0}" tokens_in="${6:-0}" tokens_out="${7:-0}" turns="${8:-0}"
    local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"
    local phase_id="${CURRENT_PHASE:-${PHASE:-unknown}}"
    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg pid  "$phase_id" \
            --arg sid  "$story_id" \
            --arg at   "$agent_type" \
            --arg rm   "$model" \
            --arg sa   "$started_at" \
            --arg ea   "$ended_at" \
            --argjson cu  "${cost:-0}" \
            --argjson ti  "${tokens_in:-0}" \
            --argjson to  "${tokens_out:-0}" \
            --argjson tt  "${turns:-0}" \
            '{phase_id:$pid, story_id:$sid, agent_type:$at, resolvedModel:$rm,
              started_at:$sa, ended_at:$ea, task_cost_usd:$cu,
              task_tokens_in:$ti, task_tokens_out:$to, task_turns:$tt,
              status:"completed", invokeMode:"cli"}' >> "$cost_file"
    ) 200>"$lock_file"
}

# ── The agent mint ────────────────────────────────────────────────────────────
# EVERY PROJECT MINTS ITS OWN AGENTS, however its PRD arrived.
#
# This lived inside _run_jira_pipeline, so a project whose PRD is authored never reached it and ran
# on the canonical base roster — epam-cli's own first-commit agents, which is the exact failure the
# mint was built to end. It also meant no role assignment, no project prompt library and no
# prompt-agent-link, so a project declaring EPAM_PROMPT_PROVISION_MODE=generate exercised none of
# that path.
#
# Same shape as codeline discovery, which was also reachable only from the Jira branch: a
# capability every project needs cannot live behind the branch only some projects take.
#
#   $1 — the PRD to mint against
#   $2 — the log file to tee into
_run_agent_mint() {
  local _prd="$1" _log="${2:-/dev/null}"

  # THE SCAFFOLD PHASE, first. It carries no implementation stories; its only job is to make the
  # phase loop fire the pre-phase skill assessment over every story, so each agent's profile gains
  # this project's skills before any implementation begins. Without it that assessment never runs
  # and every agent works without them.
  #
  # It lived inside the Jira branch, so a project with an authored PRD never got one — the same
  # shape as the mint itself and as codeline discovery. Paired with the mint here because both
  # prepare the roster's working conditions and both are needed by every project.
  # Guarded so an unloaded library is skipped rather than fatal: an undefined function
  # returns 127, and `|| exit 1` on that silently killed the enclosing block wherever a
  # harness runs this code with the gate library absent. The orchestrator sources it at the
  # top, and pre-flight is what actually gates a run.
  declare -f require_stage_coverage >/dev/null && { require_stage_coverage ingest || exit 1; }
  if "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/run-jira-pipeline.js" "$_prd"; then
    log "[mint] Scaffold phase present for the pre-phase skill assessment"
  else
    error "[mint] could not inject the scaffold phase into ${_prd} — the pre-phase skill"
    error "[mint] assessment would not run, so every agent would work without this project's skills."
    return 1
  fi

  # A CODELINE THAT IS ALREADY PROVISIONED IS NOT RE-MINTED.
  #
  # Operator, 2026-09-06: "mint should not run nor prompt builder".
  #
  # THE DECISION IS HERE, IN BASH, and that is the whole point of this block sitting where it does.
  # A first attempt set EPAM_SKIP_AGENT_MINT inside mint-agents-step.js — a CHILD of the gate
  # below, spawned only after that gate has already decided and logged "Minting project agents".
  # A child cannot change the mind of the parent that spawned it. It was covered by twelve green
  # tests that lifted the child's guard and ran it directly: they proved a value is computed and
  # could not observe the decision. The live run said MINTING=1.
  #
  # The signal is the one pre-run-reset and the prompt builder already trust:
  # .prompt-cache/.complete-<codeline>, written only after every prompt installed, named for the
  # codeline, and cleared whenever provisioning restarts. Prompts must also actually be on disk —
  # a marker beside an empty directory would skip the mint and leave the run with no prompts.
  # THE CODELINE IS DETECTED, NEVER PRESET.
  #
  # Operator, 2026-09-06: "code line is detected in a live run ... this var will never be preset in
  # a live run." EPAM_CODELINE_ID is READ in six places in this repo and SET in none — no launcher,
  # config file or env file exports it. Gated on it alone, this test built the path
  # `.complete-` on every live run, matched nothing, and the mint ran and was PAID FOR every time
  # while the reuse machinery reported itself as working. A gate that cannot fire is worse than no
  # gate: it is a saving that appears in the log and never in the bill.
  #
  # The PRD holds the run's resolved scope by the time the mint is reached — synthesize-prd-from-
  # jira.js writes project.outputDirs and project.outputDir, and the mint is invoked with that PRD
  # ($1). Those are the fields lib/codeline-scope.sh already treats as the run's scope, so both
  # sides of the engine answer "which codeline?" from the same place.
  #
  # EXACTLY ONE, or nothing: a run scoped to two codelines produces assets specialised for both,
  # and claiming either would hand the other's run a set built for a repository it is not in.
  local _detected_cl="${EPAM_CODELINE_ID:-}"
  if [ -z "$_detected_cl" ] && [ -n "${1:-}" ] && [ -f "${1:-}" ] && command -v jq >/dev/null 2>&1; then
      _detected_cl=$(jq -r '
          [ (.project.outputDirs // [])[]?.path,
            (.project.outputDir // empty) ]
          | map(select(type == "string" and . != "") | sub("/+$"; "") | split("/") | last)
          | unique
          | if length == 1 then .[0] else empty end
      ' "$1" 2>/dev/null || true)
  fi

  # SETTLE WHAT pre-run-reset COULD NOT DECIDE.
  #
  # The reset runs from the launcher, before discovery, so it cannot know which codeline the run is
  # for. Rather than guess — and destroy a completed codeline's roster, registries and prompts on
  # every live run — it defers and leaves `.prompt-cache/.reset-pending` behind. This is the first
  # point the decision can be taken correctly: discovery has persisted the scope, both call paths
  # reach here, and no profile has been generated yet.
  #
  # THE CLEAN SLATE IS NOT WEAKENED, only correctly timed. Anything unproven still clears: another
  # codeline's marker, no codeline resolved, two codelines resolved, or the override. And exactly
  # what pre-run-reset clears is cleared here — never more, or this becomes a second, divergent
  # clean-slate policy that nothing reconciles.
  local _pending="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/.prompt-cache/.reset-pending}"
  if [ -n "$_pending" ] && [ -f "$_pending" ]; then
    if [ "${EPAM_REGENERATE_CODELINE_ASSETS:-0}" != "1" ] \
       && [ -n "$_detected_cl" ] \
       && [ -f "$EPAM_PROJECT_CONFIG_DIR/.prompt-cache/$(prompt_marker_key "$_detected_cl")" ]; then
      log "[mint] deferred decision settled: ${_detected_cl} completed its agents and prompts — kept"
    else
      log "[mint] deferred decision settled: this run is not ${_detected_cl:-<unresolved>}'s completed codeline — clearing the previous run's agents and prompts"
      rm -f "$EPAM_PROJECT_CONFIG_DIR/roster.json" \
            "$EPAM_PROJECT_CONFIG_DIR/project-roles.json" \
            "$EPAM_PROJECT_CONFIG_DIR/project-investigators.json" \
            "$EPAM_PROJECT_CONFIG_DIR/agent-profiles.json" 2>/dev/null || true
      rm -rf "$EPAM_PROJECT_CONFIG_DIR/prompts" 2>/dev/null || true
      mkdir -p "$EPAM_PROJECT_CONFIG_DIR/prompts" 2>/dev/null || true
    fi
    rm -f "$_pending" 2>/dev/null || true
  fi

  if [ "${EPAM_SKIP_AGENT_MINT:-0}" != "1" ] \
     && [ "${EPAM_REGENERATE_CODELINE_ASSETS:-0}" != "1" ] \
     && [ -n "$_detected_cl" ] && [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] \
     && [ -f "$EPAM_PROJECT_CONFIG_DIR/.prompt-cache/$(prompt_marker_key "$_detected_cl")" ] \
     && ls "$EPAM_PROJECT_CONFIG_DIR/prompts/"*.json >/dev/null 2>&1; then
      log "[mint] codeline ${_detected_cl} is already provisioned — the mint is skipped; EPAM_REGENERATE_CODELINE_ASSETS=1 forces a re-mint"
      EPAM_SKIP_AGENT_MINT=1
  fi

  # SKIPPING THE MINT REQUIRES A ROSTER TO SKIP TO. Travels with the mint rather than sitting in
  # one caller, so the other path cannot skip into nothing.
  if [ "${EPAM_SKIP_AGENT_MINT:-0}" = "1" ]; then
    local _roster_file="${EPAM_AGENTS_DIR}/profiles.json" _roster_n=0
    [ -s "$_roster_file" ] && _roster_n=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/roster-size.js" "$_roster_file" 2>/dev/null || echo 0)
    if [ "${_roster_n:-0}" -lt 1 ]; then
      error "[mint] EPAM_SKIP_AGENT_MINT=1 but no minted roster exists at ${_roster_file}."
      error "[mint] Skipping the mint now would hand every story to an agent that was never defined."
      return 1
    fi
    log "[mint] Agent mint skipped (EPAM_SKIP_AGENT_MINT=1) — using the roster on disk (${_roster_n} agent(s))"

    # BUT THE PROJECT ROSTER IS STILL DERIVED. Skipping the mint means "invent no new agents"; it
    # has never meant "run with no identities". Every launch resets, and a writer-style resume
    # skips the mint on purpose, so without this a resumed run would reach its first seam with no
    # persona for it — and there is no engine roster to fall back to any more.
    #
    # Roster-only: no survey, no proposals, no role assignment. Just canonical -> this project.
    # Guarded so an unloaded library is skipped rather than fatal: an undefined function
    # returns 127, and `|| exit 1` on that silently killed the enclosing block wherever a
    # harness runs this code with the gate library absent. The orchestrator sources it at the
    # top, and pre-flight is what actually gates a run.
    declare -f require_stage_coverage >/dev/null && { require_stage_coverage mint || exit 1; }
    log "[mint] Deriving this project's roster (roster-only — nothing is minted)..."
    EPAM_ROSTER_ONLY=1 EPAM_SKIP_AGENT_MINT=1 "$NODE_BIN" "$SCRIPT_DIR/mint-agents-step.js" \
        --prd "$_prd" \
        --agents-dir "$EPAM_AGENTS_DIR" \
        --log-dir "$LOG_DIR" \
        --codeline-root "${PROJECT_ROOT:-}" 2>&1 | tee -a "$_log"
    # PIPESTATUS[0], not the pipeline status: without pipefail this reads tee's, and a roster the
    # agent never produced would pass as one it did.
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then
        error "[mint] roster derivation FAILED — refusing to continue with agents that have no identity."
        return 1
    fi
  fi
  [ "${EPAM_SKIP_AGENT_MINT:-0}" = "1" ] || {
    log "[mint] Minting project agents and assigning roles..."
    "$NODE_BIN" "$SCRIPT_DIR/mint-agents-step.js" \
        --prd "$_prd" \
        --agents-dir "$EPAM_AGENTS_DIR" \
        --log-dir "$LOG_DIR" \
        --codeline-root "${PROJECT_ROOT:-}" 2>&1 | tee -a "$_log"
    # PIPESTATUS[0], not the pipeline status: without pipefail the status here is tee's, so a
    # failed mint would read as a success and every story would run with no assigned agent.
    if [ "${PIPESTATUS[0]}" != "0" ]; then
      error "[mint] Agent mint/assignment failed — refusing to run stories with no assigned agent."
      return 1
    fi
  }
  return 0
}

# PAUSE 1 of 2 — A HUMAN REVIEW POINT ON EVERY PATH, NOT JUST THE INGESTING ONE.
#
# This lived inline inside _run_jira_pipeline, so it was reachable only by a project that
# ingests from a tracker. A project that AUTHORS its PRD takes the other _run_agent_mint call
# site and ran straight past it into the spec phase: on 2026-08-27 mock3 was launched with
# EPAM_PAUSE_AFTER_AGENT_MINT=1 correctly set and present in the process environment, and never
# stopped — the operator was promised a review point that the shape of their project could not
# reach. The pause is about the roster and the assignments, which every path produces.
#
# Defined ONCE and called from both sites: the review point and the checkpoint it writes are one
# behaviour, and two copies is how the two paths drifted apart in the first place.
_pause_after_agent_mint() {
  # PAUSE 1 of 2 — the roster is minted and every story assigned, and nothing has been
  # specified or written yet. Which roles exist, how they are briefed, and which story each
  # owns shape every later stage, and they are cheap to correct here and expensive to correct
  # after the spec pass has built on them.
  if command -v should_pause_after_agent_mint >/dev/null 2>&1 && should_pause_after_agent_mint; then
    local _rckpt=""
    if _rckpt=$(save_run_checkpoint "${PHASE:-core}" post-roster 2>&1); then
      info "[orch] post-roster checkpoint saved: ${_rckpt}"
    else
      warning "[orch] could not save the post-roster checkpoint: ${_rckpt}"
    fi
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  PAUSED — agents minted and assigned, spec NOT started             ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  RUN NUMBER:  ${GREEN}${ORCH_RUN_ID:-unknown}${NC}"
    echo -e "  Roster:      ${EPAM_AGENTS_DIR}/profiles.json"
    echo -e "  Implementers:  ${EPAM_PROJECT_CONFIG_DIR:-${EPAM_AGENTS_DIR}}/project-roles.json"
    echo -e "  Investigators: ${EPAM_PROJECT_CONFIG_DIR:-${EPAM_AGENTS_DIR}}/project-investigators.json"
    echo -e "  Minted:      ${LOG_DIR}/agent-mint.json"
    echo -e "  Assignments: ${LOG_DIR}/role-assignments.json"
    echo -e "  ${GREEN}WHAT WAS GENERATED (vs canonical): ${LOG_DIR}/roster-diff.md${NC}"
    echo -e "  What the mint could SEE:            ${LOG_DIR}/mint-inputs.json"
    echo -e "  ${GREEN}ROSTER REVIEW:                      ${LOG_DIR}/roster-review.json${NC}"
    if [ -f "${LOG_DIR}/roster-review.json" ] && command -v jq >/dev/null 2>&1; then
      _rv=$(jq -r '.verdict // "?"' "${LOG_DIR}/roster-review.json" 2>/dev/null)
      _rn=$(jq -r '.findings | length' "${LOG_DIR}/roster-review.json" 2>/dev/null)
      _rb=$(jq -r '[.findings[]? | select(.severity=="blocking")] | length' "${LOG_DIR}/roster-review.json" 2>/dev/null)
      if [ "${_rb:-0}" != "0" ]; then
        echo -e "     ${RED}verdict: ${_rv} — ${_rn} finding(s), ${_rb} BLOCKING${NC}"
      else
        echo -e "     verdict: ${_rv} — ${_rn} finding(s)"
      fi
      jq -r '.findings[]? | "       [\(.severity)] \(.agent): \(.found)"' "${LOG_DIR}/roster-review.json" 2>/dev/null | head -8
    fi
    if [ -f "${LOG_DIR}/mint-inputs.json" ] && command -v jq >/dev/null 2>&1; then
      _mi_repo=$(jq -r '.codelineRepo // "NONE"' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      _mi_deps=$(jq -r '.declaredDependencies // 0' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      _mi_df=$(jq -r '.documentsFetched // 0' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      _mi_dl=$(jq -r '.documentsLinked // 0' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      echo -e "     codeline repo:  ${_mi_repo}"
      echo -e "     declared deps:  ${_mi_deps}"
      if [ "${_mi_df}" != "${_mi_dl}" ]; then
        echo -e "     ${RED}documents:      ${_mi_df} of ${_mi_dl} fetched — the roster was derived WITHOUT them${NC}"
      else
        echo -e "     documents:      ${_mi_df} of ${_mi_dl} fetched"
      fi
    fi
    echo ""
    echo -e "  Inspect and EDIT if needed:"
    # The set is declared by operator_reviewable_inputs and kept by save_run_checkpoint. Printing a
    # second hand-kept list here is how the banner came to offer files the checkpoint never saved.
    while IFS=$'\t' read -r _ri_path _ri_what; do
        [ -n "$_ri_path" ] || continue
        echo -e "    ${_ri_path}   (${_ri_what})"
    done < <(operator_reviewable_inputs "${_synth_prd}")
    echo ""
    echo -e "  Then CONTINUE into the spec phase with:"
    echo -e "    ${GREEN}EPAM_RESUME_RUN=${ORCH_RUN_ID:-<run-id>} ${TIER3_LAUNCHER:-<your launcher>} --yes${NC}"
    echo ""
    echo -e "  Resume re-reads those files and VALIDATES your edits (every story assigned, every"
    echo -e "  role real and not a canonical process role). It does not re-mint and does not"
    echo -e "  re-assign over your changes."
    echo ""
    # END THE RUN — exit, not return.
    #
    # This said `return 0` under this same comment. `return` leaves the FUNCTION; the caller carries
    # on. On the ingesting path the call happened to be the last thing before an exit, so it halted
    # by accident and looked correct for as long as nobody called it from anywhere else.
    #
    # Live 2026-08-28 on a PAID run: the banner printed with its resume instructions, the operator
    # was told the run had stopped, and it went straight into the spec pass and was making model
    # calls when it was killed by hand. Pause 2, three thousand lines below, has always used exit.
    #
    # The operator restarts with the command above; resume validates the roster rather than
    # regenerating it, so hand edits survive.
    record_run_pause post-roster
    exit 0
  fi
}

_run_jira_pipeline() {
  local _jira_dir="$AUTOMATION_DIR/jira"
  local _log_file
  _log_file="/tmp/orch-$(date +%Y%m%dT%H%M%S).log"

  local _missing=()
  [ -z "${JIRA_URL:-}"         ] && _missing+=("JIRA_URL")
  [ -z "${JIRA_EMAIL:-}"       ] && _missing+=("JIRA_EMAIL")
  [ -z "${JIRA_TOKEN:-}"       ] && _missing+=("JIRA_TOKEN")
  [ -z "${JIRA_PROJECT_KEY:-}" ] && _missing+=("JIRA_PROJECT_KEY")
  # Worktree validation uses bash indirection to avoid relying on `env | grep`.
  # Brownfield mode: JIRA_CODELINE_ROOT is required; worktree paths are discovered
  # at runtime by codeline-discovery.js (ingest step 1.5) — no JIRA_WORKTREE_* needed.
  # Greenfield mode: JIRA_CODELINES + matching JIRA_WORKTREE_* must be pre-declared.
  local _found_wt=0
  if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
    [ -z "${JIRA_CODELINE_ROOT:-}" ] && _missing+=("JIRA_CODELINE_ROOT")
    [ -n "${JIRA_CODELINE_ROOT:-}" ] && _found_wt=1
  elif [ -n "${JIRA_CODELINES:-}" ]; then
    IFS=',' read -ra _wt_cls <<< "$JIRA_CODELINES"
    for _wt_cl in "${_wt_cls[@]}"; do
      local _wt_var="JIRA_WORKTREE_${_wt_cl^^}"
      if [ -n "${!_wt_var:-}" ]; then _found_wt=1; else _missing+=("$_wt_var"); fi
    done
  else
    [ -n "${JIRA_WORKTREE_BE:-}" ] && _found_wt=1
    [ "$_found_wt" = "0" ] && _missing+=("JIRA_WORKTREE_<CODELINE>")
  fi
  if [ ${#_missing[@]} -gt 0 ]; then
    error "[jira] Missing required env vars: ${_missing[*]}"
    error "[jira] Run: source orchestrations/jira/.env"
    return 1
  fi

  log "[jira] ${JIRA_URL} (project: ${JIRA_PROJECT_KEY}) → ${_log_file}"

  # Overridable so a test (or any concurrent, isolated Jira-pipeline run) can
  # point the synthesized PRD at its own disposable path instead of colliding
  # with whatever real project last used the shared default location.
  # Follows the run's own PRD_FILE. There is NO built-in default: a default that names
  # one project does not fail when it is wrong, it succeeds against that project's data —
  # which is exactly how every Jira-driven run once synthesized into one shared PRD
  # (2026-07-25 clobber). Absent is an error, not a substitution.
  local _synth_prd="${JIRA_SYNTH_PRD_PATH:-${PRD_FILE:-}}"
  if [ -z "$_synth_prd" ]; then
    error "[jira] no PRD path: set JIRA_SYNTH_PRD_PATH or PRD_FILE. Refusing to guess — the engine names no project."
    return 1
  fi
  local _ingest_exit=0
  # IMPORTANT: do NOT use `|| _ingest_exit=${PIPESTATUS[0]}` here.
  # Without pipefail, the pipeline exit code is tee's exit code (almost always 0),
  # so the || never fires even when ingest-jira-tickets.sh exits 1.
  # PIPESTATUS[0] captures bash ingest's exit code REGARDLESS of tee's success.
  # A RESUME MUST NOT RE-INGEST. ingest writes --out-prd over PRD_FILE, and Jira carries the
  # story text only: no verification criteria, no fix-site analysis, no per-codeline maps. On a
  # resume the PRD on disk is strictly richer than anything ingest can synthesize, so re-running
  # it silently deletes the spec output the resume exists to preserve.
  #
  # Live 2026-08-09: restore_run_checkpoint correctly KEPT the merged canonical (27 spec items,
  # "KEEPING the PRD on disk"), and this call emptied it three steps later. The lane PRDs are
  # filtered FROM canonical at lane start, so gotransit ran its writer against 0 criteria and the
  # end-of-lane merge wrote that emptiness back, taking the other two codelines' entries with it.
  # The restore guard was necessary and not sufficient — it protected one writer, not the file.
  if [ "${EPAM_SKIP_JIRA_INGEST:-0}" = "1" ]; then
    if [ ! -s "$_synth_prd" ]; then
      error "[jira] resume asked to skip ingest but no PRD exists at $_synth_prd — refusing to continue with no stories"
      return 1
    fi
    log "[jira] ⊘ Ingest skipped (resume) — using the PRD on disk: $(jq '[.stories[]?] | length' "$_synth_prd" 2>/dev/null || echo '?') story(ies), $(jq '[.stories[]? | ((.verificationCriteria // []) | length) + ((.fixSiteAnalysis // []) | length)] | add // 0' "$_synth_prd" 2>/dev/null || echo '?') spec item(s)"
  else
  bash "$SCRIPT_DIR/ingest-jira-tickets.sh" \
    --project "$JIRA_PROJECT_KEY" \
    --status  "${JIRA_STATUS_FILTER:-To Do}" \
    --out-prd "$_synth_prd" \
    2>&1 | tee -a "$_log_file"
  _ingest_exit="${PIPESTATUS[0]}"
  fi

  if [ "$_ingest_exit" = "2" ]; then
    error "[jira] Pipeline halted: insufficient ACs. Review Jira tickets and re-trigger."
    return 2
  elif [ "$_ingest_exit" != "0" ]; then
    error "[jira] Ingestion failed (exit $_ingest_exit)."
    return 1
  fi

  # Inject an empty scaffold phase into implementationOrder so the tier3 launcher's
  # run_phase "scaffold" call fires the pre-phase assessment agent. The scaffold phase
  # has 0 implementation stories but runs Step 3 (skill assessment) over ALL synthesized
  # Jira stories — this assesses and injects project-specific skills into each agent's
  # profile before any core implementation begins. Agent SKILLS are assessed per project
  # here; agent IDENTITIES are minted per project immediately below — they used to be kept
  # wholesale from the canonical, which is how a client codeline ran epam-cli's own roster.

  # ── Mint this project's agents, then assign every story one ────────────────
  #
  # Ordering (operator direction, 2026-08-07): after ingest, before spec. The inputs that make
  # a proposed role project-specific rather than a restatement of the canonical core are the
  # tickets and the documents linked on them, and both exist only once ingest has run.
  #
  # Until now the roster was inherited wholesale: a client codeline ran with epam-cli's OWN
  # first-commit agents, and synthesize-prd-from-jira.js assigned every ticket to one of them
  # with a hardcoded literal. Nothing errored — it was simply always the wrong agent.
  # THE SKIP IS HONOURED, INCLUDING ON A RESUME.
  #
  # This used to read `|| [ -n "${EPAM_RESUME_RUN:-}" ]`, which forced the mint back ON for every
  # checkpoint-based resume — exactly contradicting the instruction the checkpoint had just
  # issued, and for the reason it states: the merge is additive, so each resume accumulated
  # near-duplicate roles in a roster the operator had already settled.
  #
  # The danger the clause was reaching for is still real and is now handled properly: skipping the
  # mint when nothing was ever minted would hand stories to agents that do not exist. That is a
  # refusal, not a silent re-mint — the same rule as every other guard here, which is to stop
  # rather than proceed on unknown state.
  # The skip guard travels with the mint now — see _run_agent_mint — so neither path can skip
  # into a roster that was never minted.
  _run_agent_mint "$_synth_prd" "$_log_file" || return 1

  _pause_after_agent_mint

  _run_codeline_loop "$_synth_prd" "$_log_file"
}

# ──────────────────────────────────────────────
# resolve_orch_mode <phase_id>
# Precedence: prd.json phasesConfig[phase].orchestrationMode
#             > ORCH_MODE env var > default "bash"
# ──────────────────────────────────────────────
resolve_orch_mode() {
    local phase_id="$1"
    local phase_mode
    phase_mode=$(jq -r \
        --arg p "$phase_id" \
        '.phasesConfig[$p].orchestrationMode // empty' \
        "$PRD_FILE" 2>/dev/null || true)
    if [ -n "$phase_mode" ] && [ "$phase_mode" != "null" ]; then
        echo "$phase_mode"
    else
        echo "${ORCH_MODE:-bash}"
    fi
}

# ── Step 0: Specification pre-pass (OpenSpec/Speckit) ─────────────────────────
run_specification_pass() {
    local phase_id="$1"
    # Guarded so an unloaded library is skipped rather than fatal: an undefined function
    # returns 127, and `|| exit 1` on that silently killed the enclosing block wherever a
    # harness runs this code with the gate library absent. The orchestrator sources it at the
    # top, and pre-flight is what actually gates a run.
    declare -f require_stage_coverage >/dev/null && { require_stage_coverage spec || return 1; }
    local spec_runner="$SCRIPT_DIR/spec-mode-runner.js"
    if [ ! -f "$spec_runner" ]; then
        info "Step 1: Specification runner not found (${spec_runner##*/}) — skipping"
        return 0
    fi
    local node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    if [ ! -x "$node_cmd" ]; then
        node_cmd="$(command -v node 2>/dev/null || echo 'node')"
    fi
    if ! command -v "$node_cmd" >/dev/null 2>&1; then
        warning "Step 1: Node.js is required for specification mode but was not found"
        return 0
    fi
    step_emit "1" "running" "Step 1: Specification pass"
    log "Step 1: Running specification pass for phase '$phase_id'..."
    local _spec_started; _spec_started=$(date -Iseconds)
    set +e
    PRD_FILE="$PRD_FILE" OUTPUT_DIR="$LOG_DIR" CLAUDE_CMD="${CLAUDE_CMD}" \
        AI_RUNNER_CMD="$AI_RUNNER_CMD" EPAM_ORCHESTRATION_PROVIDER="${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}" \
        "$node_cmd" "$spec_runner" --phase "$phase_id" 2>&1 | tee "$LOG_DIR/spec-${phase_id}.log"
    local spec_rc=${PIPESTATUS[0]}
    set -e
    # GAP-P22: emit spec runner cost record (token/cost estimated — spec runner
    # doesn't expose per-call usage; a future improvement can parse spec logs)
    # Real usage, measured from the records spec-mode-runner already emits —
    # see _spec_pass_usage for why this used to be four literal zeros.
    local _spec_usage _spec_cost _spec_tin _spec_tout _spec_turns
    _spec_usage=$(_spec_pass_usage "$phase_id")
    read -r _spec_cost _spec_tin _spec_tout _spec_turns <<< "${_spec_usage:-0 0 0 0}"
    append_pipeline_cost_record "spec-pass" "$phase_id" \
        "$(seam_model_or_fail "spec-agent")" "$_spec_started" \
        "${_spec_cost:-0}" "${_spec_tin:-0}" "${_spec_tout:-0}" "${_spec_turns:-0}" 2>/dev/null || true
    # Surface openspec/speckit as visible checklist sub-steps instead of only
    # showing as "spec-mode: fast-path ..." log lines buried inside Step 0's
    # own log — parses the summary spec-mode-runner.js already writes
    # (summary.stats.agents: {agentName: invocationCount}) for a real story
    # count per agent; model comes from the same env vars the runner itself
    # uses (SPEC_MODE_OPENSPEC_MODEL/SPEC_MODE_SPECKIT_MODEL).
    local _spec_summary="$LOG_DIR/spec-summary.json"
    local _openspec_model
    _openspec_model="$(seam_model_or_fail "spec-agent")"
    local _speckit_model
    _speckit_model="$(seam_model_or_fail "spec-agent")"
    local _openspec_count=0 _speckit_count=0
    if [ -f "$_spec_summary" ]; then
        _openspec_count=$(jq -r '.stats.agents.openspec // 0' "$_spec_summary" 2>/dev/null || echo 0)
        _speckit_count=$(jq -r '.stats.agents.speckit // 0' "$_spec_summary" 2>/dev/null || echo 0)
    fi

    if [ $spec_rc -eq 0 ]; then
        step_emit "1" "pass" "Step 1: Specification pass"
        step_emit "1a" "pass" "  openspec (elaboration)" "${_openspec_model}, ${_openspec_count} stor(y/ies)"
        step_emit "1b" "pass" "  speckit (verification)" "${_speckit_model}, ${_speckit_count} stor(y/ies)"
        success "Step 1: Specification pass completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "specification_pass" \
            "Specification agents completed (OpenSpec/Speckit)" "" "main" "spec-coordinator" 2>/dev/null || true
        # Block execution when spec-pass failed on stories that still need splitting
        # and the caller has opted in to hard blocking (SPEC_PASS_BLOCK_ON_TIMEOUT=true).
        if [ "${SPEC_PASS_BLOCK_ON_TIMEOUT:-false}" = "true" ]; then
            _failed_untuned=$(jq -r \
                '[.stories[] | select(.specification.specPassFailed == true)] | length' \
                "$PRD_FILE" 2>/dev/null || echo 0)
            if [ "${_failed_untuned:-0}" -gt 0 ]; then
                _failed_ids=$(jq -r \
                    '[.stories[] | select(.specification.specPassFailed == true) | .id] | join(", ")' \
                    "$PRD_FILE" 2>/dev/null || echo "unknown")
                error "Spec pass FAILED for untuned stories: $_failed_ids"
                error "  Execution blocked (SPEC_PASS_BLOCK_ON_TIMEOUT=true). Set to false to override."
                exit 1
            fi
        fi
        # SUFFICIENCY GATE (always on, NOT overridable): a brownfield story where
        # the detective found no fix site AND the ticket context is thin cannot be
        # implemented or verified — fail early with a clear reason rather than
        # burning a doomed run. Autonomous (no human halt); the flag is set by the
        # spec pass (spec-mode-runner.js sufficiency gate).
        _insufficient=$(jq -r \
            '[.stories[] | select(.specification.insufficientContext == true)] | length' \
            "$PRD_FILE" 2>/dev/null || echo 0)
        if [ "${_insufficient:-0}" -gt 0 ]; then
            _insufficient_ids=$(jq -r \
                '[.stories[] | select(.specification.insufficientContext == true) | .id] | join(", ")' \
                "$PRD_FILE" 2>/dev/null || echo "unknown")
            error "Step 1: INSUFFICIENT CONTEXT — $_insufficient_ids: the code-graph-detective located no fix site and the ticket's ACs + description are too thin to implement or to write a reproducing test."
            error "  Failing early rather than proceeding to a doomed run. Enrich the ticket (ACs or description) and re-run."
            exit 2
        fi
    else
        step_emit "1" "fail" "Step 1: Specification pass"
        step_emit "1a" "fail" "  openspec (elaboration)" "${_openspec_model}"
        step_emit "1b" "fail" "  speckit (verification)" "${_speckit_model}"
        error "Step 1: Specification pass FAILED for '$phase_id' — all agent invocations failed."
        error "  Check EPAM_ORCHESTRATION_PROVIDER is set and supported by ai-run.sh."
        error "  See: $LOG_DIR/spec-${phase_id}.log"
        exit 1
    fi
}

# ──────────────────────────────────────────────
# Step 0.6 (hybrid only): Pre-phase coordination
# Seeds the MCP message bus with guidance messages
# and identifies any stories requiring plan mode.
# ──────────────────────────────────────────────
run_hybrid_precoordination() {
    local phase_id="$1"
    local coord_log="$LOG_DIR/hybrid-coord-${phase_id}.log"
    local coord_prompt
    touch "$MESSAGES_JSONL"

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/hybrid-prephase-coordinator-vals-XXXXXX.json")
    jq_vals \
          --arg phase_id "$phase_id" \
          --arg prd_rel "${PRD_REL}" \
          '{"__PHASE_ID__":$phase_id,"__PRD_REL__":$prd_rel}' > "$_cp_vals"
    coord_prompt="$(render_engine_prompt hybrid-prephase-coordinator "$_cp_vals")"
    rm -f "$_cp_vals"

    cd "$PROJECT_ROOT"
    # run_orch_prompt_with_tools (not plain run_orch_prompt): the prompt above
    # instructs reading the PRD and flock-appending real JSONL messages — same
    # class of bug already fixed for the assessment agents above.
    local _hpc_attempt=0 _hpc_ok=0
    while [ "$_hpc_attempt" -lt 2 ] && [ "$_hpc_ok" = "0" ]; do
        local _hpc_prompt="$coord_prompt"
        if [ "$_hpc_attempt" -ge 1 ]; then
          _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
          jq_vals \
                --arg coord_prompt "$coord_prompt" \
                '{"__COORD_PROMPT__":$coord_prompt}' > "$_rp_vals"
          _hpc_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" hybrid_prephase_coordinator)"
          rm -f "$_rp_vals"
        fi
        # No story_id — phase-level coordination call, not tied to a single story.
        # PIPESTATUS, not `[ -s "$coord_log" ]` alone. This is a PIPELINE and its exit status is
        # tee's — always 0 — so `set -e` cannot help either (no `set -o pipefail`). Judging
        # success by "the log is non-empty" meant an agent that errored after writing a single
        # line counted as having coordinated the phase. The same trap is already documented at
        # the assessment call sites in this file; this one was missed.
        #
        # BOTH conditions are required: a clean exit that produced nothing did no work, and
        # output from a failed run is not a result.
        run_orch_prompt_with_tools "$_hpc_prompt" "spec-coordinator" 2>&1 | tee "$coord_log"
        local _hpc_rc="${PIPESTATUS[0]}"
        if [ "$_hpc_rc" -ne 0 ]; then
            warning "Hybrid pre-phase coordination attempt $((_hpc_attempt + 1)) FAILED (exit ${_hpc_rc}) — its output is not a result"
        elif [ -s "$coord_log" ]; then
            _hpc_ok=1
        else
            [ "$_hpc_attempt" -lt 1 ] && warning "Hybrid pre-phase coordination attempt 1 produced no output — retrying" || warning "Hybrid pre-phase coordination had issues — continuing with bash fallback"
        fi
        _hpc_attempt=$(( _hpc_attempt + 1 ))
    done
    if [ "$_hpc_ok" = "1" ]; then
        step_emit "4" "pass" "Step 4: Hybrid pre-coord"
        success "Hybrid pre-phase coordination completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "hybrid_precoord" \
            "Hybrid pre-phase coordination completed" "" "main" "coordination-agent" 2>/dev/null || true
    else
        warning "Hybrid pre-phase coordination had issues — continuing with bash fallback"
    fi
}

# ──────────────────────────────────────────────
# Step 11: Skills coordinator audit
#
# Root cause this addresses (found live, 2026-07-10, tier3-travel-app run): a
# self-heal skill note ("Do not use 'as' keyword for type assertions... use
# 'value as Type'...") was persisted TWICE, verbatim, into typescript-
# engineer's profile during a single story's retry loop — the note is also
# internally self-contradictory (it recommends the exact syntax it says not
# to use). Nothing in the pipeline ever looks at the ACCUMULATED set of
# skill notes as a whole; FailureAnalyst only ever appends. This step audits
# profiles.json once per phase, after Step 1's healing activity has had a
# chance to add new notes:
#   1. Deterministic pass (run_skills_audit_scan.py): collapses exact-
#      duplicate [Self-Heal] paragraphs within each role's profile, and
#      flags (via a narrow regex heuristic) any note that says "do not use
#      'X'" while also recommending "use ... 'X'" elsewhere in the same
#      note — exactly the shape of bug that motivated this step.
#   2. Only if step 1 flags a suspected contradiction: invoke the
#      skills-coordinator agent (Bash+WriteFile tool access, same pattern as
#      run_pre_phase_assessment) to rewrite JUST that flagged note into
#      something internally coherent. The LLM is only ever invoked when the
#      deterministic scan found something to fix — most phases will run the
#      free, instant scan and skip the LLM call entirely.
# Bypass: SKIP_SKILLS_AUDIT=1
run_skills_audit_scan() {
    local profiles_file="$1"
    # Locked for the whole scan+conditional-write: fast, in-memory text
    # processing only (no LLM call inside), so holding the lock this long
    # never risks stalling a parallel worktree story on model latency.
    ( flock -w 10 200 || { error "  [SkillsAudit] Could not acquire lock on $profiles_file"; return 1; }
    python3 "$SCRIPT_DIR/lib/handlers/skill-note-duplicates.py" "$profiles_file"
    ) 200>"${profiles_file}.lock"
}

# ──────────────────────────────────────────────
# Step 12: Tools coordinator audit
#
# Same rationale and shape as Step 11, applied to the dynamic-tools
# mechanism instead of skill notes: FailureAnalyst can write a tool script to
# .epam/dynamic-tools/<name>.sh (target=tool), and run_dynamic_tools_in_
# unlocked_window() (claude.sh) runs every reviewed, syntax-valid tool on
# every retry unconditionally — but nothing ever checks whether a tool
# actually WORKS, or whether two tools solve the same problem. Observed live
# this session: "[dynamic-tools] mock-fetch-in-test.sh exited non-zero
# (continuing)" — a tool got created, was broken, and the pipeline just
# logged a warning and moved on, paying its cost on every subsequent retry
# with no mechanism to ever fix or remove it.
#   1. Deterministic scan (run_tools_audit_scan): for each reviewed tool,
#      (a) a free bash -n syntax check, (b) counts "<tool>.sh exited
#      non-zero" occurrences across this phase's main-*.log files (a REAL
#      observed-failure signal, not a synthetic re-execution — tools aren't
#      re-run here to avoid side effects outside their sanctioned window),
#      (c) flags near-duplicate tools via purpose-comment similarity.
#   2. Only when something is flagged, invoke the tools-coordinator LLM
#      (Bash+WriteFile access) to fix the broken tool or consolidate a
#      duplicate pair.
# Bypass: SKIP_TOOLS_AUDIT=1
run_tools_audit_scan() {
    local tools_dir="$1"
    local log_dir="$2"
    python3 "$SCRIPT_DIR/lib/handlers/tool-scripts-health.py" "$tools_dir" "$log_dir"
}

# _build_skill_domain_guidance <project_root>
# Generic, project-supplied mapping of tech-stack keywords to agentRole
# names for the phase-assessment agent's skill-domain-mismatch correction
# step (see run_phase_assessment's prompt). Never hardcoded in this engine
# -- a project may not use TypeScript/React/Docker/Vitest at all (found
# 2026-07-12 while fixing the Step 6 real-output-gate bug in the same
# function: the prompt hardcoded exactly that mapping directly in the
# engine). Reads .epam/skill-domain-map.json's "skillDomains" array:
# [{"role":"...", "keywords":["...", ...]}, ...] -- same opt-in convention
# as dependency-check.json's vendorDirs: no config file or no
# "skillDomains" key means no guidance; callers must supply their own
# generic fallback instruction.
_build_skill_domain_guidance() {
    local project_root="$1"
    local config_file="${project_root}/.epam/skill-domain-map.json"
    [ -f "$config_file" ] || return 0
    jq -r '
        (.skillDomains // [])
        | map("\"" + (.keywords | join("\" / \"")) + "\" → " + .role)
        | join(",\n     ")
    ' "$config_file" 2>/dev/null
}
