# Correction: `env` does not execute its command in this environment

Recorded because three findings reported on 2026-08-28 rest on a wrong root cause, and one of
them is in a commit message that will outlive this session.

## The fact

    env FOO=1 echo hello     ->  (no output, exit 0)

Not a quoting problem and not specific to node: `env` runs nothing here and reports success.
Anything invoked through it silently produces no output and exits 0.

## What was reported wrongly

**1. Commit cb66cb5 blames exported bash functions.** It says an exported function does not
survive a non-bash process, so bats' `exec env ... bats` lost `bats_readlinkf`. The observation
that led there (`env | grep BASH_FUNC` printing nothing) is consistent with the simpler truth:
`env` never ran, so nothing was printed at all.

THE FIX IN THAT COMMIT IS CORRECT AND UNCHANGED — calling bats' inner runner directly, without
`env` in the path, is why 462 tests execute now. Only the explanation was wrong.

**2. "mint-agents-step.js produces zero output and exits 0" — WITHDRAWN.** It was invoked
through `env`. It never ran. There is no evidence of a silent-success defect there, and it was
reported as one worth investigating.

**3. The 8-stale / 12-real split of the remaining shell failures — WITHDRAWN.** 10 of the 20
failing files invoke the code under test through `env`: every-agent-end-to-end,
the-ladder-defines-the-iteration-budget, an-agent-binds-its-own-seam,
every-agent-runs-a-project-prompt, the-engine-layer-is-read-only-during-a-run,
the-perimeter-reads-the-roster, the-roster-is-the-only-authority,
the-roster-stage-actually-executes, a-rehearsal-actually-dispatches,
the-launcher-preflight-runs-under-set-u.

Their assertions never executed anything, so their failures say nothing about the pipeline —
including the ones that looked like real invariants worth chasing.

## The lesson, which is the same one this repo keeps teaching

A command that returns zero bytes and exit 0 is the exact signature this codebase has been
audited for all day: machinery that reports success without doing anything. It was accepted from
the tooling twice before the tool itself was tested. Test the instrument before believing the
measurement.

## What is NOT affected

- The `EPAM_ROSTER_ONLY` false-reason fix (b24d0ee): read from source, proven by unit tests.
- The hardcoding review: the audit runs under bash, not `env`.
- The money-safety suite repoint (3d2727f): those four tests pass, executed directly.
- Every vitest result: 8080 passing, no `env` in that path.
