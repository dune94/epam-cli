/**
 * THE PROVIDER SET IS THE AUTHORITY, NOT AN AMBIENT ENV VAR.
 *
 * llm-handler.sh chose its provider with a bare read:
 *
 *     PRIMARY_PROVIDER="${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"
 *
 * which knows nothing about the provider set in force. So on 2026-08-29 a metrolinx run launched
 * with EPAM_PROVIDER_SET=claude resolved the claude ladder — "at the top of its declared chain
 * (claude-opus-5)" — and then asked provider 'openrouter' for it, because the repo's .env still carried
 * EPAM_ORCHESTRATION_PROVIDER=openrouter from another stack. Three attempts, no completion record, and
 * the run died after the roster had already been minted and reviewed against real client code.
 *
 * This repo has the incident on record once already: a stale file's provider beat an explicit
 * launch. Twice is a design fault, not an accident.
 *
 * The SET is the deliberate, per-launch choice; the env var is whatever a file left behind. So a
 * provider the active set cannot route is overridden by one it can, and the substitution is
 * announced — never silent, because an operator who really meant openrouter must see that they did not
 * get it.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(__dirname, '../../../');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');

/** Ask the real resolver, in the real file, under a given environment. */
function resolve(env: Record<string, string>) {
  const r = spawnSync('bash', ['-c',
    `# NO warning()/info()/log() DEFINED — deliberately.
     #
     # The first version of the resolver called warning(), which llm-handler.sh does not define at
     # the point the provider is chosen. Under set -euo pipefail that is "command not found", the
     # command substitution aborts, and the provider silently stays whatever the environment said.
     # The metrolinx run of 2026-08-29 failed a second time on exactly that, with the fix in place.
     # The harness leaves them undefined so the resolver must not depend on them.
     SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
     eval "$(sed -n '/^resolve_primary_provider() {/,/^}/p' ${JSON.stringify(HANDLER)})"
     resolve_primary_provider`,
  ], { encoding: 'utf8', timeout: 60000, env: { ...process.env, AI_PROVIDER: '', EPAM_ORCHESTRATION_PROVIDER: '', EPAM_PROVIDER_SET: '', ...env } });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

describe('A PROVIDER THE SET CANNOT ROUTE IS NOT USED', () => {
  it('THE DEFECT: a stale env provider no longer beats an explicit set', () => {
    const { out } = resolve({ EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter' });
    expect(out, 'the run asked openrouter for a claude model, exactly as it did on 2026-08-29')
      .not.toBe('openrouter');
    expect(out).toBe('claude');
  });

  it('and says so, because a silent substitution is its own defect', () => {
    const { err } = resolve({ EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter' });
    expect(err).toMatch(/openrouter/);
    expect(err).toMatch(/claude/);
  });

  it('leaves a provider the set CAN route exactly as given', () => {
    expect(resolve({ EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'claude' }).out)
      .toBe('claude');
  });

  it('honours AI_PROVIDER when the set can route it', () => {
    expect(resolve({ EPAM_PROVIDER_SET: 'claude', AI_PROVIDER: 'claude' }).out).toBe('claude');
  });

  it('falls back to the env untouched when no set is declared', () => {
    // A run that names no set has not expressed a preference this can contradict.
    expect(resolve({ EPAM_ORCHESTRATION_PROVIDER: 'openrouter' }).out).toBe('openrouter');
  });

  it('supplies the set\'s provider when the env names none at all', () => {
    expect(resolve({ EPAM_PROVIDER_SET: 'claude' }).out).toBe('claude');
  });
});

describe('AND THE HUB ACTUALLY USES IT', () => {
  // Caught by mutation: reverting the assignment to the old bare env read left
  // resolve_primary_provider defined but unused, and every test above stayed green. A resolver
  // nothing calls is the same defect with a nicer shape.
  it('PRIMARY_PROVIDER comes from the resolver, not from a bare env read', () => {
    const src = readFileSync(HANDLER, 'utf8');
    expect(src, 'the hub reads the environment directly again, so the set cannot decide anything')
      .toMatch(/PRIMARY_PROVIDER="\$\(resolve_primary_provider\)"/);
    // Two later assignments are deliberate and must stay: an explicit --provider flag (the most
    // deliberate signal there is) and the replay substitution that guarantees a rehearsal never
    // reaches a paid provider. Anything ELSE reassigning it would decide the provider behind the
    // resolver's back, which is how the env came to win in the first place.
    const assignments = src.split('\n')
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter(({ l }) => /^PRIMARY_PROVIDER=/.test(l));
    const unexpected = assignments.filter(({ l }) =>
      !/resolve_primary_provider/.test(l) && !/"\$\{2:-\}"/.test(l) && !/"replay"/.test(l));
    expect(unexpected.map((a) => `line ${a.n}: ${a.l}`),
      'an assignment that is neither the resolver, the explicit flag, nor the replay guarantee')
      .toEqual([]);
    expect(assignments[0].l, 'the FIRST assignment must be the resolver')
      .toMatch(/resolve_primary_provider/);
  });
});
