// THE LADDER CLIMBED TO THE TOP, THEN RESUMED ONE RUNG LOWER.
//
// Live metrolinx AMSD-2041, 2026-08-19:
//   23:36:58  Attempt[3]  moonshotai/kimi-k3        <- top of ladder; helpers + tsc green, committed
//   00:00:38  [InferenceLadder] resuming on 'moonshotai/kimi-k3' (escalated in an earlier invocation)
//   00:01:24  [InferenceLadder][Rung2/R4]: model 'MiniMax-M3' -> 'z-ai/glm-5.2'
//   00:01:41  Attempt[5]  z-ai/glm-5.2              <- WENT BACKWARDS
//
// The resume block reads the persisted model and assigns STORY_MODEL correctly. Then, further
// down the SAME function, the provider case re-derives it:
//
//   case "${STORY_PROVIDER:-codex}" in
//       copilot|openai|openrouter|cursor|minimax) resolve_model_from_story "$story_id" ;;
//   esac
//
// resolve_model_from_story assigns STORY_MODEL="$story_model" straight from prd.json whenever the
// story declares one, with no knowledge that a ladder position was just restored. The escalation
// that follows therefore hops from the PRD's base model instead of from the rung actually reached.
//
// The resume block's OWN comment predicted this: "MUST sit AFTER resolve_provider_settings: that
// function re-derives STORY_MODEL from the PRD, so seeding before it had the persisted model
// silently overwritten and the ladder restarted its climb on every re-invocation." The fix was
// applied at that one call site; this is a SECOND re-derivation below it.
//
// Every re-implementation cycle crosses an invocation boundary, so this fires on every self-heal
// round: the ladder can climb within an invocation and never hold ground across one.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const PRD_MODEL = 'MiniMax-M3';        // what prd.json declares for the story
const CLIMBED_TO = 'moonshotai/kimi-k3'; // where the ladder actually got to

/**
 * Runs the REAL resolve_model_from_story against a real prd.json, after a resume has set
 * STORY_MODEL to the climbed-to model — exactly the live ordering.
 */
function resumeThenResolve(): { model: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-resume-'));
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'AMSD-2041', model: PRD_MODEL, aiProvider: 'minimax' }],
  }));
  const script = `
set +e
log() { echo "LOG $*" >&2; }
warning() { echo "WARN $*" >&2; }
info() { echo "INFO $*" >&2; }
MAIN_PRD_FILE="${prd}"
PRD_FILE="${prd}"
STORY_PROVIDER="minimax"

eval "$(awk '/^resolve_model_from_story\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"

# THE REAL RESUME BLOCK, extracted verbatim — not a re-implementation of it. If the resume stops
# recording the restored position, this test goes red rather than quietly agreeing with itself.
resolve_model_provider() { echo "openrouter"; }
STORY_MODEL="${PRD_MODEL}"            # what resolve_provider_settings left behind
_persisted_model="${CLIMBED_TO}"      # what the ladder actually climbed to
eval "$(awk '/if \\[ -n "\\$_persisted_model" \\]/,/^    fi$/' "${CLAUDE_SH}" | sed 's/^        local /        /')"

# ...and then the provider case re-derives from the PRD (claude.sh ~8706).
case "\${STORY_PROVIDER:-codex}" in
  copilot|openai|openrouter|cursor|minimax) resolve_model_from_story "AMSD-2041" ;;
esac

echo "MODEL=\${STORY_MODEL}"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { model: (r.stdout.match(/MODEL=(.*)/) || [])[1] ?? '', stderr: r.stderr || '' };
}

describe('a resumed ladder position survives the PRD model re-derivation', () => {
  it('the fixture actually exercises the re-derivation — otherwise this proves nothing', () => {
    const r = resumeThenResolve();
    expect(r.stderr, 'resolve_model_from_story never ran; the test would pass vacuously')
      .toMatch(/Model\[prd\.json\]/);
  });

  it('THE DEFECT: the climbed-to model is not replaced by the PRD base model', () => {
    const r = resumeThenResolve();
    expect(r.model, `ladder de-escalated: resumed on ${CLIMBED_TO}, ended on ${r.model}`)
      .toBe(CLIMBED_TO);
  });

  it('with NO resume, the PRD model still wins — the fix must not break the normal path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-fresh-'));
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S1', model: PRD_MODEL }] }));
    const script = `
set +e
log() { echo "LOG $*" >&2; }
MAIN_PRD_FILE="${prd}"; PRD_FILE="${prd}"
eval "$(awk '/^resolve_model_from_story\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"
STORY_MODEL=""            # no ladder position restored
resolve_model_from_story "S1"
echo "MODEL=\${STORY_MODEL}"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    expect((r.stdout.match(/MODEL=(.*)/) || [])[1], 'a fresh story must still take the PRD model')
      .toBe(PRD_MODEL);
  });
});
