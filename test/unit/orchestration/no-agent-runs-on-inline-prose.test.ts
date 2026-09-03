/**
 * AN AGENT NEVER RUNS ON A PERSONA WRITTEN IN CODE.
 *
 * Three sites in claude.sh carried the shape
 *
 *     [ -z "$reviewer_profile" ] && reviewer_profile="You are a change reviewer. ..."
 *
 * so a missing roster entry silently substituted prose that no prompt file holds, no review ever
 * saw, and no project can specialise. All three personas — prd-change-reviewer, failure-analyst,
 * retry-extension-coordinator — DO exist in both roster sources, which means the fallback could
 * only fire when the roster was broken: exactly the moment when running anyway is worst.
 *
 * The pipeline already knows the right answer elsewhere. runtime-boundary refuses with "cannot
 * render its prompt — refusing to gate with no instructions", and team-lead-review refuses rather
 * than review with an empty brief. A gate that declines is recoverable; a gate that invents its own
 * instructions produces a verdict nobody can audit.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function ask(profilesJson: string | null, key: string) {
  const d = mkdtempSync(join(tmpdir(), 'persona-')); dirs.push(d);
  const f = join(d, 'profiles.json');
  if (profilesJson !== null) writeFileSync(f, profilesJson);
  const r = spawnSync('bash', ['-c',
    `# to stderr, as the run has it: error() on stdout would be swallowed by the command
     # substitution below, and the message that names the missing persona would never be seen
     error(){ echo "ERR $*" >&2; }; warning(){ echo "WARN $*" >&2; }; log(){ :; }
     eval "$(sed -n '/^require_profile() {/,/^}/p' ${JSON.stringify(CLAUDE_SH)})"
     if out=$(require_profile ${JSON.stringify(key)} ${JSON.stringify(f)}); then
       echo "OK:$out"
     else
       echo "REFUSED"
     fi`,
  ], { encoding: 'utf8', timeout: 60000 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

describe('A MISSING PERSONA IS A REFUSAL, NOT A SUBSTITUTION', () => {
  it('returns the roster brief when it exists', () => {
    expect(ask('{"failure-analyst":"the real brief"}', 'failure-analyst')).toContain('OK:the real brief');
  });

  it('refuses when the key is absent rather than inventing one', () => {
    expect(ask('{"someone-else":"x"}', 'failure-analyst'),
      'a missing brief was replaced by prose no prompt file holds and no review saw')
      .toContain('REFUSED');
  });

  it('refuses when the roster file itself is missing', () => {
    expect(ask(null, 'failure-analyst')).toContain('REFUSED');
  });

  it('refuses on an empty brief — present but blank is still no instructions', () => {
    expect(ask('{"failure-analyst":""}', 'failure-analyst')).toContain('REFUSED');
  });

  it('says which persona and which file, so it can be fixed', () => {
    const out = ask('{}', 'retry-extension-coordinator');
    expect(out).toMatch(/retry-extension-coordinator/);
    expect(out).toMatch(/profiles\.json/);
  });
});

describe('AND NO INLINE PERSONA SURVIVES IN THE PIPELINE', () => {
  it('claude.sh carries no "You are ..." fallback', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const offenders = src.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /=\s*"You are /.test(l) && !/^\s*#/.test(l))
      .map(({ l, n }) => `claude.sh:${n}: ${l.trim().slice(0, 70)}`);
    expect(offenders, 'a persona written in code cannot be reviewed, specialised, or version-checked')
      .toEqual([]);
  });
});
