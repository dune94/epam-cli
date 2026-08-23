#!/usr/bin/env bash
#
# REHEARSE A RUN: replayed turns, real execution, discarded writes.
#
# A replay hands back what a recorded run said, and the agent loop then executes those turns FOR
# REAL -- a recorded bash call really runs, a recorded write really writes. That fidelity is the
# point (the gates downstream judge real artefacts) and it is also the hazard: one recorded
# session carries 216 bash calls, 131 of them writes, at absolute paths inside working trees.
#
# So the rehearsal runs inside an overlay. Every tree the recording touches is mounted over ITSELF
# with a discardable upper layer, which is what lets the recorded ABSOLUTE paths keep resolving
# while nothing outside the sandbox changes. When the rehearsal ends, the upper layer is a
# complete, inspectable record of everything the run would have done -- and it is thrown away.
#
# WHICH TREES. Not named here: the cassette's manifest carries `roots`, derived by the exporter
# from the paths the recording actually touched. A list in this script would be a guess about one
# machine's layout and would under-cover silently the moment a project moved.
#
# Usage:
#   rehearse.sh --cassette <dir> [--keep] [--] <command...>
#
# With no command, the sandbox is reported and nothing is run -- so an operator can see what a
# rehearsal WOULD isolate before running one.

set -euo pipefail

NODE_BIN="${NODE_BIN:-node}"

CASSETTE=""
KEEP=0
declare -a COMMAND=()

while [ $# -gt 0 ]; do
    case "$1" in
        --cassette) CASSETTE="${2:-}"; shift 2 ;;
        --keep)     KEEP=1; shift ;;
        --)         shift; COMMAND=("$@"); break ;;
        -h|--help)  sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *)          echo "[rehearse] unknown option '$1'" >&2; exit 2 ;;
    esac
done

if [ -z "$CASSETTE" ]; then
    echo "[rehearse] --cassette is required. A rehearsal replays a RECORDING; without one there" >&2
    echo "[rehearse] is nothing to replay and the run would call a paid provider." >&2
    exit 2
fi
if [ ! -d "$CASSETTE" ]; then
    echo "[rehearse] no cassette at '$CASSETTE'." >&2
    exit 1
fi

CASSETTE="$(cd "$CASSETTE" && pwd)"

# WHAT THIS REHEARSAL WILL TOUCH, from the recording's own manifest.
MANIFEST="$CASSETTE/manifest.json"
if [ ! -f "$MANIFEST" ]; then
    echo "[rehearse] '$CASSETTE' has no manifest.json -- it is not a cassette." >&2
    exit 1
fi

mapfile -t ROOTS < <("$NODE_BIN" -e '
  const m = require(process.argv[1]);
  const roots = Array.isArray(m.roots) ? m.roots : [];
  for (const r of roots) process.stdout.write(r + "\n");
' "$MANIFEST")

if [ "${#ROOTS[@]}" -eq 0 ]; then
    echo "[rehearse] the manifest declares no roots, so this rehearsal cannot be isolated." >&2
    echo "[rehearse] Re-export the cassette: the exporter derives them from the recorded paths." >&2
    exit 1
fi

# THE UPPER LAYERS LIVE OUTSIDE EVERY ISOLATED TREE, necessarily: a layer stored inside the tree
# it shadows would be shadowed by itself.
SANDBOX="${EPAM_REHEARSAL_SANDBOX:-$(mktemp -d -t rehearsal-XXXXXX)}"
mkdir -p "$SANDBOX"

echo "[rehearse] cassette : $CASSETTE"
echo "[rehearse] sandbox  : $SANDBOX"
echo "[rehearse] isolating:"
for r in "${ROOTS[@]}"; do echo "[rehearse]   $r"; done

if [ "${#COMMAND[@]}" -eq 0 ]; then
    echo "[rehearse] no command given -- nothing was run. Pass one after --."
    exit 0
fi

# Build the mount commands. Each root is mounted over ITSELF so recorded absolute paths resolve
# unchanged, with its own upper and work directories keyed by a digest of the path (two roots can
# share a basename).
MOUNTS=""
for r in "${ROOTS[@]}"; do
    if [ ! -d "$r" ]; then
        echo "[rehearse] declared root '$r' does not exist on this machine -- skipping it." >&2
        echo "[rehearse] WRITES UNDER IT WILL NOT BE ISOLATED if the rehearsal creates it." >&2
        continue
    fi
    key="$(printf '%s' "$r" | "$NODE_BIN" -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        process.stdout.write(require("crypto").createHash("sha256").update(s).digest("hex").slice(0,16));
      });')"
    mkdir -p "$SANDBOX/$key/upper" "$SANDBOX/$key/work"
    # userxattr IS REQUIRED, not optional tuning. Deleting a directory that exists in the lower
    # layer means writing a whiteout, and overlayfs records those in a trusted.* xattr that an
    # unprivileged namespace may not set -- so without this every removal fails with a bare
    # "Input/output error" and the rehearsal diverges from the run it is rehearsing. The pipeline
    # removes directories routinely: pre-run-reset clears the generated prompt layer on every run.
    MOUNTS+="mount -t overlay overlay -o lowerdir=$r,upperdir=$SANDBOX/$key/upper,workdir=$SANDBOX/$key/work,userxattr $r || exit 91
"
done

if [ -z "$MOUNTS" ]; then
    echo "[rehearse] no declared root exists here, so nothing would be isolated. Refusing to run." >&2
    exit 1
fi

# THE CASSETTE IS THE SWITCH, exported into the sandbox: ai-run.sh reads it and replaces every
# provider with the replay one. Nothing else about the run changes, which is the point -- the
# pipeline under rehearsal is the pipeline, not a variant of it.
export EPAM_REPLAY_CASSETTE_DIR="$CASSETTE"

set +e
unshare --user --map-root-user --mount bash -c "
set -e
$MOUNTS
cd '$PWD'
exec \"\$@\"
" _ "${COMMAND[@]}"
RC=$?
set -e

echo "[rehearse] the rehearsal exited $RC"

# WHAT IT WOULD HAVE DONE. The upper layers are the complete diff of the run against the real
# trees, and reporting it is most of the value: a rehearsal whose effects are discarded unseen
# tells the operator only whether it crashed.
CHANGED=0
for d in "$SANDBOX"/*/upper; do
    [ -d "$d" ] || continue
    n=$(find "$d" -type f 2>/dev/null | wc -l)
    CHANGED=$((CHANGED + n))
done
echo "[rehearse] it wrote $CHANGED file(s), all of them into the sandbox"

if [ "$KEEP" -eq 1 ]; then
    echo "[rehearse] kept for inspection: $SANDBOX"
else
    # REMOVED FROM INSIDE A USER NAMESPACE. overlayfs creates its work directory owned by the
    # namespace's root with permissions that deny the unmapped user outside, so a plain rm -rf
    # here fails on work/work -- and under `set -e` that failure became the script's exit status,
    # reporting a clean rehearsal as a failed one.
    if ! unshare --user --map-root-user bash -c "rm -rf '$SANDBOX'" 2>/dev/null; then
        # Never silent: a sandbox that could not be removed is disk that will not come back on
        # its own, and the operator has to be told where it is.
        echo "[rehearse] the sandbox could not be removed and remains at: $SANDBOX" >&2
    else
        echo "[rehearse] sandbox discarded (--keep to inspect it)"
    fi
fi

exit "$RC"
