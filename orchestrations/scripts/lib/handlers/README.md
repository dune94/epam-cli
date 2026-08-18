# Pipeline handlers

Programs the pipeline runs, as files rather than as strings inside shell scripts.

## Why they are here

Operator, 2026-08-16: *"we cannot have embedded programs in the pipeline - they are either
generic handlers the pipeline requires for any project any stack - or project level plugs - pick
one."*

An embedded program — `python3 -c "…"` or `node -e "…"` spanning thirty lines inside a heredoc —
has the same problems as an embedded prompt and two of its own:

- **It cannot be tested.** There is no unit to call. The only way to exercise it is to run the
  whole pipeline stage around it.
- **It cannot be linted or type-checked.** To every tool in the repository it is a string.
- **Its errors are invisible.** Most are invoked as `$(python3 -c "…" 2>/dev/null || true)`, so a
  syntax error and an empty result are the same observation.
- **Quoting is a second language.** The program is written inside shell quoting inside a heredoc,
  so `$`, backticks and quotes mean two things at once and an escaping mistake changes the program
  rather than failing.

## Generic, not project-specific

Every handler here is generic: it takes its inputs as arguments and applies a rule that holds for
any project and any stack. That was checked rather than assumed — a scan of all 113 embedded
programs for project identities (`metrolinx`, `gotransit`, `skyscanner`, `AMSD`, `SKY-`) found
**none in code**. Thirteen matched in COMMENTS, recording which incident a rule came from, and
those are provenance worth keeping.

If a program ever does need a project fact, it belongs in that project's plugins, not here.

## The contract

A handler:

- reads every input from `process.argv` / `sys.argv` or stdin — never from an ambient variable
  that happened to be in scope in the calling shell;
- writes its result to stdout and its diagnostics to stderr;
- exits non-zero when it cannot do its job, so the caller can tell "failed" from "found nothing";
- is invoked from the shell by path, so `nothing-extracted-is-left-unwired.test.ts` can see that
  it is wired.

Every extraction is verified before the inline copy is removed: run the original and the handler
over the same inputs and require identical output.
