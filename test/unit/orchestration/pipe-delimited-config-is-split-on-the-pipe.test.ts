/**
 * EVERY PIPE-DELIMITED CONFIG VAR MUST BE SPLIT ON THE PIPE. A MISSING IFS IS SILENT.
 *
 * Pipe-delimited strings are this codebase's serialisation format from JSON config into shell
 * env: EPAM_MODEL_LADDER_*, EPAM_EFFORT_LADDER, EPAM_LADDER_TIERS, EPAM_AUTO_PLANNER_TIERS,
 * EPAM_MODEL_PROVIDER_MAP, EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP.
 *
 * `for x in $VAR` word-splits on WHITESPACE. A pipe-delimited value therefore yields exactly ONE
 * token — the whole string — and bash reports no error. Live 2026-08-10, `ladder_models` set
 * IFS for its inner loop and not its outer one:
 *
 *     for _t in ${EPAM_LADDER_TIERS}          # "high|medium|highest" stayed one token
 *       _var="EPAM_MODEL_LADDER_HIGH|MEDIUM|HIGHEST"   # not a variable name
 *       ${!_var:-}                             # empty
 *     -> permitted set EMPTY -> the ladder-only rule permitted everything
 *
 * The defect cost a live run to notice, and only because it was masked by an unrelated fix.
 *
 * This is a SWEEP, not a case: it fails on any FUTURE consumer that iterates one of these
 * variables without establishing IFS first. A helper alone would not do that — nothing stops
 * someone writing a raw loop. The point is that the whole class becomes impossible to
 * reintroduce silently.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');

/** claude.sh plus every lib/*.sh — wherever shell reads config. */
function shellSources(): Array<{ file: string; text: string }> {
  const files = [join(SCRIPTS, 'claude.sh'), join(SCRIPTS, 'run-agent-orchestration.sh')];
  for (const f of readdirSync(join(SCRIPTS, 'lib'))) {
    if (f.endsWith('.sh')) files.push(join(SCRIPTS, 'lib', f));
  }
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

/**
 * A `for x in $SOMETHING` over an EPAM_* variable, with the line number and whether an
 * `IFS='|'` establishment appears in the enclosing lines above it.
 */
type Site = { file: string; line: number; code: string; hasIfs: boolean };

function loopSites(): Site[] {
  const out: Site[] = [];
  for (const { file, text } of shellSources()) {
    const lines = text.split('\n');
    lines.forEach((l, idx) => {
      // `for X in ${EPAM_...}` / `for X in $EPAM_...`
      if (!/^\s*for\s+\w+\s+in\s+\$\{?EPAM_[A-Z0-9_]+/.test(l)) return;
      // Look back for an IFS establishment in the same function/block.
      const back = lines.slice(Math.max(0, idx - 12), idx).join('\n');
      out.push({
        file: file.replace(ROOT, ''),
        line: idx + 1,
        code: l.trim(),
        hasIfs: /IFS=['"]?\|/.test(back),
      });
    });
  }
  return out;
}

describe('the sweep finds real loops — otherwise it proves nothing', () => {
  it('there are pipe-delimited consumers to check', () => {
    const sites = loopSites();
    expect(
      sites.length,
      'the detection regex matches nothing — this sweep would pass vacuously forever',
    ).toBeGreaterThan(2);
  });
});

describe('THE DEFECT CLASS: every consumer establishes IFS before iterating', () => {
  it('no loop over an EPAM_* config var splits on whitespace', () => {
    const offenders = loopSites().filter((s) => !s.hasIfs);
    expect(
      offenders.map((s) => `${s.file}:${s.line}  ${s.code}`),
      'these iterate a pipe-delimited variable without setting IFS=\'|\' — bash will not error, ' +
      'it will silently produce ONE token containing the whole string',
    ).toEqual([]);
  });
});

describe('the failure mode itself, demonstrated', () => {
  const run = (script: string) =>
    execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();

  it('without IFS a pipe-delimited value is ONE token', () => {
    const out = run(`V="a|b|c"; n=0; for x in $V; do n=$((n+1)); done; printf '%s' "$n"`);
    expect(out, 'if this is not 1, the premise of this whole file is wrong').toBe('1');
  });

  it('with IFS it is three', () => {
    const out = run(`V="a|b|c"; IFS='|'; n=0; for x in $V; do n=$((n+1)); done; printf '%s' "$n"`);
    expect(out).toBe('3');
  });

  it('the invalid variable name DOES error — but a command substitution swallows it', () => {
    // My first explanation was that bash silently returns empty. It does not: `${!bad|name}` is
    // a hard "bad substitution" error. The reason it was invisible is one layer up —
    // `_permitted=$(ladder_models)` runs the function in a SUBSHELL, so the error kills only the
    // subshell and the caller receives an empty string and carries on. Command substitution
    // converts a fatal error into a plausible empty value.
    // Wrapped in a subshell: unguarded, the bad substitution terminates the whole shell before
    // anything can report on it — which is itself the point.
    const direct = execFileSync('bash', ['-c',
      `( V="high|medium"; name="PREFIX_$V"; printf '%s' "\${!name:-EMPTY}" ) 2>/dev/null; echo "RC=$?"`],
      { encoding: 'utf8' }).trim();
    expect(direct, 'the bad substitution did not fail as expected').toMatch(/RC=[^0]/);

    const swallowed = execFileSync('bash', ['-c',
      `f() { V="high|medium"; name="PREFIX_$V"; printf '%s' "\${!name:-EMPTY}"; }\n` +
      `out=$(f 2>/dev/null); echo "caller_saw=[$out] rc=$?"`],
      { encoding: 'utf8' }).trim();
    // Measured, not assumed: the caller receives an EMPTY string (and a non-zero status it is
    // free to ignore). The empty VALUE is what did the damage — the guard read it as "no ladder
    // configured" and permitted everything. A non-zero status nobody checks is not a safety net.
    expect(
      swallowed,
      'the caller should receive an empty string from the failed substitution',
    ).toMatch(/caller_saw=\[\]/);
  });

});
