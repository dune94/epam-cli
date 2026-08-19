// A FAILED RENDER BECAME AN EMPTY STRING, AND THE PIPELINE CARRIED ON.
//
// Live metrolinx AMSD-2041, 2026-08-19. When jq died on the 128KB argv cap, both call sites took
// the failure through bare command substitution:
//
//   prompt="$(render_engine_prompt writer-plan-section "$_cp_vals" execution_plan)"
//   COORDINATOR_PROMPT_AMENDMENT="$(render_engine_prompt coordinator-amendment "$_cp_vals" ...)"
//
// `x="$(cmd)"` discards the exit status. So the writer was invoked with an EMPTY prompt (the log
// shows attempts returning in 0.01 min with in=0 out=0), and the amendment carried nothing while
// the pipeline believed it had told the writer what to fix. render-engine-prompt.sh's own header
// says the opposite is required: "Exit status is the contract: non-zero means nothing was
// rendered, and the caller must refuse to invoke an agent rather than send it an empty prompt."
// Neither caller honoured it.
//
// jq_vals removes the cause. This removes the AMPLIFIER: a render that fails must never silently
// blank the thing it was supposed to fill. Nine lines above the writer-prompt site the code
// already says "a blank that looks ordinary is the worst failure this pipeline can have" — about
// a different branch, which is exactly how this one was missed.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const LIB = join(ROOT, 'orchestrations/scripts/lib/render-engine-prompt.sh');
const bash = (s: string) => spawnSync('bash', ['-c', s], { encoding: 'utf8' });

describe('render_or_keep — the guarded assignment', () => {
  const src = `
warning() { echo "WARN $*" >&2; }
source ${JSON.stringify(LIB)}
export NODE_CMD=${JSON.stringify(join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node'))}
`;

  it('exists', () => {
    expect(readFileSync(LIB, 'utf8')).toMatch(/render_or_keep\(\)/);
  });

  it('leaves the target untouched when the render fails', () => {
    const r = bash(`${src}
      prompt="the original prompt, which is valid"
      _r="$(render_or_keep no-such-template /nonexistent.json)" && prompt="$_r"
      echo "[$prompt]"`);
    expect(r.stdout.trim(), 'the valid prompt was replaced by nothing')
      .toBe('[the original prompt, which is valid]');
  });

  it('treats an EMPTY successful render as a failure too', () => {
    // A template that renders to nothing is indistinguishable from a dead one at the call site,
    // and is just as fatal to the agent receiving it.
    const r = bash(`${src}
      render_engine_prompt() { printf ''; return 0; }
      prompt="original"
      _r="$(render_or_keep whatever /tmp/x.json)" && prompt="$_r"
      echo "[$prompt]"`);
    expect(r.stdout.trim()).toBe('[original]');
  });

  it('says so on stderr rather than failing quietly', () => {
    const r = bash(`${src}; render_or_keep no-such-template /nonexistent.json 2>&1 >/dev/null`);
    expect(r.stdout + r.stderr).toMatch(/render|WARN/i);
  });

  it('passes a successful render through unchanged, body key included', () => {
    const r = bash(`${src}
      render_engine_prompt() { printf 'BODY:%s:%s' "$1" "$3"; return 0; }
      render_or_keep tmpl /tmp/v.json somebody`);
    expect(r.stdout).toBe('BODY:tmpl:somebody');
  });
});

describe('the call sites that must never blank', () => {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const lines = src.split('\n');

  /** Assignments where a dead render would blank the agent's whole prompt or its only feedback. */
  const critical = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /^\s*(prompt|COORDINATOR_PROMPT_AMENDMENT)="\$\(render_engine_prompt/.test(l));

  it('none of them assigns through a bare command substitution', () => {
    const bare = critical.map(({ l, n }) => `claude.sh:${n}: ${l.trim().slice(0, 70)}`);
    expect(bare, `a failed render here blanks the writer prompt or the retry feedback:\n${bare.join('\n')}`)
      .toEqual([]);
  });

  it('and the guarded form is actually used', () => {
    expect(src, 'nothing calls render_or_keep — the guard is dead code')
      .toMatch(/render_or_keep/);
  });
});
