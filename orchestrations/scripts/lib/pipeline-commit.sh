#!/usr/bin/env bash
# pipeline_commit_flags — the flags every commit the PIPELINE makes passes to `git commit`, one per line.
#
# A codeline's hooks are written for its team's own checkout and machine. Operator decisions,
# 2026-10-05 (AMSD-2974): the pipeline's commits skip them — first inside worktrees, then in the
# checkout too. Proven on a copy of next.gotransit.com: its pre-commit hook (husky + lint-staged)
# type-checks the WHOLE project, which fails on the untouched checkout with 6 errors because the
# team's node_modules is older than its own develop branch expects (it needs an `npm install`, which
# the pipeline may not run) — so the hook refused every pipeline commit there, whatever it held, and
# the reproducing test of a correct fix was never committed. In worktrees the same hook also refused
# the branch name and sourced a helper git does not track.
#
# What the hook checks is still checked by the pipeline: the story's own verification, Step 19/20's
# type check judged against the phase baseline, the lint gate, review and the QA gates. The Step 17
# merge onto the story branch still runs the codeline's commit-msg hook (git merge has no --no-verify
# here), and its message is written to pass it.
pipeline_commit_flags() {
    echo "--no-verify"
}
