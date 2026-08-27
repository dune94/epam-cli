#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# free-run-guard.sh — make a free run INCAPABLE of billing, then prove it.
#
# WHY THIS EXISTS. On 2026-08-25 a run was launched as "mocked, cannot cost anything". Every
# seam called the real Anthropic API. The assurance rested on a DRY RUN showing the mock
# redirect resolved, and on no key being present in the LAUNCHER's environment. Neither was the
# thing that mattered: reading /proc/<pid>/environ of a live child afterwards showed
# ANTHROPIC_BASE_URL=UNSET and a real sk-ant-api03… key, while MockServer sat at zero requests.
#
# THE PROOF MUST BE NEGATIVE. Not "the mock is wired" but "no usable key is reachable" — then a
# mistake FAILS instead of billing. Two mechanisms, both required:
#
#   scrub_paid_keys        SUBSTITUTE a placeholder for every key-shaped variable.
#                          NOT unset: run-agent-orchestration.sh loads .env in `preserve` mode,
#                          and preserve keeps an already-set NON-EMPTY value. An unset — or an
#                          empty string — is not "already set", so .env wins and the real key
#                          comes straight back. Scrubbing must substitute.
#
#   assert_no_paid_key     Run the loading chain in a CHILD and inspect what it inherits.
#                          Checking the parent proves nothing: the parent is not what calls.
#
# BY PATTERN, NEVER BY A LIST. The first version of this named the three keys its author thought
# of; the general assertion immediately found a fourth (OPENAI_API_KEY) reachable and unscrubbed.
# A hand-maintained list is a list that misses the next one.
# ─────────────────────────────────────────────────────────────────────────────

# A placeholder that is syntactically a key and cannot authenticate anywhere.
FREE_RUN_PLACEHOLDER="sk-mock-not-real"

# Names that carry a credential. Deliberately broad: a false positive costs a scrubbed variable
# in a run that was never going to spend, a false negative costs money.
_free_run_key_pattern() {
    # Declared in config/provider-sets.json, not here: which names carry a credential is a fact
    # about a deployment. Falls back to the built-in shape when the registry cannot be read.
    local _p
    _p=$("${NODE_BIN:-node}" -e '
      try { const j=require(process.argv[1]);
            process.stdout.write((j.freeRunCredentials||{}).scrubPattern||""); } catch(e){}
    ' "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/provider-sets.json" 2>/dev/null)
    printf '%s' "${_p:-API_KEY|_TOKEN\$|SECRET|CREDENTIAL}"
}

# Credentials that must SURVIVE a free run. Scrubbing JIRA_TOKEN made Jira ingest return 0 issues
# and phase 'core' abort — a guard defect that read as a pipeline defect. Jira is read-only and
# free; scrubbing it protects nothing and breaks the run.
_free_run_keep() {
    "${NODE_BIN:-node}" -e '
      try { const j=require(process.argv[1]);
            process.stdout.write(((j.freeRunCredentials||{}).keep||[]).join("\n")); } catch(e){}
    ' "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/provider-sets.json" 2>/dev/null
}

# The shapes a REAL vendor key takes. The placeholder must match none of them.
_free_run_real_key_re() { printf '^(sk-ant-.{10,}|sk-or-.{10,}|sk-[A-Za-z0-9]{20,}|eyJ.{20,})$'; }

# free_run_requested — DOES THE OPERATOR SAY THIS RUN SPENDS NOTHING?
#
# One environment variable, set by whoever launches a free run. Nothing else decides.
#
# This used to be inferred in the launcher from the active set's RUNNER NAMES —
# `runners.every(r => r === "claude")` — which put mock-specific reasoning inside the engine's
# normal path. Two things were wrong with it. A real plain-`claude` stack matches that test, so
# a paid run would have had its credentials scrubbed mid-flight. And it let the mock govern how
# a normal run behaved, which is backwards: a mock is data a run may use, never a thing the
# engine reasons about.
#
# UNSET MEANS SPENDS. The seal is opt-in protection for a run that should reach no vendor; a
# paid run needs no seal. Defaulting the other way would let a typo silently disarm a run's
# credentials.
free_run_requested() {
    case "${EPAM_FREE_RUN:-}" in
        1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]) return 0 ;;
        *) return 1 ;;
    esac
}

