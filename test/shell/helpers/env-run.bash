# env_run — what `env` was being used for, without `env`.
#
# `env` does not execute its command in every environment this suite runs in: on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0. Ten .bats files invoked the code under
# test through it, so their assertions ran against nothing and failed for a reason that had nothing
# to do with the pipeline — while looking exactly like real defects. Two were investigated as such.
#
# Each bats @test already runs in its own subshell, so exporting here cannot leak into another test.
#
#   env_run [-u NAME]... [VAR=VALUE]... command [args...]
env_run() {
    while [ "${1:-}" = "-u" ]; do
        unset "$2"
        shift 2
    done
    while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do
        export "${1%%=*}=${1#*=}"
        shift
    done
    [ $# -gt 0 ] || return 0
    "$@"
}
