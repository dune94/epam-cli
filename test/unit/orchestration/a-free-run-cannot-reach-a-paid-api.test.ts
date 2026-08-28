/**
 * A FREE RUN CANNOT REACH A PAID API — PROVEN IN A LIVE CHILD, NOT IN CONFIG.
 *
 * 2026-08-25: I told the operator a mockserver run "cannot cost anything". My evidence was a
 * DRY RUN showing ANTHROPIC_BASE_URL resolved, and no key in the LAUNCHER's environment. The
 * real state, read afterwards from /proc/<pid>/environ of a live child:
 *
 *     ANTHROPIC_BASE_URL=UNSET      ANTHROPIC_API_KEY=sk-ant-api03…
 *
 * Every seam called the real Anthropic API while MockServer sat at ZERO requests. Unapproved
 * spend, on my assurance.
 *
 * Cause: run-agent-orchestration.sh executed `.env` with `set -a`, RESTORING every key that had
 * been unset before launch. A guard the run itself undoes is not a guard.
 *
 * THE PROOF MUST BE NEGATIVE. Not "the mock is configured" but "no usable key is reachable" —
 * then a mistake FAILS instead of billing. These assertions run the real loading chain and
 * inspect what a child actually inherits.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');

/** Shapes of a REAL vendor key. A mock placeholder must not match any of them. */
const REAL_KEY = /^(sk-ant-[A-Za-z0-9_-]{10,}|sk-or-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,})$/;

/** The environment a child inherits after the run's own loading chain. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const r = spawnSync('bash', ['-c', `
    cd "${ROOT}"
    . orchestrations/scripts/lib/env-file.sh
    # EXACTLY what run-agent-orchestration.sh does: parse .env in PRESERVE mode, so a value
    # the caller set wins. Mirroring it loosely is how the first version of this test passed
    # while the real chain still restored the keys.
    [ -f "${ROOT}/.env" ] && load_env_file_safe "${ROOT}/.env" preserve
    load_project_env "${ROOT}/orchestrations/projects/metrolinx" preserve >/dev/null 2>&1
    for k in $(compgen -e); do printf '%s=%s\\n' "$k" "\${!k}"; done
  `], { encoding: 'utf8', env: { ...process.env, ...extra } });
  const out: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe('a free run cannot reach a paid API', () => {
  it('the loading chain actually produces an environment — else this is vacuous', () => {
    expect(Object.keys(childEnv()).length).toBeGreaterThan(10);
  });

  it('.env is PARSED, not executed — so unsetting a key before launch survives', () => {
    // EXECUTABLE lines only: the first version of this matched the COMMENT that explains why
    // the old form is gone, and reported the fix as the defect.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(src, 'executing .env restores every key a cost guard unset')
      .not.toMatch(/set -a;\s*\.\s*"\$_env_file"/);
    expect(src, 'the caller\'s value must win over .env, or a scrubbed key comes back')
      .toMatch(/load_env_file_safe "\$_env_file" preserve/);
  });

  it('a PLACEHOLDER set before launch survives the chain — an unset does NOT', () => {
    // THE OPERATIONAL RECIPE, and it is not obvious: preserve mode keeps an already-set,
    // NON-EMPTY value. Unsetting a key, or setting it to "", is NOT "already set" — .env wins
    // and the real key comes back. Scrubbing must SUBSTITUTE, never remove.
    const env = childEnv({
      ANTHROPIC_API_KEY: 'sk-mock-not-real',
      OPENROUTER_API_KEY: 'sk-mock-not-real',
      MINIMAX_API_KEY: 'sk-mock-not-real',
    });
    for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'MINIMAX_API_KEY']) {
      expect(REAL_KEY.test(env[k] || ''), `${k} was restored by the loading chain`).toBe(false);
    }
  });

  it('with keys scrubbed, NO variable anywhere holds a real vendor key', () => {
    // The general form: not just the three names I thought of.
    // SCRUB BY PATTERN, NOT BY MEMORY. The first version listed the three keys I thought of
    // and this assertion caught a fourth — OPENAI_API_KEY — reachable and unscrubbed. A list
    // I maintain by hand is a list that misses the next one.
    const scrub: Record<string, string> = {};
    for (const k of Object.keys(process.env)) {
      if (/API_KEY|_TOKEN$|SECRET/i.test(k)) scrub[k] = 'sk-mock-not-real';
    }
    for (const k of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = k.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && /API_KEY|_TOKEN$|SECRET/i.test(m[1])) scrub[m[1]] = 'sk-mock-not-real';
    }
    const env = childEnv(scrub);
    const leaked = Object.entries(env)
      .filter(([, v]) => REAL_KEY.test(v))
      .map(([k]) => k);
    expect(leaked, 'a real key is reachable — a "free" run could bill').toEqual([]);
  });

  it('the placeholder itself cannot authenticate', () => {
    expect(REAL_KEY.test('sk-mock-not-real'), 'the placeholder must not look like a real key').toBe(false);
  });
});