# scrub_paid_keys [extra-env-file ...]
# Substitutes the placeholder for every key-shaped variable in this environment AND every one
# declared by the given env files, so a later load cannot reintroduce a live value.
scrub_paid_keys() {
    local _pat _k _f
    _pat="$(_free_run_key_pattern)"
    local _keep; _keep="$(_free_run_keep)"
    _frg_keep() { [ -n "$_keep" ] && printf '%s\n' "$_keep" | grep -Fxq -- "$1"; }
    for _k in $(compgen -e); do
        _frg_keep "$_k" && continue
        printf '%s' "$_k" | grep -qE "$_pat" && export "${_k}=${FREE_RUN_PLACEHOLDER}"
    done
    for _f in "$@"; do
        [ -f "$_f" ] || continue
        while IFS= read -r _line; do
            _k="$(printf '%s' "$_line" | sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p')"
            [ -n "$_k" ] || continue
            _frg_keep "$_k" && continue
            printf '%s' "$_k" | grep -qE "$_pat" && export "${_k}=${FREE_RUN_PLACEHOLDER}"
        done < "$_f"
    done
    return 0
}

# assert_no_paid_key <project-config-dir> [env-file]
# Runs the pipeline's own loading chain in a CHILD and refuses if any variable it inherits holds
# something shaped like a real key. Non-zero means DO NOT LAUNCH.
assert_no_paid_key() {
    local _projdir="${1:-}" _envfile="${2:-}"
    local _libdir; _libdir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1

    # THE CHILD INHERITS NATURALLY. The first version rebuilt the environment with
    # `env $(for k in ...)` and silently dropped it — so the guard reported "no usable key" with
    # a real sk-ant- key exported one line above. A cost guard that fails OPEN is worse than no
    # guard: it converts a doubt into a false assurance.
    local _real_re; _real_re="$(_free_run_real_key_re)"
    local _leaked
    _leaked=$(
        export _FRG_LIB="$_libdir" _FRG_PROJ="$_projdir" _FRG_ENV="$_envfile" _FRG_RE="$_real_re"
        export _FRG_KEEP="$(_free_run_keep)"
        bash -c '
            . "$_FRG_LIB/env-file.sh"
            [ -n "$_FRG_ENV" ] && [ -f "$_FRG_ENV" ] && load_env_file_safe "$_FRG_ENV" preserve
            [ -n "$_FRG_PROJ" ] && load_project_env "$_FRG_PROJ" preserve >/dev/null 2>&1
            for k in $(compgen -e); do
                case "$k" in _FRG_*) continue ;; esac
                # DECLARED NON-LLM CREDENTIALS ARE SKIPPED BY DESIGN, not by luck of a regex.
                # LANGFUSE_SECRET_KEY is "sk-lf-…" and happened not to match the vendor shape
                # only because of a hyphen. A guard that passes by accident fails by accident.
                [ -n "$_FRG_KEEP" ] && printf "%s\n" "$_FRG_KEEP" | grep -Fxq -- "$k" && continue
                printf "%s\n" "${!k}" | grep -qE "$_FRG_RE" && printf "%s\n" "$k"
            done
        ' 2>/dev/null
    )
    if [ -n "$_leaked" ]; then
        echo "[free-run-guard] REFUSING TO LAUNCH — a real vendor key is reachable by this run:" >&2
        printf '%s\n' "$_leaked" | sed 's/^/  /' >&2
        echo "[free-run-guard] A free run must be INCAPABLE of billing, not merely pointed elsewhere." >&2
        return 1
    fi
    echo "[free-run-guard] verified in a child process: no usable vendor key is reachable" >&2
    return 0
}
