## TF-3 — "writer-only" ran the regression guard anyway

**Date** 2026-08-13 · **Found by** the operator, watching a live run · **Cost** two launches, ~4
minutes of a run doing work nobody asked for, plus a kill and relaunch

**Agreed** — a named run mode expresses one intent. `EPAM_RUN_MODE=writer-only` means resume at the
writer: no spec pass, no roster mint, no ingest, no CPA, no skill assessment, no regression
baseline.

**Shipped** — the mode set five of its six variables. `SKIP_REGRESSION_GUARD` did not apply, so the
guard ran the codeline's entire existing test suite before the writer. `config.env` carries
`SKIP_REGRESSION_GUARD=false` and is loaded by the launcher BEFORE the mode is applied; the mode's
"never overwrite what is already set" rule then read a config-file default as a deliberate operator
choice and yielded to it.

**The test** — `a-run-mode-is-declared-once.test.ts`, seventeen tests: the mode is declared as data,
every skip is a real `KEY=VALUE`, an unknown mode fails closed, an unreadable declaration is
refused, and — asserted one variable at a time, deliberately — `writer-only` sets each of its six.
It also asserted that a value already in the environment is not overwritten.

**Why it passed** — it resolved the mode in a CLEAN environment. Every assertion was true of
`apply_run_mode` in isolation, and the defect lives entirely in what happens BEFORE it: a launcher
loading config files. The test proved the function's contract and said nothing about the sequence
the function runs in.

The "operator wins" test made it worse, not better. It set a variable directly and asserted the
mode yielded — which is indistinguishable, in a clean shell, from a config file having set it. The
test encoded a rule that could not tell the two cases apart, so it ratified the ambiguity that IS
the defect.

**Testing rule** — *test the sequence, not only the function.* Anything whose behaviour depends on
what ran before it must be tested with that thing having run: load the real config file first, then
apply the mode. And when a rule depends on distinguishing two sources ("the operator set it" versus
"a default set it"), the test must construct BOTH and show they diverge — a single fixture that
satisfies either reading proves nothing.

**Status** — fixed. Precedence is now operator environment > mode > config-file default, with
`snapshot_operator_env` capturing the operator's variables before any config file is read — the one
moment the two sources are distinguishable. Verified by executing the real launcher sequence:
`config.env` sets `false`, the mode overrides to `true`, an operator's own value still wins.
