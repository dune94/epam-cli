#!/usr/bin/env bash
# THE DEPENDENCY MANIFEST IS REVIEWED BEFORE ANYTHING TOUCHES A CLIENT REPOSITORY.
#
# lib/manifest_schema.py describes itself as a reviewer that "checks the manifest against the REAL
# codeline, not against itself". It was inert twice over: its schema was stale until fd9afedd, and
# nothing in the pipeline ever CALLED it — only tests did. A reviewer nobody invokes is the defect
# lib/plan-fidelity-gate.sh already shipped once: built, tested, and wired to nothing.
#
# WHY THE LAUNCHER, AND WHY BEFORE THE RESET. The earliest consumer of dependency-check.json is
# brownfield-preflight-reset.sh, which the launcher runs before the orchestration starts: it reads
# localDependencyOverrides[].localSourcePath, npm-installs from it, and runs `git reset --hard`
# plus `clean -fd` on a CLIENT repository. The localSourcePath check that keeps an override out of
# the wrong codeline tree is precisely the check that never ran.
#
# IT FAILS THE LAUNCH. Operator, 2026-09-06: "fail the launch". A warning is read after the reset
# has already happened, which is after the damage.
#
# IT MUST NOT REFUSE A LAUNCH THAT WOULD HAVE WORKED. metrolinx's real manifest validates against
# both of its real codelines when JIRA_CODELINE_ROOT is set — which is how the launcher runs, and
# which was verified before this gate was written. A gate that fails a good manifest is worse than
# no gate at all.

# manifest_preflight_gate <manifest-file> <codeline-dir>
#
# 0 = this manifest may be acted on against this codeline. Non-zero = do not launch.
manifest_preflight_gate() {
    local _manifest="${1:-}" _repo="${2:-}"

    # A PROJECT NEED NOT DECLARE ONE. brownfield-preflight-reset.sh already returns 0 when the file
    # is absent, so there is nothing for this gate to protect and nothing to refuse.
    [ -n "$_manifest" ] && [ -f "$_manifest" ] || return 0
    if [ -z "$_repo" ] || [ ! -d "$_repo" ]; then
        error "[manifest-preflight] no codeline directory given — cannot review the manifest against a real codeline"
        return 1
    fi

    # THE VENV IS A PREFERENCE, NOT A REQUIREMENT.
    #
    # Wired on 2026-09-06 keyed to $SCRIPT_DIR/.venv/bin/python, which exists in the SOURCE
    # CHECKOUT and in NO INSTALL — not pipeline-tests-28, not tests-26 which produced the Sept 5
    # green run. So the gate refused the resume of run 20260906T174618Z, and would have refused
    # every launch on every install: the "a gate that fails a good manifest is worse than no gate"
    # failure this file's own header warns about, committed by the change that warned about it.
    #
    # System python3 runs the reviewer fine — pydantic is present on this box and the installer
    # already checks for python3 because 88 handlers need it. So try the venv first, then the
    # interpreter the installer guarantees.
    local _py="" _cand
    if [ -n "${MANIFEST_PYTHON:-}" ]; then
        # AN EXPLICIT CHOICE IS EXCLUSIVE. An operator or a test naming an interpreter must see
        # THAT one fail, never a fallback quietly succeeding somewhere else — a gate that silently
        # reviews with something other than what it was told to use is not the gate anyone checked.
        [ -x "$MANIFEST_PYTHON" ] && _py="$MANIFEST_PYTHON"
    else
        for _cand in "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/.venv/bin/python3"; do
            [ -x "$_cand" ] && { _py="$_cand"; break; }
        done
        [ -n "$_py" ] || for _cand in python3 python; do
            command -v "$_cand" >/dev/null 2>&1 && { _py="$(command -v "$_cand")"; break; }
        done
    fi
    if [ -z "$_py" ] || [ ! -x "$_py" ]; then
        # A GATE THAT CANNOT RUN DOES NOT PASS BY DEFAULT.
        #
        # Standing down here would reproduce the exact failure this file exists to end: a check
        # that reports nothing and is mistaken for a check that found nothing. An unavailable
        # interpreter is not evidence about the manifest.
        error "[manifest-preflight] cannot review the dependency manifest: no usable python at"
        error "[manifest-preflight]   ${MANIFEST_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
        error "[manifest-preflight]   The manifest decides what is installed into a client codeline —"
        error "[manifest-preflight]   refusing to launch unreviewed."
        return 1
    fi

    local _out
    _out=$("$_py" "$SCRIPT_DIR/lib/manifest_schema.py" --validate --repo "$_repo" < "$_manifest" 2>&1)
    local _rc=$?
    if [ $_rc -ne 0 ] || [ -z "$_out" ]; then
        error "[manifest-preflight] the manifest reviewer did not return a verdict (exit $_rc) for $_repo"
        [ -n "$_out" ] && error "[manifest-preflight]   $_out"
        return 1
    fi

    # THE VERDICT IS READ. A gate whose verdict nobody reads is this repo's most repeated defect.
    local _verdict
    _verdict=$(printf '%s' "$_out" | "$_py" -c 'import json,sys
try:
    print(json.load(sys.stdin).get("verdict",""))
except Exception:
    print("")' 2>/dev/null)
    if [ "$_verdict" = "pass" ]; then
        info "  [manifest-preflight] $(basename "$_repo"): dependency manifest reviewed — 0 issues"
        return 0
    fi

    error "[manifest-preflight] the dependency manifest is not valid for $(basename "$_repo") — refusing to launch"
    printf '%s' "$_out" | "$_py" -c 'import json,sys
try:
    for i in json.load(sys.stdin).get("issues",[]) or ["(no issue reported)"]:
        print("  - " + str(i))
except Exception:
    print("  - unreadable verdict: " + sys.stdin.read()[:400])' 2>/dev/null \
        | while IFS= read -r _line; do error "[manifest-preflight] $_line"; done
    return 1
}
