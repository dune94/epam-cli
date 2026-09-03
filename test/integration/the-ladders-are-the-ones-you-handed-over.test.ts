/**
 * RETEST OF 0d2c25d AND 83add5a — both shipped with no test.
 *
 * export_model_ladders takes a PATH to a settings file. Two ways the caller's own ladders used to
 * disappear, each leaving a run climbing a ladder nobody declared:
 *
 *   0d2c25d — the resolver it merges through takes a project DIRECTORY, so handed any other path
 *             (a fixture, a copy under another name, a set file) it found no project settings and
 *             returned the ENGINE defaults, which silently replaced the file the caller asked for.
 *             "I gave you this file, you used another one."
 *
 *   83add5a — an unparseable settings file returned 0, having exported the engine's chains. The
 *             existing JSON check could never fire: it ran AFTER the merge, and by then it was
 *             reading valid, generated JSON. A guard downstream of the thing that repairs its
 *             input can only ever pass.
 *
 * Both are observed here by running the real function and reading what it actually exported.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../orchestrations/scripts/lib/model-ladders.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A settings file declaring tiers the engine does not use, so borrowed defaults are obvious. */
const DECLARED = {
  ladderTierOrder: ['low', 'hot'],
  ladders: {
    low: { startModel: 'model-alpha', modelLadder: [{ from: 'model-alpha', to: 'model-beta' }] },
    hot: { startModel: 'model-beta', modelLadder: [{ from: 'model-beta', to: 'model-gamma' }] },
  },
};

/** Run export_model_ladders against a file and report what it exported, plus its exit status. */
function exportLadders(contents: string, name = 'settings.json') {
  const dir = mkdtempSync(join(tmpdir(), 'ladders-')); dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, contents);
  const script = `
    set -uo pipefail
    . ${JSON.stringify(LIB)}
    export_model_ladders ${JSON.stringify(file)}
    echo "RC=$?"
    echo "ORDER=\${EPAM_MODEL_LADDER_TIER_ORDER:-<unset>}"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout || ''}`;
  return {
    rc: /RC=(\d+)/.exec(out)?.[1] ?? '',
    order: (/ORDER=(.*)/.exec(out)?.[1] ?? '').trim(),
    stderr: `${r.stderr || ''}`,
  };
}

describe('the ladders are the ones you handed over', () => {
  it('exports the tiers the GIVEN file declares, not the engine defaults', () => {
    // 0d2c25d. If the resolver reached for a project directory instead of this path, the order
    // would come back as the engine's medium/high/highest.
    const got = exportLadders(JSON.stringify(DECLARED));
    expect(got.rc, 'a well-formed settings file must be accepted').toBe('0');
    expect(got.order, "the caller's own tiers were replaced by the engine's").toContain('low');
    expect(got.order).toContain('hot');
    expect(got.order, 'engine defaults leaked in').not.toContain('highest');
  }, 60_000);

  it('does the same when the file is not named llm-settings.json', () => {
    // The exact case in the commit: a fixture, or a copy under a different name.
    const got = exportLadders(JSON.stringify(DECLARED), 's.json');
    expect(got.order).toContain('low');
    expect(got.order, 'the path was ignored in favour of a directory lookup').not.toContain('highest');
  }, 60_000);

  it('REFUSES a malformed settings file instead of quietly using the engine ladders', () => {
    // 83add5a. Silently borrowing the engine's chains means a run climbs to tiers the project
    // deliberately did not choose — and nothing in the log says so.
    // NAMED llm-settings.json, deliberately. The pre-fix bug needed the resolver to SUCCEED and
    // hand back engine defaults, and it only looks for that filename in a project directory. With
    // any other name the resolver finds nothing, the raw file is used, and the downstream check
    // catches it — so a fixture called settings.json passes whether the guard exists or not, which
    // is what my first version of this test did.
    const got = exportLadders('{ "ladders": { "low": ', 'llm-settings.json');
    expect(got.rc, 'an unparseable settings file was accepted').not.toBe('0');
    expect(got.order, 'engine ladders were exported from a file that does not parse')
      .not.toContain('highest');
  }, 60_000);

  it('says why it refused, rather than failing mutely', () => {
    const got = exportLadders('{ "ladders": { "low": ', 'llm-settings.json');
    expect(`${got.stderr}`, 'a refusal with no reason sends the operator hunting')
      .toMatch(/parse|json|malformed|invalid/i);
  }, 60_000);
});
