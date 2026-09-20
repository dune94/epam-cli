#!/usr/bin/env bash
# writer-prompt.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (13 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# Get story details from PRD
get_story_details() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id)' "$PRD_FILE"
}

# Build prompt for Claude to implement a story
# WHICH LANE AM I? A story may SPAN codelines, and _filtered_prd() copies such a story
# WHOLE into every lane's PRD — .codeline/.codelines are left untouched — so the story
# itself cannot say which lane is executing it. The only per-lane signal the orchestrator
# writes is project.outputDir (set to that lane's checkout), so the lane name is recovered
# by matching it back against project.outputDirs[]. Single-codeline PRDs carry no
# outputDirs: the result is empty and every caller degrades to its previous behaviour.
_current_lane() {
    local _story_json="${1:-}"
    local _l="${CODELINE_NAME:-}"
    if [ -z "$_l" ] && [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _l=$(jq -r '.project as $p | (($p.outputDirs // []) | map(select(.path == $p.outputDir)) | .[0].codeline) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    [ -n "$_l" ] || _l=$(echo "$_story_json" | jq -r '.codeline // empty' 2>/dev/null)
    printf '%s' "$_l"
}

# Render technicalNotes for ONE lane.
#
# technicalNotes is rendered by dumping every key, so ANY per-codeline structure stored
# there reaches the agent in full — every lane's paths, and the fact that they diverge.
# Live 2026-08-03: the per-codeline manifest stored here handed a gotransit-scoped writer
# the maps for all three repos; it went cross-repo and one call billed in=1,916,632
# out=40,859 ($0.624, 11.58 min) producing nothing, ending "Let me confirm the scope with
# the user before proceeding" — in a non-interactive loop, a dead end.
#
# The projection is SHAPE-based, never keyed to a field name: any object that has the
# current lane as a key collapses to that lane's entry. Excluding one known field by name
# would leave the next per-codeline field leaking, in a different file, forever.
_render_technical_notes() {
    local _notes="${1:-}" _cl="${2:-}"
    if [ -z "$_notes" ]; then echo "None specified"; return 0; fi
    # THIS LANE'S ENTRY SUPERSEDES THE UNION.
    #
    # technicalNotes carries a flat `files` (the union across every codeline) beside a
    # `perCodeline` map holding the correct per-lane lists. The object-scoping below narrows
    # per-codeline OBJECTS, but `files` is an ARRAY and sailed straight through, so the prompt
    # stated the union AND the lane's own list. Live 2026-08-09 gotransit's writer prompt named a
    # component that exists only in next.metrolinx.com, twice, and the writer duly created it.
    #
    # perCodeline[$cl] is merged OVER the top level key-by-key, so a key it defines wins and a key
    # it does not mention is preserved — dropping unrelated guidance would be its own defect. The
    # map itself is then never rendered raw, which also stops the other lanes' paths reaching the
    # prompt by that second route. Nothing here names a specific key; whatever the spec pass
    # produces is scoped the same way.
    echo "$_notes" | jq -r --arg cl "$_cl" '
        (if type == "object" then . else {} end) as $all
        | (($all.perCodeline // {})[$cl] // {}) as $scoped
        | (($all | del(.perCodeline)) * $scoped)
        # Coercing a non-object to {} above removed the jq ERROR that used to trigger the
        # "None specified" fallback, so an empty or malformed notes value rendered as a blank
        # line instead. Say it explicitly: a prompt section that silently renders nothing reads
        # as "no constraints" to the writer.
        | if (. | length) == 0 then "None specified" else (
          to_entries
        | map(if (.value | type) == "object" and ($cl | length) > 0 and (.value | has($cl))
              then {key: .key, value: (.value[$cl])}
              else . end)
        | map("- \(.key): \(.value)")
        | join("\n")) end' 2>/dev/null || echo "None specified"
}

# story_declared_files — this story's declared files, RESOLVED FOR THE LANE THAT IS RUNNING.
#
# One definition, because there were eight. The flat technicalNotes.files array is the union across
# every codeline in the story's DECLARED spelling; spec-mode-runner resolves each path against each
# codeline's real checkout and persists technicalNotes.perCodeline.<codeline>.files. Only one of
# the eight derivations read the resolved list, so the prompt rendered the same set twice from two
# sources that disagreed — one carrying a path absent from this checkout, one carrying a path whose
# case was wrong, listed twice. Feeding that wrong-case path through _resolve_deliverable_path is
# also what produced the warning that used to be captured into the prompt body.
#
# Falls back to the flat array when this lane has no entry (a PRD written before perCodeline
# existed, or a lane added later). Never falls back to NOTHING: handing the writer an empty file
# list is worse than handing it an imperfect one.
#
# De-duplicated, because a declaration repeated in the PRD renders repeatedly in the prompt.
# Emits one path per line; callers join as they need.
story_declared_files() {
    local _story_json="$1"
    local _lane _out
    _lane=$(_current_lane "$_story_json" 2>/dev/null || printf '')
    if [ -n "$_lane" ]; then
        _out=$(printf '%s' "$_story_json" | jq -r --arg cl "$_lane" \
            '(.technicalNotes.perCodeline[$cl].files // []) | .[]' 2>/dev/null)
    fi
    [ -n "${_out:-}" ] || _out=$(printf '%s' "$_story_json" | jq -r \
        '(.technicalNotes.files // []) | .[]' 2>/dev/null)
    printf '%s\n' "$_out" | awk 'NF && !seen[$0]++'
}

build_implementation_prompt() {
    local story_id=$1
    local story_json
    story_json=$(get_story_details "$story_id")

    local title
    title=$(echo "$story_json" | jq -r '.title')
    local description
    description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria
    acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes
    technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    # Prefer THIS lane's resolved paths. The flat technicalNotes.files array is shared
    # by every codeline, but separate repositories spell the same file differently —
    # live 2026-08-03 the detective's root-cause fix site resolved on one lane of three,
    # and the two writers handed a non-existent path could not do the work they were
    # then blocked for. spec-mode-runner resolves each declared path against each
    # codeline's own checkout and persists technicalNotes.perCodeline.<codeline>.files;
    # falling back to the flat array keeps older PRDs working unchanged.
    local _cl_name
    _cl_name=$(_current_lane "$story_json")
    local _lane="$_cl_name"
    # Lane-resolved, de-duplicated, one definition — see story_declared_files.
    local files
    files=$(story_declared_files "$story_json" | paste -sd', ' -)

    local dependencies
    dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # In worktree mode, rewrite ALL occurrences of the main repo absolute path in the
    # prompt text. The canonical PRD embeds absolute paths in acceptanceCriteria,
    # technicalNotes, and files — agents read these and write to those exact paths,
    # bypassing any write-first directive. Replace every reference so the agent only
    # ever sees the worktree path and writes files to the correct directory.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    # Root-cause analysis from the code-graph-detective (brownfield). The
    # detective already traced the CAUSAL fix site and WHY it's wrong (often a
    # cross-file bug — e.g. an ID transformed in one function that a match in
    # another function doesn't account for). Injecting its reason strings here
    # means the coding agent starts WITH the answer instead of re-reading files
    # to re-discover it — which is exactly what bloats a "bad" retry's token
    # count (found live 2026-07-23: attempt read 143k tokens tracing the bug,
    # wrote nothing). Each entry: the file, the function, and the root cause.
    # DOES THE STORY HAVE A PLAN? A PRESENCE question, not a rendering one — the two decisions
    # below turn on whether an investigation produced anything, never on how it reads. Asked of
    # the published store rather than of the detective's fields, so this stays true for any
    # producer of the kind.
    local _has_fix_plan=""
    if "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/agent-io.js" present "$story_id" fix-plan; then
        _has_fix_plan="yes"
    fi
    # RENDERED BY THE PRODUCER. The detective is the only actor that knows what its own fields
    # mean, so it is the only one that turns them into words — see lib/producers/fix-plan.js for
    # what two copies of this rendering had already cost. A failure to render is NOT an empty
    # plan: a writer prompted without the root-cause analysis re-traces it from scratch, which is
    # the 143k-token retry this block exists to prevent.
    # THE WRITER RECEIVES WHAT ITS ARCHETYPE DECLARED IT CONSUMES — see lib/agent-inputs.js.
    # Not "the engine decides what to show the writer": the archetype lists the kinds, producers
    # publish them, and each arrives under the authority the writer own prompt document gives it.
    # A kind nobody published contributes nothing, which is why no conditional guards this.
    # A REQUIRED kind nobody published is a hard failure: a prompt missing the root-cause analysis
    # looks exactly like one that has it, and costs a whole retry to discover.
    local agent_inputs
    # NOTE (2026-08-14): the default below names an archetype, which is engine code choosing a
    # role. Removing it and refusing instead was tried and REVERTED the same day: stories
    # legitimately omit agentRole, and the refusal failed every one of them at prompt-build.
    # Making agentRole mandatory is a deliberate PRD change with a migration, not a one-line edit
    # here — see the sweep notes.
    agent_inputs=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/agent-inputs.js" \
        "$(echo "$story_json" | jq -r '.agentRole // "story-writer"')" "$story_id") || {
        error "  [prompt] declared inputs did not render for $story_id — refusing to build a writer prompt without them"
        return 1
    }

    # Verification Criteria (VC) — the observable checks openspec-brownfield
    # produced (mechanism-free, from AC ∪ description). The impl agent must make
    # the change satisfy these; the ACs above are the intent, the VCs are what a
    # tester will actually confirm. Persisted on the story → PRD.
    local verification_criteria
    verification_criteria=$(echo "$story_json" | jq -r '(.verificationCriteria // []) | map("- " + .) | join("\n")' 2>/dev/null || echo "")

    # Codeline facts (real, project-operator-curated gotchas — see the
    # Metrolinx codeline-context plugin's own docs) — injected DIRECTLY into
    # the prompt rather than left as an optional tool call. Built 2026-08-02:
    # the codeline_facts plugin tool existed and was correct, but
    # across a full Writer Retest run the model called it exactly once
    # (git_state) and never codeline_facts — the facts
    # that would have told it the right token key never reached the model
    # that needed them. Relying on the model to spontaneously discover an
    # optional tool isn't working; injecting the same facts directly here
    # means every invocation sees them regardless of tool-calling behavior.
    # Advertise whatever plugin tools THIS codeline registered (runtime discovery — no
    # client tool name lives in this engine). Without this the tools are loaded and
    # callable but the model is never shown them, so it never calls them.
    local project_tools_block
    project_tools_block=$(build_project_tools_block "$PROJECT_ROOT")

    local codeline_facts_block=""
    local _codeline_facts_file="${PROJECT_ROOT}/.epam/codeline-facts.json"
    if [ -f "$_codeline_facts_file" ]; then
        local _codeline_facts
        _codeline_facts=$(jq -r '
          (if type == "array" then . else (.facts // []) end)
          | map(if type == "object" then (.text // "") else . end)
          | map(select(length > 0))
          | map("- " + .) | join("\n")
        ' "$_codeline_facts_file" 2>/dev/null || echo "")
        [ -n "$_codeline_facts" ] && codeline_facts_block=$(printf '\n## Codeline-Specific Facts (real, curated gotchas for THIS codeline — read before assuming local tooling behaves like a fully-configured environment)\n%s\n' "$_codeline_facts")
    fi

    # THE PRD'S CONFIGURATION, AS DATA. A story may cite a PRD-level key by name (regintel's
    # REGI-001a: "copy ... from the read-only source repo (configuration.sourceRepoReadOnly)"),
    # and nothing rendered that object into any prompt — the writer was asked to copy from a
    # repository it was never told the path of. Rendered from the template layer; $-prefixed
    # keys are the PRD author's comments and are dropped. Empty when the PRD declares none.
    local prd_configuration_block=""
    if [ -n "${PRD_FILE:-}" ] && [ -f "$PRD_FILE" ]; then
        local _prd_cfg
        _prd_cfg=$(jq -c '(.configuration // {}) | with_entries(select(.key | startswith("$") | not))' "$PRD_FILE" 2>/dev/null || echo '{}')
        if [ -n "$_prd_cfg" ] && [ "$_prd_cfg" != "{}" ]; then
            local _pc_vals
            _pc_vals=$(mktemp "${TMPDIR:-/tmp}/prd-configuration-vals-XXXXXX.json")
            jq -n --arg j "$(printf '%s' "$_prd_cfg" | jq '.')" '{"__PRD_CONFIGURATION_JSON__":$j}' > "$_pc_vals"
            prd_configuration_block=$(render_engine_prompt prd-configuration-block "$_pc_vals")
            rm -f "$_pc_vals"
        fi
    fi

    # REQUIRED bug-reproducing test (brownfield defect). The repro-gate (Step 3.55)
    # HARD-BLOCKS any brownfield change that ships no test which FAILS on the pre-fix
    # baseline and PASSES with the fix. For a single-agent defect story NOTHING else
    # writes that test — the TC-writer only serves separate test-engineer stories —
    # so the impl agent MUST write it here. Found live 2026-07-24 (AMSD-1820): with
    # only a weak "your accompanying test should assert them", the agent shipped a
    # garbage file literally named `test` (a copy of the SOURCE) and no real test.
    # Make the requirement explicit, concrete (a real co-located path the repro-gate
    # recognises: *.test.*), and unambiguous. Fires for brownfield defects (fix site
    # known); novel brownfield still gets the VC "your test asserts these" guidance.
    # B1 (2026-07-24) — impl writes ONLY the fix. The reproducing test belongs to
    # brownfield-repro-test-writer.sh, which gets its own agent turn AFTER the fix
    # commits, and (since 2026-07-24) VALIDATES the test parses and runs before
    # committing it, with retry + ladder + self-heal on failure.
    #
    # This block used to MANDATE that impl ship a co-located *.test.* file. That was
    # a hedge taken when the test-writer produced nothing at all. Measured cost of
    # keeping it: the 15:36 run was killed at 7 impl attempts / $1.11, having
    # committed apply-report-discounts.service.test.ts, with the failure-analyst's
    # own diagnosis pointing AT that file ("Test file accesses possibly-undefined
    # variables without null narrowing under strict mode"). Six consecutive quality
    # failures were spent fighting a test impl should never have written.
    #
    # Enforcement is unchanged — the repro-gate still BLOCKS a fix that ships
    # without a reproducing test. Only authorship moved.
    # CONDITION WIDENED 2026-08-08. This used to require a non-empty fix_site_analysis, so a
    # story reaching the writer WITHOUT one was never told that tests belong to the dedicated
    # repro-test-writer turn — and the agent's own roster brief was then the only instruction
    # in play. On AMSD-2041 that brief said "You write Jest tests... colocated alongside the
    # modules you edit", the exact opposite. DET-1 makes "investigated, found nothing" a
    # legitimate state, so the no-fix-site path gets MORE traffic, not less.
    #
    # Authorship is a brownfield property, not a fix-site property: brownfield-repro-test-writer
    # takes its own turn either way. Enforcement is untouched — the repro-gate still blocks a
    # fix that ships without a reproducing test.
    # ONE POLICY, RENDERED FROM THE PROMPT LAYER, READ BY BOTH AGENTS.
    #
    # This was a heredoc HERE and nowhere else, so team-lead-review.sh had never heard of it and
    # was told "Check: ... test coverage". It raised a blocker for missing tests; 33ee47b then
    # hardened this side — "a BLOCKER is a required deliverable ... the only way to resolve it is
    # to CREATE it" — leaving the writer ORDERED TO CREATE WHAT IT IS FORBIDDEN TO CREATE. Both
    # halves now come from prompts/test-ownership.json, so the rule cannot be changed for one
    # agent and not the other.
    local test_ownership_block=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        local _to_vals; _to_vals=$(mktemp)
        printf '{}' > "$_to_vals"
        test_ownership_block=$(printf '\n%s\n' "$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
            render test-ownership "${EPAM_PROJECT_CONFIG_DIR:-}" "$_to_vals" writer 2>/dev/null)")
        rm -f "$_to_vals"
        # A policy that failed to render is not an empty policy: the writer would silently regain
        # permission to write tests, which is the failure this whole change removes.
        if [ -z "$(printf '%s' "$test_ownership_block" | tr -d '[:space:]')" ]; then
            error "  [prompt] test-ownership policy failed to render — refusing to build a writer prompt without it"
            return 1
        fi
    fi

    # Reviewer feedback (review→re-implement loop): if a prior team-lead review
    # requested changes, its issues are written to review-feedback-<id>.json.
    # Inject them so THIS re-implementation directly addresses what the reviewer
    # flagged (e.g. "over-engineered — a more concise change would do; reuse the
    # existing helper"). This is the reviewer telling the impl agent what to fix.
    local review_feedback="" _review_feedback_file="${LOG_DIR:-$(dirname "$SCRIPT_DIR")/logs}/review-feedback-${story_id}.json"
    if [ -f "$_review_feedback_file" ]; then
        # BLOCKERS FIRST, AND SEPARATELY. Rendering every finding into one flat list let a
        # blocker-severity requirement ("no tests were added") sit beside advisory notes about
        # over-engineering, under a preamble ending "do not add more code". The writer averaged
        # them and produced nothing three cycles running, and the story was still marked
        # complete. A required deliverable and a suggestion must not look alike.
        review_feedback=$(jq -r '
          def render: map(
            "- [" + (.severity // "issue") + "] " + (.description // "")
            + (if (.file // "") != "" then " (" + .file + (if (.line // 0) > 0 then ":" + (.line|tostring) else "" end) + ")" else "" end)
            + (if (.suggestedFix // "") != "" then "\n  - Suggested fix: " + .suggestedFix else "" end)
          ) | join("\n");
          (.issues // []) as $all
          | ($all | map(select((.severity // "") == "blocker"))) as $blockers
          | ($all | map(select((.severity // "") != "blocker"))) as $rest
          | (if ($blockers | length) > 0 then "### BLOCKERS — this attempt is REJECTED until every one is resolved\n" + ($blockers | render) + "\n" else "" end)
          + (if ($rest | length) > 0 then "### Advisory — apply where it makes the change smaller or clearer\n" + ($rest | render) else "" end)
          ' "$_review_feedback_file" 2>/dev/null || echo "")
    fi

    # Persisted skill notes (cross-run learning — found live 2026-08-02):
    # profiles.json's [Self-Heal] notes (both FailureAnalyst's tsc/test-failure
    # diagnoses and Step 3.6's review-rejection lessons, see
    # _persist_skill_note_simple() in lib/story-guards.sh) were being WRITTEN
    # correctly but never READ back into this prompt — the only functions that
    # ever consulted profiles.json's role text were the REVIEWER's own persona,
    # FailureAnalyst's own diagnostic context (a different prompt, not this
    # one), and duplicate-check gates before appending a NEW note. A brand new
    # run's first attempt at a story never saw a single word of what a PRIOR
    # run had already learned about it. Confirmed live: upexpress's writer
    # reproduced the IDENTICAL dead-code live_preview-forwarding defect on a
    # fresh relaunch despite two prior review rejections and a correctly
    # persisted, file/line-precise note — this is the fix. review_feedback
    # (above) covers the SAME-run retry loop; this covers what a prior, now-
    # finished run already learned. Scoped to [Self-Heal] lines only — the
    # rest of a role's profile text is its base persona/instructions, already
    # a much larger, separate concern.
    local skill_note_block=""
    local story_role
    story_role=$(echo "$story_json" | jq -r '.agentRole // ""' 2>/dev/null || echo "")
    if [ -n "$story_role" ] && [ -f "$AGENT_PROFILES_FILE" ]; then
        local _persisted_skill_notes
        # Notes are persisted as \n\n-separated paragraphs (see
        # _persist_skill_note_simple(), lib/story-guards.sh), each starting
        # with "[Self-Heal] " — a plain-line grep only keeps the FIRST line of
        # a multi-line note, silently truncating the actual diagnosis
        # (e.g. the specific functions/ACs a real persisted note names).
        # Paragraph-mode awk (RS="") keeps each whole note intact.
        # Notes are appended into the agent's persona, so they come from wherever the persona
        # does — the roster. `|| true`: an agent with no notes is the normal case, and this is
        # context for the writer rather than a gate, so absence must not stop a story.
        _persisted_skill_notes=$(roster_persona "$story_role" 2>/dev/null | \
            awk -v RS='' -v ORS='\n\n' '/\[Self-Heal\]/' || true)
        if [ -n "$_persisted_skill_notes" ]; then
            skill_note_block=$(printf '\n## Lessons From Prior Runs (persisted — a previous attempt at this or a similar story already hit these problems)\n%s\n' "$_persisted_skill_notes")
        fi
    fi

    # testCriteria — written by TC writer from actual source; ground truth for test stories.
    # Extracted after worktree path rewriting (TC fields don't contain absolute paths).
    local tc_facts tc_mock_strategy tc_banned
    tc_facts=$(echo "$story_json" | jq -r '.testCriteria.facts // [] | map("- " + .) | join("\n")' 2>/dev/null || echo "")
    tc_mock_strategy=$(echo "$story_json" | jq -r '.testCriteria.mockStrategy // ""' 2>/dev/null || echo "")
    tc_banned=$(echo "$story_json" | jq -r '.testCriteria.bannedPatterns // [] | join(", ")' 2>/dev/null || echo "")

    # Exact String Invariant guardrail (found live, 2026-07-06): SKY-002-impl
    # failed 8 times with 8 DIFFERENT bugs, several of them a slightly-wrong
    # paraphrase of an AC's literal error-message string (e.g. "via the
    # constructor" instead of "via the constructor options.apiKey"). A quoted
    # substring in an AC is a literal test assertion, not a summary the model
    # is free to reword — extract every quoted string and tell it explicitly
    # not to paraphrase them. Deterministic (no LLM judgment about which
    # strings matter); fully generic (works for any story's ACs, not just
    # SKY-002's).
    local string_invariants string_invariants_block=""
    string_invariants=$(printf '%s' "$acceptance_criteria" | grep -oE '"[^"]{3,}"' | sort -u)
    if [ -n "$string_invariants" ]; then
        _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-string-invariants-vals-XXXXXX.json")
        jq_vals \
              --arg string_list "$(printf '%s\n' "$string_invariants" | sed 's/^/- /')" \
              '{"__STRING_LIST__":$string_list}' > "$_cp_vals"
        string_invariants_block="$(render_engine_prompt writer-string-invariants "$_cp_vals")"
        rm -f "$_cp_vals"
    fi

    # Build a write-first directive listing each file with its exact absolute path
    local write_first_lines=""
    # Brownfield: inject each existing file's REAL content directly into the
    # prompt (deterministic, one bash `cat`/`head` per file) instead of just
    # instructing "ReadFile these first". Same established pattern as
    # dependency_contracts below ("Inject it directly so it's guaranteed, not
    # requested") — applied here because telling the agent to read via tool
    # calls, while it fixed hallucination, traded it for a NEW problem: each
    # ReadFile result accumulates in conversation history, and every
    # subsequent turn in the same ReAct loop resends that whole growing
    # transcript. Found live 2026-07-23 (AMSD-1820, post-fix): the static
    # prompt itself measured ~3,000 tokens, but attempts were reporting
    # ~240,000 input tokens and then failing with 0 output bytes — a real
    # multi-file service investigation ballooned the accumulated transcript
    # far past what a single static injection would ever cost. Injecting
    # content ONCE, deterministically, in bash gives the same real grounding
    # at a small, fixed, one-time cost instead of a cost that multiplies with
    # every tool-call turn the agent takes.
    local existing_file_contents=""
    # From orchestrations/config/spec-mode-defaults.json (existingFileInjection.maxLinesPerFile),
    # not a literal: this is the largest single term in writer prompt size — 34,510 of 86,809
    # chars live on AMSD-2041, re-paid on every attempt — and the guidance trim cannot touch it.
    local _EXISTING_FILE_MAX_LINES
    # `|| return 1`, matching prompt_trim_threshold rather than falling back to a silent
    # default: an unreadable budget means the config is wrong, and a hidden 400 would hide that
    # while quietly re-introducing the literal this moved out of the code.
    _EXISTING_FILE_MAX_LINES="$(existing_file_max_lines)" || return 1
    # Inject FULL content ONLY for the detective's fix-site file(s). Injecting every
    # declared file (5 for AMSD-1820) ballooned the impl prompt to 137-189K input tokens,
    # and the agent burned its whole output budget exploring before ever calling WriteFile
    # (live 2026-07-24: in=137K out=1707, zero writes → deliverable gate failed → 8 retries).
    # Non-fix-site declared files are listed as paths (agent ReadFiles on demand). When there
    # is no fixSiteAnalysis (novel work / no detective result), inject all files (fallback).
    local _fixsite_rel
    _fixsite_rel=$(echo "$story_json" | jq -r '[.fixSiteAnalysis[]?.file] | map(select(. != null and . != "")) | .[]' 2>/dev/null)
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        # Resolve to absolute path; in worktree mode, rewrite main-repo absolute paths
        # to the worktree so the agent writes files in the correct directory.
        local abs_f
        if [[ "$f" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$f" = "${MAIN_PROJECT_ROOT}"* ]]; then
                abs_f="${PROJECT_ROOT}${f#${MAIN_PROJECT_ROOT}}"
            else
                abs_f="$f"
            fi
        else
            abs_f="$PROJECT_ROOT/$f"
        fi
        # A declared path may be wrong in extension or case while the real file
        # genuinely exists (live 2026-07-30: declared ContentstackContext.tsx,
        # repo holds contentstackContext.tsx — the model's conventional
        # PascalCase guess for a React Context, not what the repo actually
        # contains). A bare `[ -f "$abs_f" ]` here failed on that mismatch, so
        # this loop told the agent the file did NOT exist and to WRITE it,
        # which it did — leaving a duplicate file under the wrong name/case
        # and the real one untouched, 7 identical attempts before this existed.
        # Resolve through the SAME function verify_story_deliverables uses, so
        # the prompt and the post-hoc check can never disagree about whether a
        # declared file is real.
        local _resolved_abs_f
        if _resolved_abs_f="$(_resolve_deliverable_path "$abs_f")"; then
            [ "$_resolved_abs_f" != "$abs_f" ] && \
                log "  Deliverable '$f' resolved to '${_resolved_abs_f#"$PROJECT_ROOT"/}' for prompt injection (declaration's case/extension did not match the repository)"
            abs_f="$_resolved_abs_f"
        fi
        # Inject CONTENT only for a fix-site file (or all, when no fixSiteAnalysis exists).
        local _rel_f _inject_content
        _rel_f="${abs_f#"$PROJECT_ROOT"/}"
        if [ -z "$_fixsite_rel" ] || printf '%s\n' "$_fixsite_rel" | grep -qxF "$_rel_f"; then _inject_content=1; else _inject_content=0; fi
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            if [ "$_inject_content" = "1" ] && [ -f "$abs_f" ]; then
                write_first_lines="${write_first_lines}   - ${abs_f} (content already injected below — do not ReadFile it unless you need lines beyond what's shown)\n"
                local _total_lines
                _total_lines=$(wc -l < "$abs_f" 2>/dev/null || echo 0)
                local _body
                _body=$(head -n "$_EXISTING_FILE_MAX_LINES" "$abs_f" 2>/dev/null)
                existing_file_contents="${existing_file_contents}
### ${abs_f}
\`\`\`
${_body}
\`\`\`
"
                if [ "${_total_lines:-0}" -gt "$_EXISTING_FILE_MAX_LINES" ]; then
                    existing_file_contents="${existing_file_contents}(truncated at ${_EXISTING_FILE_MAX_LINES} of ${_total_lines} lines — ReadFile this path yourself if you need the rest)
"
                fi
            else
                write_first_lines="${write_first_lines}   - ${abs_f} (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)\n"
            fi
        else
            write_first_lines="${write_first_lines}   - WRITE ${abs_f} first, before any other action\n"
        fi
    done < <(story_declared_files "$story_json")

    # Brownfield testing policy — the "no wild tests" gate. Greenfield writes
    # new code + its own new tests. Brownfield MODIFIES existing code: the
    # existing suite already runs (Step 5 regression guard + Step 4.5 unit
    # gate), so a modified file that already has covering tests needs NO new
    # test. Only a modified file with ZERO covering tests warrants ONE targeted
    # test. We compute exactly that set deterministically here (CodeGraph's
    # `affected`) and tell the agent — so it never generates speculative tests
    # for already-covered code just because an AC says "add tests".
    local brownfield_test_policy=""
    # For a DEFECT (fix site known), the repro-gate REQUIRES a new bug-reproducing
    # test EVEN IF the file already has coverage — the bug escaped that coverage by
    # definition. The dedicated repro-test-writer now authors it (impl is told the
    # test is NOT its job — see test_ownership_block above). Skip the
    # coverage-based "don't write unnecessary tests / already covered → out of scope"
    # policy for defects: it DIRECTLY CONTRADICTED the repro-gate and was the live
    # cause of the missing test (AMSD-1820, 2026-07-24 — the agent was told the file
    # "ALREADY has covering tests. Do NOT write any new test file", so it shipped
    # none). The coverage policy still applies to non-defect brownfield changes.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "$_has_fix_plan" ]; then
        local _story_rel_files=()
        while IFS= read -r _sf; do
            [ -z "$_sf" ] && continue
            # Gate wants repo-relative paths; strip any absolute PROJECT_ROOT prefix.
            _story_rel_files+=("${_sf#"$PROJECT_ROOT"/}")
        done < <(story_declared_files "$story_json")
        if [ "${#_story_rel_files[@]}" -gt 0 ]; then
            local _uncovered _gate_rc=0
            _uncovered=$(PROJECT_ROOT="$PROJECT_ROOT" NODE_BIN="${NODE_BIN:-node}" \
                bash "$SCRIPT_DIR/brownfield-coverage-gate.sh" "${_story_rel_files[@]}" 2>/dev/null) || _gate_rc=$?
            if [ "$_gate_rc" -eq 3 ]; then
                # Gate couldn't determine coverage (no index) — do not claim
                # anything; fall back to the default AC-driven behavior.
                brownfield_test_policy=""
            elif [ -n "$_uncovered" ]; then
                brownfield_test_policy=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/render-prompt-section.js" \
                    "$SCRIPT_DIR/../config/agent-contract.json" "brownfieldTestPolicy.someUncovered" \
                    "uncovered=$(printf '%s\n' "$_uncovered" | sed 's/^/  - /')" 2>/dev/null || echo "")
            else
                brownfield_test_policy=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/render-prompt-section.js" \
                    "$SCRIPT_DIR/../config/agent-contract.json" "brownfieldTestPolicy.allCovered" \
                    "uncovered=$(printf '%s\n' "$_uncovered" | sed 's/^/  - /')" 2>/dev/null || echo "")
            fi
        fi
    fi

    # "Do NOT investigate" is right for greenfield (nothing exists yet to
    # read — the failure mode this directive originally fixed was agents
    # describing a plan in prose and never calling WriteFile at all). It is
    # actively wrong for brownfield: forbidding the agent from reading an
    # EXISTING file before modifying it guarantees it can't see the file's
    # real exports/utilities, and it will hallucinate plausible-sounding ones
    # instead. Found live 2026-07-23 (AMSD-1820): agent invented a
    # non-existent `@eps/utils` import and wrong export names across 8
    # attempts, at every model tier including the ladder's highest, because
    # it was told "do NOT read files, do NOT investigate" on every attempt.
    local write_first_directive
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        write_first_directive="CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below."
    else
        write_first_directive="CRITICAL — WRITE FILES FIRST. Your FIRST tool call MUST be WriteFile.
Do NOT output any text before calling WriteFile. Do NOT plan or say \"I will...\".
Call WriteFile NOW for the EXACT ABSOLUTE PATHS listed below:"
    fi

    # CodeGraph tool (brownfield only): the agent can query the existing codebase
    # to CONFIRM an existing helper before writing new logic. The prescribed fix
    # (Root Cause Analysis, above) may name a helper to reuse; this lets the agent
    # verify its exact symbol + import path rather than hallucinate one. Reusing
    # an existing function instead of hand-rolling a new one is the whole point —
    # fewer lines, no duplicated logic (found live 2026-07-23, AMSD-1820: the
    # agent invented split-discount logic and a phantom field instead of reusing
    # the existing key parser the one-line fix needed).
    local codegraph_tool_block=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && command -v codegraph >/dev/null 2>&1; then
        # When the detective already prescribed the exact helper to reuse
        # (fixSiteAnalysis[].helper), do NOT push CodeGraph exploration — it drives the
        # agent to burn ReAct turns re-finding a helper it was already handed, and the
        # re-sent conversation balloons input to 137-189K tokens so it never reaches
        # WriteFile (live 2026-07-24, AMSD-1820). Give a minimal "apply directly" note.
        # Full exploration block only when NO helper is prescribed (genuine novel work).
        # EVERY HELPER THE GUARD ENFORCES, NOT JUST THE FIRST ONE.
        #
        # This read `.[0]` while the ReuseGuard (~line 9881) enforces the WHOLE set, with
        # the same filter the guard uses:
        #     map(select(.fixVerified == true and .helper != "")) | map(.helper) | unique
        #
        # So the writer was told about ONE symbol and rejected for the others — and the
        # note built from this value also tells it "Do NOT run CodeGraph or explore the
        # codebase", so it could not discover the rest either.
        #
        # Live, run of 2026-08-15 13:24 (metrolinx, AMSD-2041), killed at attempt 5 of 12:
        #     prompt: reuse `Stack`
        #     guard:  ReuseGuard: 'ContentstackContext:Stack:getContentByKey:useContent'
        #     [HealingBroken] CRITICAL: '...without importing or calling the prescribed
        #     getContentByKey helper...' has recurred 2+ times — self-healing is NOT working.
        #
        # The loop could not converge: the corrective symbol never entered the prompt, so
        # every retry repeated the omission and the ladder escalated to no purpose. One
        # list, one source — "reuse these" and "you must reuse these" are now the same set.
        local _prescribed_helper _prescribed_helper_list
        _prescribed_helper_list=$(echo "$story_json" | jq -r '
            (.fixSiteAnalysis // [])
            | map(select((.fixVerified == true) and ((.helper // "") != "")))
            | map(.helper) | unique | join(", ")' 2>/dev/null)
        # Kept for the single-helper phrasing below; empty when nothing is prescribed.
        _prescribed_helper="$_prescribed_helper_list"
        # This suppression must NOT fire blind to fixSiteAnalysisCoverage
        # (checkFixSiteCoverage, spec-mode-runner.js). "A helper is named" only
        # means SOME site is minimal — it says nothing about verification
        # criteria the detective's findings never touched. Telling the model
        # "do NOT explore... apply the prescribed fix... and stop" with only a
        # soft escape hatch ("only search if you hit something the fix
        # genuinely does not cover") relies on the model noticing a gap on its
        # own — the exact judgment failure the coverage check exists to catch
        # deterministically instead of hoping for.
        local _cov_incomplete _uncovered_list
        _cov_incomplete=$(echo "$story_json" | jq -r '(if .fixSiteAnalysisCoverage.complete == null then "false" elif .fixSiteAnalysisCoverage.complete == false then "true" else "false" end)' 2>/dev/null)
        _uncovered_list=$(echo "$story_json" | jq -r '(.fixSiteAnalysisCoverage.uncoveredVerificationCriteria // []) | map("- " + .) | join("\n")' 2>/dev/null)
        if [ -n "$_prescribed_helper" ] && [ "$_cov_incomplete" != "true" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-codegraph-block-vals-XXXXXX.json")
            jq_vals \
                  --arg prescribed_helper "${_prescribed_helper}" \
                  '{"__PRESCRIBED_HELPER__":$prescribed_helper}' > "$_cp_vals"
            codegraph_tool_block="$(render_engine_prompt writer-codegraph-block "$_cp_vals" helper_identified)"
            rm -f "$_cp_vals"
        elif [ -n "$_prescribed_helper" ] && [ "$_cov_incomplete" = "true" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-codegraph-block-vals-XXXXXX.json")
            jq_vals \
                  --arg prescribed_helper "${_prescribed_helper}" \
                  --arg uncovered_list "${_uncovered_list}" \
                  '{"__PRESCRIBED_HELPER__":$prescribed_helper,"__UNCOVERED_LIST__":$uncovered_list}' > "$_cp_vals"
            codegraph_tool_block="$(render_engine_prompt writer-codegraph-block "$_cp_vals" fix_incomplete)"
            rm -f "$_cp_vals"
        else
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-codegraph-block-vals-XXXXXX.json")
            jq -n \
                  '{}' > "$_cp_vals"
            codegraph_tool_block="$(render_engine_prompt writer-codegraph-block "$_cp_vals" tool_available)"
            rm -f "$_cp_vals"
        fi
    fi

    # CRITERIA A PREVIOUS ATTEMPT LEFT UNTESTED.
    #
    # vc-coverage-check.sh (Step 3.56) compares every verification criterion against the tests a
    # story produced and writes $LOG_DIR/vc-coverage-<story>.json. Nothing read it until now.
    #
    # TIMING, STATED PLAINLY: that check runs AFTER the writer, so on the first attempt of a
    # fresh run no artifact exists and this block is empty. It carries a previous attempt's or a
    # previous run's findings into a RESUME or a RETRY — which is exactly when the writer has
    # already produced tests that missed something and can still act on it. It is advisory here;
    # the REVIEWER is where an uncovered criterion is judged, because deciding that a criterion
    # is genuinely untestable in this environment is a judgement, not an engine rule.
    _uncovered_vc_block=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/vc-coverage-findings.js" \
        "${LOG_DIR:-}" "$story_id" "$SCRIPT_DIR/../config/agent-contract.json" 2>/dev/null || echo "")

    # New-dependency directive. Live metrolinx 2026-07-30/31: the model's own
    # output, at every tier including the top of the model ladder, was the
    # identical stall — it correctly diagnosed that the fix needed a package
    # not yet in the project, said "let me check if X can be installed," and
    # then took no action. The sentence repeated verbatim and the turn ended,
    # burning the full watchdog timeout each time. Every model hit the same
    # wall, which rules out "not smart enough" — nothing had ever told it
    # that adding an import for a missing package is a normal, already-
    # automated step; it stalled asking permission for something the
    # pipeline had already solved.
    #
    # Fires ONLY when a dependency-check manifest actually exists for this
    # project — that manifest's presence is what makes the claim true. A
    # project with no manifest gets no directive, not a false promise.
    # Generic on purpose: no package name, language, or install command
    # appears here, the same way dependency-check.json's own installCommand
    # is config-supplied rather than hardcoded to npm/pip/cargo.
    #
    # THE DIRECTIVE IS A TEMPLATE, and its three facts come from the codeline. The prose used to
    # live here as a shell string that promised the install happened by itself; AMSD-2041 followed
    # it, and the lockfile never moved. See prompts/templates/new-dependency-directive.json.
    # GATED ON WHAT IT NEEDS, which is a known ecosystem — not on .epam/dependency-check.json.
    #
    # That file gated the ORIGINAL text, correctly: it promised "missing imports are detected and
    # installed automatically", true only where the project declares autoInstall. The replacement
    # promises nothing and tells the writer to run the add-command itself, so what it requires is a
    # manifest, a lockfile and an add-command — all from lib/ecosystem-registry.js.
    #
    # Live metrolinx AMSD-2041, 2026-08-19: that file was absent from the codeline, so lockfile-sync
    # blocked four times while the one instruction that makes the block actionable was switched off.
    # The writer was told what was wrong and never how to fix it.
    local new_dependency_directive=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        local _nd_facts _nd_install _nd_manifest _nd_lock
        _nd_facts=$("${NODE_CMD:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$PROJECT_ROOT" 2>/dev/null || echo '{}')
        # The PROJECT's own per-package install command wins when it declares one; the ecosystem
        # answers otherwise. `{package}` is the placeholder both use.
        _nd_install="$(_project_install_command 2>/dev/null || true)"
        [ -n "$_nd_install" ] || _nd_install=$(printf '%s' "$_nd_facts" | jq -r '.addCommand // ""')
        _nd_install="${_nd_install//\{package\}/<package>}"
        _nd_manifest=$(printf '%s' "$_nd_facts" | jq -r '.manifest // ""')
        _nd_lock=$(printf '%s' "$_nd_facts" | jq -r '.lockfile // ""')
        # THE INSTALL COMMAND IS THE ONLY HARD REQUIREMENT. A directive that tells an agent to run
        # "" is worse than none. The lockfile half is separate and conditional: a codeline with no
        # lockfile still needs the half that stops it stalling, which is why this directive exists.
        if [ -n "$_nd_install" ]; then
            local _nd_note=""
            if [ -n "$_nd_manifest" ] && [ -n "$_nd_lock" ]; then
                local _nd_nvals; _nd_nvals=$(mktemp "${TMPDIR:-/tmp}/new-dep-note-XXXXXX")
                jq_vals --arg manifest "$_nd_manifest" --arg lock "$_nd_lock" \
                  '{"__MANIFEST_FILE__":$manifest,"__LOCKFILE__":$lock}' > "$_nd_nvals"
                # The library's contract: non-zero means NOTHING was rendered. `|| true` turned
                # that into an empty note, and 2>/dev/null hid the reason — "a template value
                # no producer supplies" is a real, recurring live failure, and this made it
                # silent. The note is genuinely optional, so a failure is not fatal, but it is
                # never invisible.
                if ! _nd_note="$(render_engine_prompt new-dependency-lockfile-note "$_nd_nvals")"; then
                    warning "  [prompt] new-dependency-lockfile-note did not render — the writer gets no lockfile note"
                    _nd_note=""
                fi
                rm -f "$_nd_nvals"
            fi
            local _nd_vals; _nd_vals=$(mktemp "${TMPDIR:-/tmp}/new-dep-vals-XXXXXX")
            jq_vals --arg install "$_nd_install" --arg note "$_nd_note" \
              '{"__INSTALL_COMMAND__":$install,"__LOCKFILE_NOTE__":$note}' > "$_nd_vals"
            # NOT OPTIONAL. This directive is how the writer is told to install a new
            # dependency at all; empty, the agent is invoked knowing nothing about it and
            # invents an install step or skips one. Rendered or refused, never blank.
            if ! new_dependency_directive="$(render_engine_prompt new-dependency-directive "$_nd_vals")"; then
                error "  [prompt] new-dependency-directive did not render — refusing to invoke the writer without it"
                rm -f "$_nd_vals"
                return 1
            fi
            rm -f "$_nd_vals"
        fi
    fi

    # Deterministic contract injection — root cause of a recurring live-run
    # failure (validated live: baseline model call guessed the wrong import
    # path './skyscanner-client'; with the dependency's contract injected,
    # it used the correct './skyscanner/client' every time). The typescript-
    # engineer profile already instructs agents to WRITE a contract file
    # after finishing (.contracts/<storyId>.md — exact exports, constructor
    # signature, ready-to-paste import/mock pattern) — but nothing ever READ
    # it back for a dependent story. Reading was 100% dependent on the
    # dependent story's agent choosing to open the file itself, which it
    # unreliably did. Inject it directly so it's guaranteed, not requested.
    local dependency_contracts=""
    local _dep_ids_json="[]"
    if [ -n "$dependencies" ]; then
        _dep_ids_json=$(echo "$story_json" | jq -c '[(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]')
        local _dep_id
        while IFS= read -r _dep_id; do
            [ -z "$_dep_id" ] && continue
            local _contract_file="$PROJECT_ROOT/.contracts/${_dep_id}.md"
            if [ -f "$_contract_file" ]; then
                dependency_contracts="${dependency_contracts}
### Contract: ${_dep_id}
$(cat "$_contract_file")
"
            fi
        done < <(echo "$_dep_ids_json" | jq -r '.[]?')
    fi

    # THE INTERFACE THIS STORY CONSUMES FROM A SHARED FILE IT DOES NOT OWN (spec-time decision,
    # see sharedFileBlock in spec-mode-runner.js) — briefed here, beside the owner's contract,
    # so the writer codes against the signature rather than reopening the file.
    dependency_contracts="${dependency_contracts}$(consumed_interfaces_block "$story_json")"

    # Third-party package grounding (found live 2026-07-30, AMSD-2041): the
    # loop above ground-truths INTERNAL dependencies only. A story writing
    # config for a third-party SDK had nothing but training memory to go on —
    # the same "Config object doesn't match the SDK's Config type" defect
    # recurred 3 times because nobody, implementer or self-heal, ever saw the
    # real type. Reuses .epam/dependency-check.json's importPattern/vendorDirs
    # (already proven by run_dependency_check) purely to DISCOVER what the
    # story's own declared files import; generates .contracts/vendor-<pkg>.md
    # from the installed package's own source the same way generate_story_
    # contract() already does for the story's own code. No manifest = no-op.
    local _vendor_files_json _vendor_file _vendor_pkg
    # Lane-resolved, same as every other consumer of this story's file list.
    _vendor_files_json=$(story_declared_files "$story_json" | jq -R . | jq -sc .)
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        _vendor_files_json="${_vendor_files_json//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi
    while IFS= read -r _vendor_file; do
        [ -z "$_vendor_file" ] && continue
        local _vendor_abs
        [[ "$_vendor_file" = /* ]] && _vendor_abs="$_vendor_file" || _vendor_abs="$PROJECT_ROOT/$_vendor_file"
        _vendor_abs="$(_resolve_deliverable_path "$_vendor_abs" 2>/dev/null || echo "$_vendor_abs")"
        [ -f "$_vendor_abs" ] || continue
        while IFS= read -r _vendor_pkg; do
            [ -z "$_vendor_pkg" ] && continue
            local _vendor_contract="$PROJECT_ROOT/.contracts/vendor-${_vendor_pkg}.md"
            [ -f "$_vendor_contract" ] || _generate_vendor_contract "$PROJECT_ROOT" "$_vendor_pkg" 2>/dev/null
            if [ -f "$_vendor_contract" ]; then
                dependency_contracts="${dependency_contracts}
### Vendor package: ${_vendor_pkg}
$(cat "$_vendor_contract")
"
            fi
        done < <(_discover_vendor_packages "$_vendor_abs" 2>/dev/null)
    done < <(echo "$_vendor_files_json" | jq -r '.[]?')

    # Spec-reality cross-check (added 2026-07-06 — see project_backlog memory
    # "Spec-reality cross-check"). Root cause this catches: the PRD itself is
    # an LLM-authored/elaborated artifact, just as hallucination-prone as
    # agent-generated code — a live defect had SKY-003's own description
    # assert "Instantiate SkyscannerClient from `src/skyscanner-client.ts`"
    # when the real file SKY-002 built was at `src/skyscanner/client.ts`. The
    # model faithfully followed a WRONG instruction baked into its own task
    # description — hooks (session-time, per-WriteFile) would NOT catch this,
    # since the bug is in what the agent was TOLD, not in what it produced.
    # Deterministically extracts backtick-quoted path-like strings from this
    # story's own description/ACs and checks each against a dependency's REAL
    # technicalNotes.files (ground truth, not model-transcribed) — flagging a
    # mismatch instead of silently injecting the correct contract ALONGSIDE
    # an uncorrected wrong claim (which is what happened live: the agent saw
    # both the correct contract and the wrong prose path and still guessed
    # wrong on early attempts).
    local spec_reality_warning=""
    if [ "$_dep_ids_json" != "[]" ]; then
        local _dep_files_json
        _dep_files_json=$(jq -c --argjson ids "$_dep_ids_json" \
            '[.stories[] | select(.id as $sid | $ids | index($sid)) | .technicalNotes.files[]? // empty]' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        spec_reality_warning=$(python3 "$SCRIPT_DIR/lib/handlers/spec-reality-warning.py" "$description" "$acceptance_criteria" "$_dep_files_json"
)
    fi

    # THE CRITERIA THE WRITER MUST SATISFY, from the run's PRD. The template's "## Acceptance
    # Criteria" heading stood over nothing AC-related — only the brownfield VC block — so a
    # greenfield writer, whose whole brief is the ACs, read an empty heading (2026-09-13). The
    # heading is the template's; the block carries the numbered criteria, or nothing.
    local story_acs
    story_acs=$(story_acs_block "${MAIN_PRD_FILE:-$PRD_FILE}" "$story_id" "")
    _sw_vals=$(mktemp "${TMPDIR:-/tmp}/story-writer-main-vals-XXXXXX.json")
    jq -n \
          --arg story_acs "$story_acs" \
          --arg spec_reality_warning "$([ -n "$spec_reality_warning" ] && printf '%s\n\n' "$spec_reality_warning" || true)" \
          --arg write_first_lines "$(printf '%b' "$write_first_lines")" \
          --arg string_invariants_block "$([ -n "$string_invariants_block" ] && printf '%s\n' "$string_invariants_block" || true)" \
          --arg review_feedback "$([ -n "$review_feedback" ] && printf '\n## Reviewer Feedback — ADDRESS THESE (a prior code review requested changes)\nThe team-lead reviewer examined your previous attempt and requested the changes below. This is the highest priority.\n\nA BLOCKER is a required deliverable, not advice. If a blocker says something is MISSING — a test, a file, a case — the only way to resolve it is to CREATE it; leaving it out repeats the rejection. Minimality governs HOW MUCH you write, never WHETHER you write it.\n\nFor advisory points: make the smallest edits that resolve each one, and where a point says the change is over-engineered or an existing helper would do, REMOVE the excess rather than adding more.\n\nIf you genuinely cannot satisfy a blocker — no seam exists to test against, the behaviour lives entirely in a third-party package — say so explicitly in your final message, naming the blocker and why. An unexplained omission reads as a refusal and will be rejected again.\n%s\n' "$review_feedback" || true)" \
          --arg skill_note_block "$([ -n "$skill_note_block" ] && printf '%s\n' "$skill_note_block" || true)" \
          --arg verification_criteria "$([ -n "$verification_criteria" ] && printf '\n## Verification Criteria (what a tester will CONFIRM — your change must satisfy every one)\nThese are observable checks, derived from the acceptance criteria and description. They describe WHAT is observed, not how to build it. Make the minimal change that makes all of these true; your accompanying test should assert them:\n%s\n' "$verification_criteria" || true)" \
          --arg codeline_facts_block "$([ -n "$codeline_facts_block" ] && printf '%s\n' "$codeline_facts_block" || true)" \
          --arg project_tools_block "$([ -n "$project_tools_block" ] && printf '%s\n' "$project_tools_block" || true)" \
          --arg test_ownership_block "$([ -n "$test_ownership_block" ] && printf '%s\n' "$test_ownership_block" || true)" \
          --arg codegraph_tool_block "$([ -n "$codegraph_tool_block" ] && printf '\n%s\n' "$codegraph_tool_block" || true)" \
          --arg uncovered_vc_block "$([ -n "$_uncovered_vc_block" ] && printf '\n%s\n' "$_uncovered_vc_block" || true)" \
          --arg brownfield_test_policy "$([ -n "$brownfield_test_policy" ] && printf '\n%s\n' "$brownfield_test_policy" || true)" \
          --arg new_dependency_directive "$([ -n "$new_dependency_directive" ] && printf '\n%s\n' "$new_dependency_directive" || true)" \
          --arg tc_facts "$([ -n "$tc_facts" ] && printf '\n## Test Criteria (ground truth — written from actual source; overrides any conflicting AC)\n%s\n' "$tc_facts" || true)" \
          --arg tc_mock_strategy "$([ -n "$tc_mock_strategy" ] && printf '\n## Mock Strategy\n%s\n' "$tc_mock_strategy" || true)" \
          --arg tc_banned "$([ -n "$tc_banned" ] && printf '\n## Banned Patterns (must NOT appear in your file)\n%s\n' "$tc_banned" || true)" \
          --arg technical_notes "$(_render_technical_notes "$technical_notes" "$_lane")" \
          --arg existing_file_contents "$([ -n "$existing_file_contents" ] && printf '\n## Existing File Contents (injected once, deterministically — do NOT ReadFile these unless you need more than shown)\n%s\n' "$existing_file_contents" || true)" \
          --arg dependency_contracts "$([ -n "$dependency_contracts" ] && printf '\n## Dependency Contracts (EXACT import paths and signatures — use these verbatim, do NOT guess a different path)\n%s\n' "$dependency_contracts" || true)" \
          --arg module_resolution "$(_module_resolution_context "$PROJECT_ROOT" 2>/dev/null || true)" \
          --arg cross_codeline_contract "$([ -n "${CROSS_CODELINE_CONTRACT:-}" ] && [ -f "${CROSS_CODELINE_CONTRACT}" ] && printf '\n## Cross-Codeline API Contract (upstream codeline exports — use these types and endpoints verbatim when integrating)\n%s\n' "$(cat "${CROSS_CODELINE_CONTRACT}")" || true)" \
          --arg write_first_lines_2 "$(printf '%b' "$write_first_lines")" \
          --arg conditional_section "$(if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  echo "**The content of every file listed above is already shown in ## Existing File Contents — use that, do not spend a tool call re-reading them. Use Edit for targeted changes to existing files — do NOT overwrite an existing file wholesale with WriteFile.**"
else
  echo "**You MUST write every file listed above to its EXACT absolute path. Do NOT write to a different path, do NOT write to the current directory unless it matches the path above. Use your WriteFile or Edit tools with the full absolute path shown.**"
fi)" \
          --arg conditional_section_2 "$(if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  echo "1. Use the injected ## Existing File Contents above to verify what actually exists (exports, types, existing utilities) before writing any code — do not guess, and do not re-read a file already shown in full"
else
  echo "1. Write each required file to its exact absolute path listed above — do this FIRST before anything else"
fi)" \
          --arg tc_facts_2 "$([ -n "$tc_facts" ] && echo "3. Test Criteria facts above are ground truth — your test assertions MUST match them exactly" || echo "3. Follow the project's existing code patterns and conventions")" \
          --arg write_first_directive "$write_first_directive" \
          --arg dependencies "${dependencies:-None}" \
          --arg acceptance_criteria "$acceptance_criteria" \
          --arg agent_inputs "$agent_inputs" \
          --arg description "$description" \
          --arg story_id "$story_id" \
          --arg title "$title" \
          --arg files "$files" \
          --arg prd_configuration_block "$prd_configuration_block" \
          '{"__STORY_ACS__":$story_acs,"__SPEC_REALITY_WARNING__":$spec_reality_warning,"__WRITE_FIRST_LINES__":$write_first_lines,"__STRING_INVARIANTS_BLOCK__":$string_invariants_block,"__REVIEW_FEEDBACK__":$review_feedback,"__SKILL_NOTE_BLOCK__":$skill_note_block,"__VERIFICATION_CRITERIA__":$verification_criteria,"__CODELINE_FACTS_BLOCK__":$codeline_facts_block,"__PRD_CONFIGURATION_BLOCK__":$prd_configuration_block,"__PROJECT_TOOLS_BLOCK__":$project_tools_block,"__TEST_OWNERSHIP_BLOCK__":$test_ownership_block,"__CODEGRAPH_TOOL_BLOCK__":$codegraph_tool_block,"__UNCOVERED_VC_BLOCK__":$uncovered_vc_block,"__BROWNFIELD_TEST_POLICY__":$brownfield_test_policy,"__NEW_DEPENDENCY_DIRECTIVE__":$new_dependency_directive,"__TC_FACTS__":$tc_facts,"__TC_MOCK_STRATEGY__":$tc_mock_strategy,"__TC_BANNED__":$tc_banned,"__TECHNICAL_NOTES__":$technical_notes,"__EXISTING_FILE_CONTENTS__":$existing_file_contents,"__DEPENDENCY_CONTRACTS__":$dependency_contracts,"__MODULE_RESOLUTION__":$module_resolution,"__CROSS_CODELINE_CONTRACT__":$cross_codeline_contract,"__WRITE_FIRST_LINES_2__":$write_first_lines_2,"__CONDITIONAL_SECTION__":$conditional_section,"__CONDITIONAL_SECTION_2__":$conditional_section_2,"__TC_FACTS_2__":$tc_facts_2,"__WRITE_FIRST_DIRECTIVE__":$write_first_directive,"__DEPENDENCIES__":$dependencies,"__AGENT_INPUTS__":$agent_inputs,"__DESCRIPTION__":$description,"__STORY_ID__":$story_id,"__TITLE__":$title,"__FILES__":$files}' > "$_sw_vals"
    render_engine_prompt story-writer-main "$_sw_vals"
    rm -f "$_sw_vals"
}

build_generator_prompt() {
    local story_id=$1
    local story_json
    story_json=$(get_story_details "$story_id")
    local _lane
    _lane=$(_current_lane "$story_json")

    local title
    title=$(echo "$story_json" | jq -r '.title')
    local description
    description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria
    acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes
    technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    local files
    files=$(echo "$story_json" | jq -r '.technicalNotes.files // [] | join(", ")')
    local dependencies
    dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # Rewrite main-repo absolute paths to worktree path in all prompt fields
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    _hd_vals=$(mktemp "${TMPDIR:-/tmp}/story-file-generation-vals-XXXXXX.json")
    jq_vals \
          --arg technical_notes "$(_render_technical_notes "$technical_notes" "$_lane")" \
          --arg dependencies "${dependencies:-None}" \
          --arg acceptance_criteria "$acceptance_criteria" \
          --arg description "$description" \
          --arg story_id "$story_id" \
          --arg title "$title" \
          --arg files "$files" \
          '{"__TECHNICAL_NOTES__":$technical_notes,"__DEPENDENCIES__":$dependencies,"__ACCEPTANCE_CRITERIA__":$acceptance_criteria,"__DESCRIPTION__":$description,"__STORY_ID__":$story_id,"__TITLE__":$title,"__FILES__":$files}' > "$_hd_vals"
    render_engine_prompt story-file-generation "$_hd_vals"
    rm -f "$_hd_vals"
}

# Resolve a DECLARED deliverable to a real file.
#
# A declaration is often a module specifier, not a filename: a model reasoning
# about `from '@/hooks/useContent'` writes "src/hooks/useContent", and no such
# file exists — the file is useContent.ts. Live metrolinx 2026-07-29 failed all
# three lanes on exactly this, retrying until the watchdog killed each one
# (600s then 900s) to prove a filename wrong. The two lanes even disagreed on
# the prefix (src/hooks/... vs hooks/...), which is the tell that the string is
# generated rather than observed.
#
# Extensions are DISCOVERED from the repository, never hardcoded: globbing
# "<path>.*" asks the project what it actually uses, so this works unchanged on
# a .tsx, .py or .go codeline. A directory module resolves through its index.*.
#
# Ambiguity is a failure, not a coin toss: if two candidates match, the
# declaration cannot identify one file and the operator must see that rather
# than have the gate's verdict depend on glob order.
#
# Echoes the resolved path relative to PROJECT_ROOT and returns 0; returns 1 if
# nothing or more than one thing matches.
_resolve_deliverable_path() {
    # Takes the ABSOLUTE candidate path the caller already derived (which has
    # handled absolute declarations and worktree rewriting) and refines it.
    # Deriving it again from PROJECT_ROOT here would discard both.
    local _abs="${1%/}"
    # -f as well as -s: a DIRECTORY is non-empty by -s, so "src/hooks/useContent"
    # naming a directory would short-circuit here and never reach the index.*
    # lookup below.
    if [ -f "$_abs" ] && [ -s "$_abs" ]; then printf '%s\n' "$_abs"; return 0; fi
    # A FILE THE ECOSYSTEM DECLARES COMPLETE WHEN EMPTY. A Python package marker is empty by
    # design; -s failed it on every attempt of a story that had written it (regintel
    # 20260916T200108Z, 2026-09-17). Which basenames those are is the ecosystem's declaration
    # (emptyDeliverables in the codeline's manifest), never a name written here.
    if [ -f "$_abs" ] && command -v _project_dep_config_value >/dev/null 2>&1; then
        local _empty_ok
        _empty_ok=$(_project_dep_config_value "${PROJECT_ROOT:-}" emptyDeliverables 2>/dev/null | jq -r --arg b "$(basename "$_abs")" 'if type == "array" then (index($b) != null) else false end' 2>/dev/null || echo false)
        if [ "$_empty_ok" = "true" ]; then printf '%s\n' "$_abs"; return 0; fi
    fi
    # A DECLARED DIRECTORY IS A DIRECTORY. `dial/` and `docs/` existed with contents and were
    # reported missing because only a file could pass; a correct implementation was failed twice
    # and HealingBroken declared on a check that could not pass (regintel run 20260915T101555Z,
    # 2026-09-15). A directory delivers when it holds at least one non-empty file; the index.*
    # lookup below still serves a directory declared FOR its index file.
    if [ -d "$_abs" ] && [ -z "$(ls -A "$_abs"/index.* 2>/dev/null)" ]; then
        if [ -n "$(find "$_abs" -type f -size +0 -print -quit 2>/dev/null)" ]; then printf '%s\n' "$_abs"; return 0; fi
        return 1
    fi

    local _cands=() _c
    # A declaration may carry the WRONG extension, not merely a missing one:
    # observed live 2026-07-29, a story declared ContentstackContext.tsx while
    # the repository holds ContentstackContext.ts. Globbing "<path>.*" only
    # helps an extensionless declaration, so strip a trailing extension and try
    # that stem too. Determined, not assumed — the alternatives come from what
    # the repository actually contains.
    # THE STEM COMES FROM THE BASENAME, NOT THE PATH'S LAST DOT: for a dot-named entry (`.venv`)
    # the last dot is the name itself, the stem became the parent directory, and `stem.*` matched
    # every dotfile beside it — `.venv/` was resolved to `.env.example`, or reported ambiguous
    # (regintel run 20260915T101555Z). A basename with no extension has no stem to try.
    local _base="${_abs##*/}" _stem="$_abs"
    case "${_base#.}" in *.*) _stem="${_abs%.*}" ;; esac
    if [ "$_stem" != "$_abs" ]; then
        for _c in "$_stem".*; do
            [ -f "$_c" ] && [ -s "$_c" ] && _cands+=("$_c")
        done
    fi
    for _c in "$_abs".*; do
        [ -f "$_c" ] && [ -s "$_c" ] && _cands+=("$_c")
    done
    for _c in "$_abs"/index.*; do
        [ -f "$_c" ] && [ -s "$_c" ] && _cands+=("$_c")
    done

    if [ "${#_cands[@]}" -eq 1 ]; then
        printf '%s\n' "${_cands[0]}"
        return 0
    fi
    if [ "${#_cands[@]}" -gt 1 ]; then
        warning "Declared deliverable '$_abs' is ambiguous — ${#_cands[@]} files match: ${_cands[*]}"
        warning "  The declaration cannot identify one file; it needs an extension."
        return 1
    fi

    # A declaration may carry the WRONG CASE, not merely the wrong extension.
    # Live 2026-07-30: a story declared ContentstackContext.tsx (the
    # conventional PascalCase a model defaults to for a React Context) while
    # the repository's real file is contentstackContext.tsx (lowercase c). On
    # this case-SENSITIVE filesystem `[ -f ]` failed, so the implementation
    # prompt told the agent the file did not exist and to WRITE it — which it
    # did, leaving one file added under the wrong case and the real one reading
    # as deleted. 7 identical attempts, real spend each time, before this
    # existed. Scoped to the SAME DIRECTORY only: matching anywhere in the repo
    # would silently redirect a genuinely wrong path to an unrelated file that
    # happens to share a name.
    local _dir _base _lower_target _e
    _dir="$(dirname "$_abs")"
    [ -d "$_dir" ] || return 1
    _base="$(basename "$_abs")"
    _lower_target=$(printf '%s' "$_base" | tr '[:upper:]' '[:lower:]')
    _cands=()
    for _e in "$_dir"/*; do
        [ -f "$_e" ] && [ -s "$_e" ] || continue
        [ "$(printf '%s' "$(basename "$_e")" | tr '[:upper:]' '[:lower:]')" = "$_lower_target" ] && _cands+=("$_e")
    done
    # Also try the extensionless/stem form case-insensitively, so a declaration
    # that is wrong in BOTH case and extension still resolves (e.g. the repo
    # holds contentstackContext.ts against a declared ContentstackContext.tsx).
    if [ "${#_cands[@]}" -eq 0 ] && [ "$_stem" != "$_abs" ]; then
        local _stem_base _lower_stem
        _stem_base="$(basename "$_stem")"
        _lower_stem=$(printf '%s' "$_stem_base" | tr '[:upper:]' '[:lower:]')
        for _e in "$_dir"/*; do
            [ -f "$_e" ] && [ -s "$_e" ] || continue
            local _e_base_noext="${_e%.*}"
            [ "$(printf '%s' "$(basename "$_e_base_noext")" | tr '[:upper:]' '[:lower:]')" = "$_lower_stem" ] && _cands+=("$_e")
        done
    fi

    if [ "${#_cands[@]}" -eq 1 ]; then
        warning "Deliverable '$_abs' resolved case-insensitively to '${_cands[0]}' — the declared casing does not match the repository."
        printf '%s\n' "${_cands[0]}"
        return 0
    fi
    if [ "${#_cands[@]}" -gt 1 ]; then
        warning "Declared deliverable '$_abs' is ambiguous by case — ${#_cands[@]} files match: ${_cands[*]}"
        return 1
    fi
    return 1
}

# run_dependency_check <project_root>
# Deterministic (non-LLM) replacement for "hope the agent remembers to
# install what it imports" — the exact recurring failure class this session
# kept hitting (supertest imported but never added to devDependencies,
# burning full retry cycles on the same mechanical mistake every time).
#
# Fully generic: reads a dependency-check.json for the manifest file, its
# dependency keys, the import-statement regex, and the install command
# template — all data, no npm/pip/cargo/language assumption anywhere in this
# function. Different orchestrations (Python, Rust, etc.) supply their own
# manifest; this function is identical for all of them.
#
# Config location: for a brownfield codeline, this config is NEVER stored
# inside the client's own repo (a client codeline is not epam-cli's to write
# into, even for our own tooling — see feedback_no_client_repo_writes_or_
# hardcoding memory). EPAM_PROJECT_CONFIG_DIR (set by the project's own
# tier3-*-run.sh, e.g. orchestrations/projects/metrolinx) is checked first;
# only a project WITHOUT that var set (greenfield, scaffolding its own new
# repo from scratch — a repo the pipeline itself owns) falls back to
# <project_root>/.epam/dependency-check.json, which is legitimate there
# since the pipeline authored that repo in the first place.
# No manifest present = no-op (opt-in feature, old projects unaffected).
# Describe how THIS codeline resolves bare imports, for the agent's prompt.
#
# The scanner already answers this question deterministically (see
# _resolves_inside_repo in run_dependency_check): a bare specifier naming a file
# under one of the repo's own top-level directories is internal code, not a
# package. The agent was never told, so on live metrolinx 2026-07-29 it wrote
# imports the scanner then tried to npm-install — 346/553/506 attempts per lane,
# which consumed the story budget.
#
# Derived from the same manifest and the same root-discovery rule the scanner
# uses. It must never become hand-written prose in a prompt: if the agent is
# told one convention and the scanner applies another, the result is a subtler
# version of the original bug — "correct" imports the scanner still rejects.
#
# Silent when the codeline has no manifest: we do not know its conventions then,
# and inventing them is worse than saying nothing.
_module_resolution_context() {
    local _repo="${1:-$PROJECT_ROOT}"
    local _cfg="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_cfg" ] || _cfg="$_repo/.epam/dependency-check.json"
    [ -f "$_cfg" ] || return 0

    "${PYTHON_BIN:-python3}" "$SCRIPT_DIR/lib/handlers/module-resolution-context.py" "$_repo" "$_cfg"
}

# _discover_vendor_packages <resolved_abs_file>
# Prints one third-party package name per line, imported by the given real
# file — deduplicated, excluding relative/internal imports and anything in
# ignorePackages.
#
# Reuses .epam/dependency-check.json's importPattern/vendorDirs/ignorePackages
# VERBATIM — the same config already trusted by the dependency-check step. No
# new manifest field, no project/package/language assumption in this function: a
# project with no dependency-check.json gets an empty result (opt-in, same
# convention as every other manifest-gated feature here).
#
# Ground-truthing a THIRD-PARTY API's shape (found live, 2026-07-30, AMSD-2041):
# dependency_contracts already ground-truths a story's declared INTERNAL
# dependencies, but a third-party package gets none of it, so every attempt —
# implementation and self-heal alike — reconstructs the package's real shape
# from training memory. The failure-analyst diagnosed the identical Contentstack
# Config-type mismatch 3 times running with patches_applied:0, because nothing
# in the pipeline ever showed either agent the SDK's actual type.
_discover_vendor_packages() {
    local _file="$1"
    [ -f "$_file" ] || return 0
    local _config="${PROJECT_ROOT}/.epam/dependency-check.json"
    [ -f "$_config" ] || return 0

    local _import_pattern _vendor_dirs_json _ignore_json
    _import_pattern=$(jq -r '.importPattern // empty' "$_config" 2>/dev/null)
    [ -z "$_import_pattern" ] && return 0
    _vendor_dirs_json=$(jq -c '.vendorDirs // []' "$_config" 2>/dev/null)
    _ignore_json=$(jq -c '.ignorePackages // []' "$_config" 2>/dev/null)

    python3 "$SCRIPT_DIR/lib/handlers/vendor-packages.py" "$_file" "$_import_pattern" "$_ignore_json"
}

# _generate_vendor_contract <project_root> <package_name>
# Deterministically writes .contracts/vendor-<package>.md by extracting
# exported interfaces/classes directly from the PACKAGE'S OWN installed
# source — not by asking a model to recall them. Identical extraction
# approach to generate_story_contract() (same interfacePattern/classPattern/
# sourceExtensions from .epam/contract-generation.json), pointed at a vendored
# package directory instead of the story's own files. A project with no
# contract-generation.json, or a package that isn't actually installed under
# any declared vendorDir, gets a silent no-op — this is additive grounding,
# never a requirement.
_generate_vendor_contract() {
    local _root="$1"
    local _package="$2"
    local _config="${_root}/.epam/contract-generation.json"
    [ -f "$_config" ] || return 0
    local _dep_config="${_root}/.epam/dependency-check.json"
    [ -f "$_dep_config" ] || return 0

    local _vendor_dirs_json _vendor_dir _package_dir=""
    _vendor_dirs_json=$(jq -r '.vendorDirs[]? // empty' "$_dep_config" 2>/dev/null)
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        [ -d "${_root}/${_vendor_dir}/${_package}" ] && { _package_dir="${_root}/${_vendor_dir}/${_package}"; break; }
    done <<< "$_vendor_dirs_json"
    [ -z "$_package_dir" ] && return 0

    local _exts_json
    _exts_json=$(jq -c '.sourceExtensions // []' "$_config" 2>/dev/null)
    local _files_json
    _files_json=$(python3 "$SCRIPT_DIR/lib/handlers/vendor-contract.py" "$_package_dir" "$_exts_json"
)
    [ "$_files_json" = "[]" ] && return 0

    mkdir -p "${_root}/.contracts" 2>/dev/null
    local _contract_file="${_root}/.contracts/vendor-${_package}.md"
    _generate_contract_from_files "$_root" "$_contract_file" "$_files_json" "vendor:${_package}" "$_config"
}

# _classify_declared_paths <newline-separated-paths>
#
# Splits the story's declared output paths into those that ALREADY EXIST and those that do not,
# and reports the size of each existing one.
#
# WHY THIS EXISTS. The planner was given a bare list under the heading "Files to Create/Modify"
# and nothing else. It cannot know that pageService.ts already holds 537 lines, so "Create
# src/services/pageService.ts" is the reasonable output — and that is exactly what it produced
# live on 2026-08-09, ten steps of it, while build_implementation_prompt simultaneously told the
# writer "these files already exist, their content is injected below". The writer got both halves
# of the contradiction and wrote nothing.
#
# FACTUAL, NOT LEXICAL. An earlier draft scanned plan steps for create-ish verbs.
# lib/guard-vocabulary.js forbids that in terms this project has already paid to learn: a
# deterministic guard may be deterministic in enforcement, but its CONTENT may never be a
# hardcoded list — "not in engine code, not in config, not as a 'generic' list somebody promises
# to maintain". So nothing here matches words. The filesystem is asked; existence is a fact,
# derived per story, naming no domain and no vocabulary.
#
# Creation stays expressible: a path that genuinely does not exist is listed as creatable, so a
# greenfield story is unaffected.
_classify_declared_paths() {
    local _paths="${1:-}"
    local _existing="" _new="" _p _abs _lines
    while IFS= read -r _p; do
        [ -n "$_p" ] || continue
        case "$_p" in /*) _abs="$_p" ;; *) _abs="${PROJECT_ROOT}/${_p}" ;; esac
        if [ -f "$_abs" ]; then
            _lines=$(wc -l < "$_abs" 2>/dev/null | tr -d " ")
            _existing="${_existing}  - ${_p} (${_lines:-0} lines, already implemented)
"
        else
            _new="${_new}  - ${_p}
"
        fi
    done <<< "$_paths"

    # No line may begin with `}` — several extractors in this repo (and its tests) isolate a
    # function with /^}/, and a multi-line parameter default whose closing brace lands in column
    # zero truncates the function silently. That is how the first version of this helper broke
    # its own test.
    [ -n "$_existing" ] || _existing="  (none)"
    [ -n "$_new" ] || _new="  (none)"
    printf '## Files that ALREADY EXIST — your steps MODIFY these; they are already written\n%s\n' "$_existing"
    printf '## Files that DO NOT EXIST YET — only these may be created\n%s\n' "$_new"
}

# Main implementation loop
# commit_completed_story <story_id>
# Stages and commits whatever a completed story wrote, scoped to the current
# GIT_WORK_ROOT (the worktree checkout when running --worktree, the main repo
# otherwise). Best-effort: a commit failure here must not fail the story itself,
# since the retry/health-check machinery downstream still has its own commit gates.
# generate_story_contract <story_id>
# Deterministically writes .contracts/<story_id>.md by extracting exported
# interfaces/classes/methods directly from the story's own source files —
# NOT by asking the model to transcribe them. The typescript-engineer profile
# has a "CONTRACT SCRATCHPAD — MANDATORY LAST STEP" instruction telling the
# agent to hand-write this file, but that step was observed live to have near-
# 0% compliance: SKY-002 never produced .contracts/SKY-002.md across multiple
# runs, so build_implementation_prompt()'s contract injection (which only
# activates `if [ -f "$_contract_file" ]`) had nothing to inject — dependent
# stories (SKY-003/SKY-004) guessed import paths and mock shapes from scratch,
# reproducing exactly the bug class contract injection was built to prevent.
# A regex-based extractor is not as complete as a real TS parser, but it is
# ALWAYS produced (no model compliance required) and always matches the
# actual source, so it can never be wrong the way an LLM transcription could.
#
# Fully generic (2026-07-05): all regex patterns and mock-rendering templates
# are read from <project_root>/.epam/contract-generation.json — this function
# has no TypeScript/Vitest-specific knowledge. Each project's tier script
# supplies its own manifest (see tier3-travel-app-run.sh for the current
# skyscanner-app one); a Python/pytest or Go project would supply a manifest
# with different regexes and mock templates, and this function would not
# change. No manifest present = no-op (opt-in feature, same pattern as
# run_dependency_check()'s .epam/dependency-check.json).
# _generate_contract_from_files <project_root> <contract_file> <files_json> <id_label> <config_file>
# Shared extraction core behind generate_story_contract() (a story's own files) and
# _generate_vendor_contract() (a vendored third-party package's files) — same
# config-driven interfacePattern/classPattern/sourceExtensions, same output
# format, one parser instead of two copies that could drift. files_json entries
# may be relative to project_root OR already absolute — os.path.join() returns
# an absolute second argument unchanged, so both callers work unmodified.
_generate_contract_from_files() {
    local project_root="$1" contract_file="$2" files_json="$3" id_label="$4" config_file="$5"
    python3 "$SCRIPT_DIR/lib/handlers/contract-from-files.py" "$project_root" "$contract_file" "$files_json" "$id_label" "$config_file"
}

generate_story_contract() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _commit_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    local config_file="${_commit_root}/.epam/contract-generation.json"
    [ -f "$config_file" ] || return 0

    local files_json
    files_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
        "$prd_target" 2>/dev/null || echo "[]")
    [ "$files_json" = "[]" ] && return 0

    # technicalNotes.files stores ABSOLUTE paths rooted at MAIN_PROJECT_ROOT (the
    # non-worktree checkout) — same rewrite already applied to ACs/technicalNotes/
    # description elsewhere in this file (see the WORKTREE_MODE substitution near
    # line 960). Without this, resolving files against $_commit_root (the worktree)
    # silently misses every file (they don't exist under the main root yet — the
    # story hasn't merged), so no interfaces/classes are ever found and no contract
    # is written, with no visible error. Confirmed live: run #15's .contracts/
    # directory existed but was empty after SKY-002 completed.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        files_json="${files_json//${MAIN_PROJECT_ROOT}/${_commit_root}}"
    fi

    local contracts_dir="${_commit_root}/.contracts"
    mkdir -p "$contracts_dir" 2>/dev/null
    local contract_file="${contracts_dir}/${story_id}.md"

    _generate_contract_from_files "$_commit_root" "$contract_file" "$files_json" "$story_id" "$config_file"
}

# consumed_interfaces_block <story-json>
#
# Renders the interfaces a story declared it CONSUMES from files other stories own
# (story.consumesInterfaces, written by the spec pass from the agent's own decision). Empty
# when there are none. Composed into the writer's dependency-contracts input.
consumed_interfaces_block() {
    local _story_json="${1:-}"
    [ -n "$_story_json" ] || return 0
    printf '%s' "$_story_json" | jq -r '
      (.consumesInterfaces // []) | map(select(type == "object")) | if length == 0 then empty else
        "\n### Interfaces this story consumes (owned elsewhere — call them, do not reopen the file)\n" +
        (map("- " + (.symbol // "?") + " from " + (.file // "?") + " (owned by " + (.ownerStoryId // "?") + "): " + (.signature // "")) | join("\n")) + "\n"
      end' 2>/dev/null
}
