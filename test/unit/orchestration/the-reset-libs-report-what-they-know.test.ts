/**
 * TWO RESET-STAGE LIBRARIES WITH NO TEST AT ALL, AND A DEFECT IN ONE OF THEM.
 *
 * spend-probe.sh answers "what did this run cost", and codeline-scope.sh answers "which
 * repositories may this run destroy". The second scopes `git reset --hard` plus `clean -fd`, so a
 * wrong answer discards commits. Neither had a line of coverage.
 *
 * THE DEFECT, found by executing spend_probe_report rather than reading it:
 *
 *   _spent=$(node -e "console.log((($2)-($1)).toFixed(4))" "$_before" "$_after" ...)
 *
 * `$1` and `$2` are expanded by BASH before node ever sees the string, so they are the shell
 * function's positional parameters — $1 is the before-figure and $2 is unset. The expression became
 * `(()-(1.00))`, a syntax error, and the `|| echo "?"` swallowed it. Every run reported
 * "spent this run: $?" and nobody could tell that the figure had never been computed. Real cost
 * tracking is the operator's stated first priority.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const SPEND = join(REPO, 'orchestrations/scripts/lib/spend-probe.sh');
const SCOPE = join(REPO, 'orchestrations/scripts/lib/codeline-scope.sh');
const NODE = process.execPath;

function sh(script: string) {
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 60_000, cwd: REPO,
    env: { ...process.env, NODE_BIN: NODE },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

describe('spend_probe_report states the spend, or states nothing', () => {
  it('COMPUTES the delta between before and after', () => {
    const r = sh(`. ${JSON.stringify(SPEND)}
      spend_probe_read() { echo "3.50"; }
      spend_probe_report "1.00"`);
    expect(r.out).toContain('usage after: $3.50');
    expect(r.out, 'the spend was never computed — the figure the operator asked for first')
      .toContain('spent this run: $2.5000');
  }, 90_000);

  it('and a negative or zero delta is still a real figure, not a shrug', () => {
    const same = sh(`. ${JSON.stringify(SPEND)}
      spend_probe_read() { echo "5.00"; }
      spend_probe_report "5.00"`);
    expect(same.out).toContain('spent this run: $0.0000');
  }, 90_000);

  it('with NO before-figure it reports usage only — it does not invent a delta', () => {
    const r = sh(`. ${JSON.stringify(SPEND)}
      spend_probe_read() { echo "7.25"; }
      spend_probe_report ""`);
    expect(r.out).toContain('usage: $7.25');
    expect(r.out, 'a spend was reported against a baseline that does not exist')
      .not.toContain('spent this run');
  }, 90_000);

  it('when the probe reads NOTHING it says nothing — "we could not tell" is not "it cost nothing"', () => {
    // Only one of those two answers is safe, and inventing a 0 is the unsafe one.
    const r = sh(`. ${JSON.stringify(SPEND)}
      spend_probe_read() { echo ""; }
      spend_probe_report "1.00"; echo "RC=$?"`);
    expect(r.out).toContain('RC=0');
    expect(r.out, 'an unreadable probe was reported as a spend of zero').not.toMatch(/usage|spent/);
  }, 90_000);

  it('a set that declares no probe reads nothing, silently', () => {
    const r = sh(`. ${JSON.stringify(SPEND)}
      EPAM_PROVIDER_SET=definitely-not-a-set spend_probe_read; echo "RC=$?"`);
    expect(r.out.replace('RC=0', '').trim(),
      'an undeclared probe produced a figure from somewhere').toBe('');
    expect(r.out).toContain('RC=0');
  }, 90_000);
});

describe('codeline_scope_paths reads the scope from the run, and nothing is not everything', () => {
  function prdFile(body: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'scope-'));
    const f = join(dir, 'prd.json');
    writeFileSync(f, JSON.stringify(body));
    return f;
  }

  it('reads outputDirs and outputDir, de-duplicated', () => {
    const f = prdFile({ project: {
      outputDir: '/o/be',
      outputDirs: [{ path: '/o/be' }, { path: '/o/fe' }],
    } });
    const r = sh(`. ${JSON.stringify(SCOPE)}; codeline_scope_paths ${JSON.stringify(f)}`);
    expect(r.out.split('\n').filter(Boolean).sort()).toEqual(['/o/be', '/o/fe']);
  }, 90_000);

  it('an ABSENT prd yields nothing and does not fail the caller', () => {
    // Nothing is not everything: a run that has not resolved its scope cannot have dirtied a
    // codeline, so the caller must reset nothing. The mechanism this replaced swept every
    // repository under the codeline root, which is how a finished codeline gets destroyed.
    const r = sh(`. ${JSON.stringify(SCOPE)}; codeline_scope_paths ""; echo "RC=$?"`);
    expect(r.out).toBe('RC=0');
    const missing = sh(`. ${JSON.stringify(SCOPE)}; codeline_scope_paths /no/such/prd.json; echo "RC=$?"`);
    expect(missing.out).toBe('RC=0');
  }, 90_000);

  it('a PRD with no project block yields nothing', () => {
    const f = prdFile({ stories: [] });
    const r = sh(`. ${JSON.stringify(SCOPE)}; codeline_scope_paths ${JSON.stringify(f)}`);
    expect(r.out).toBe('');
  }, 90_000);

  it('non-string and empty paths are discarded rather than passed on', () => {
    const f = prdFile({ project: { outputDirs: [{ path: '' }, { path: null }, { path: '/o/real' }] } });
    const r = sh(`. ${JSON.stringify(SCOPE)}; codeline_scope_paths ${JSON.stringify(f)}`);
    expect(r.out.split('\n').filter(Boolean)).toEqual(['/o/real']);
  }, 90_000);

  it('invalid JSON is REFUSED with a reason, not treated as an empty scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-'));
    const f = join(dir, 'prd.json');
    writeFileSync(f, '{ not json');
    const r = sh(`. ${JSON.stringify(SCOPE)}; codeline_scope_paths ${JSON.stringify(f)}; echo "RC=$?"`);
    expect(r.out, 'a broken PRD passed as "no scope"').toContain('RC=1');
    expect(r.err).toMatch(/not valid JSON/);
  }, 90_000);
});

describe('codeline_in_scope matches EXACTLY, because it gates a destructive reset', () => {
  function repoAndPrd() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'inscope-')));
    for (const d of ['metrolinx', 'azure.metrolinx.com', 'next.metrolinx.com']) {
      mkdirSync(join(root, d), { recursive: true });
    }
    const f = join(root, 'prd.json');
    writeFileSync(f, JSON.stringify({ project: { outputDirs: [{ path: join(root, 'metrolinx') }] } }));
    return { root, f };
  }

  it('the declared codeline is in scope', () => {
    const { root, f } = repoAndPrd();
    const r = sh(`. ${JSON.stringify(SCOPE)}
      codeline_in_scope ${JSON.stringify(join(root, 'metrolinx'))} ${JSON.stringify(f)}; echo "RC=$?"`);
    expect(r.out).toContain('RC=0');
  }, 90_000);

  it('a SUBSTRING neighbour is NOT — this is what destroyed five unrelated repositories', () => {
    // The deleted mechanism compared with `case $a in *"$b"*` in BOTH directions, so one name
    // selected six repositories. The operation being scoped is `git reset --hard` plus `clean -fd`:
    // it discards commits. A destructive operation must never be scoped by substring.
    const { root, f } = repoAndPrd();
    for (const neighbour of ['azure.metrolinx.com', 'next.metrolinx.com']) {
      const r = sh(`. ${JSON.stringify(SCOPE)}
        codeline_in_scope ${JSON.stringify(join(root, neighbour))} ${JSON.stringify(f)}; echo "RC=$?"`);
      expect(r.out, `${neighbour} was accepted into the scope of a destructive reset`)
        .toContain('RC=1');
    }
  }, 90_000);

  it('a directory that does not exist is not in scope', () => {
    const { root, f } = repoAndPrd();
    const r = sh(`. ${JSON.stringify(SCOPE)}
      codeline_in_scope ${JSON.stringify(join(root, 'nope'))} ${JSON.stringify(f)}; echo "RC=$?"`);
    expect(r.out).toContain('RC=1');
  }, 90_000);

  it('an empty candidate is not in scope', () => {
    const { f } = repoAndPrd();
    const r = sh(`. ${JSON.stringify(SCOPE)}; codeline_in_scope "" ${JSON.stringify(f)}; echo "RC=$?"`);
    expect(r.out).toContain('RC=1');
  }, 90_000);
});
