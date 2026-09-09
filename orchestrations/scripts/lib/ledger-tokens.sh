#!/usr/bin/env bash
# THE TOKENS A CALL REALLY USED, WHICH IS NOT `task_tokens_in`.
#
# `task_tokens_in` is `.usage.input_tokens` as the provider reports it, and for a CACHED request
# that is only the UNCACHED REMAINDER. The rest of the prompt arrives as two separate classes,
# recorded separately because they are PRICED separately — cache read at roughly 0.1x input, cache
# write at 1.25x (ephemeral_5m) or 2.0x (ephemeral_1h).
#
# Measured live 2026-09-09, a ~2,800-word prompt on claude-haiku-4-5:
#
#     input_tokens                :      9
#     cache_creation_input_tokens : 13,857
#     cache_read_input_tokens     : 17,551
#     output_tokens               :    531
#
# So a consumer that adds task_tokens_in to task_tokens_out counts 540 tokens for a call that used
# 31,948 — a 98.3% undercount. estimate-stories.sh did exactly that to calibrate
# TOKENS_PER_MIN_LOW/MED/HIGH, the constants every future story estimate derives from, which made
# the pipeline believe it produces some sixty times fewer tokens per minute than it does.
#
# Nothing here measures anything new: the ledger already records all four numbers faithfully. This
# is the ONE place that says what "total tokens" means, so the next consumer cannot re-derive it
# wrongly. The per-class figures stay separate for costing — only the THROUGHPUT question ("how
# many tokens did this work move") wants them added up.

# The token classes of one ledger row, as a jq expression. Missing fields count as 0: the older
# writers record no cache fields at all (37 of 46 rows carry them in a live ledger), and a row
# without them is an uncached call, not a broken one.
LEDGER_TOKENS_JQ='((.task_tokens_in // 0) + (.cache_read_tokens // 0) + (.cache_create_tokens // 0) + (.task_tokens_out // 0))'

# ledger_total_tokens [jq_filter] — reads JSONL on stdin, prints one integer.
#
# The filter is the caller's (e.g. a tier selection); it defaults to every row. `add // 0` so an
# empty selection prints 0 rather than `null`, which `bc` would choke on downstream.
ledger_total_tokens() {
    local _filter="${1:-.}"
    jq -s "[.[] | ${_filter} | ${LEDGER_TOKENS_JQ}] | add // 0"
}
