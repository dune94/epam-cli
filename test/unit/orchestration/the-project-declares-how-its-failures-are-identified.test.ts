/**
 * A GATE THAT CANNOT PARSE ITS CHECKER'S OUTPUT SUBTRACTS NOTHING AND PASSES EVERYTHING.
 *
 * lib/tsc-baseline-gate.sh implements the one thing brownfield actually needs: run the check, and
 * if it is RED, check out the baseline SHA in a throwaway worktree, run the same check there, and
 * block only on the DELTA. Its verdict line is already the operator's policy verbatim — "only
 * pre-existing baseline errors — none introduced by this story."
 *
 * The INVOCATION was migrated to the verification plugin. The PARSING was left behind:
 *
 *     grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+'      (twice)
 *     ln -s "$project_root/node_modules" "$wt_dir/node_modules"
 *
 * The first is tsc's exact output shape; nothing else produces it. The second is a vendor
 * directory the project already declares. Point either at a repo whose checker speaks a different
 * dialect and:
 *
 *     grep matches nothing -> empty baseline cache -> nothing to subtract
 *       -> [ -z "$new_errors" ] -> return 0 -> PASS
 *
 * It reports success having verified nothing. Same shape as the gate preconditions removed
 * earlier — the engine stopped naming the compiler and kept naming the ecosystem, in the one
 * place where "skip" is read as "verified".
 *
 * SO THE PROJECT DECLARES HOW ITS FAILURES ARE IDENTIFIED, alongside how they are produced. A
 * pattern, and which capture groups form a STABLE IDENTITY. With that, one delta helper serves
 * type errors, failing suites, lint violations and anything added later — and none of them can
 * degrade to a pass.
 *
 * SUBTRACT ON IDENTITY, NEVER ON COUNTS. "745 passed -> 735 passed" says nothing about WHICH:
 * a count diff reports "10 before, 10 after, fine" while the failing set changed completely.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const PLUGIN = join(ROOT, 'orchestrations/plugins/verification-plugin.js');
const GATE = join(ROOT, 'orchestrations/scripts/lib/tsc-baseline-gate.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo(decl: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'baseline-')); dirs.push(d);
  mkdirSync(join(d, '.epam'), { recursive: true });
  writeFileSync(join(d, '.epam/verification.json'), JSON.stringify(decl, null, 2));
  return d;
}

function plugin() {
  delete require.cache[require.resolve(PLUGIN)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require(PLUGIN);
}

/** A TypeScript project, declaring how ITS checker reports a failure. */
const TS_DECL = {
  typecheck: {
    command: 'true',
    failurePattern: '^([^(]+)\\((\\d+),(\\d+)\\): error ([A-Z0-9]+)',
    failureIdentity: '{1}:{2}:{4}',
  },
};

/** A completely different ecosystem, declaring its own shape. The engine learns neither. */
const PY_DECL = {
  typecheck: {
    command: 'true',
    failurePattern: '^(\\S+):(\\d+): error: .*\\[([a-z-]+)\\]',
    failureIdentity: '{1}:{2}:{3}',
  },
};

describe('the plugin exposes a failure-identity contract', () => {
  it('parseFailures and newFailures are exported', () => {
    const p = plugin();
    for (const fn of ['parseFailures', 'newFailures']) {
      expect(typeof p[fn], `${fn} must be exported`).toBe('function');
    }
  });
});

describe('IDENTITIES COME FROM THE PROJECT, NOT THE ENGINE', () => {
  it('a TypeScript-shaped failure yields a stable identity', () => {
    const out = 'src/a.ts(12,5): error TS2345: Argument of type X\nsrc/a.ts(99,1): error TS1005: Expected';
    expect(plugin().parseFailures(repo(TS_DECL), out, 'typecheck'))
      .toEqual(['src/a.ts:12:TS2345', 'src/a.ts:99:TS1005']);
  });

  it('a DIFFERENT ecosystem works with no engine change', () => {
    const out = 'app/main.py:31: error: Incompatible types [assignment]\napp/x.py:7: error: Missing return [return]';
    expect(plugin().parseFailures(repo(PY_DECL), out, 'typecheck'))
      .toEqual(['app/main.py:31:assignment', 'app/x.py:7:return']);
  });

  it('the same output under a different declaration parses differently', () => {
    // Proves the pattern is doing the work, not a built-in fallback.
    const out = 'src/a.ts(12,5): error TS2345: bad';
    expect(plugin().parseFailures(repo(PY_DECL), out, 'typecheck')).toEqual([]);
  });
});

describe('AN UNDECLARED PARSE IS UNKNOWN — never an empty failure set', () => {
  it('no failurePattern returns null, not []', () => {
    // [] means "checked, found nothing". null means "cannot tell". Collapsing them is exactly
    // how the old grep returned PASS for every non-TypeScript project.
    const d = repo({ typecheck: { command: 'true' } });
    expect(plugin().parseFailures(d, 'anything(1,1): error TS1: x', 'typecheck')).toBeNull();
  });

  it('newFailures refuses to subtract when either side is unknown', () => {
    const p = plugin();
    expect(p.newFailures(null, ['a'])).toBeNull();
    expect(p.newFailures(['a'], null)).toBeNull();
  });
});

describe('THE SUBTRACTION IS BY IDENTITY, NOT BY COUNT', () => {
  it('a failure present at baseline is not new', () => {
    expect(plugin().newFailures(['a.ts:1:TS1', 'b.ts:2:TS2'], ['a.ts:1:TS1'])).toEqual(['b.ts:2:TS2']);
  });

  it('an equal COUNT with a changed SET still reports the new one', () => {
    // The trap a count-based diff walks into: 1 before, 1 after, entirely different failure.
    expect(
      plugin().newFailures(['b.ts:2:TS2'], ['a.ts:1:TS1']),
      'counts matched and the failing set changed completely',
    ).toEqual(['b.ts:2:TS2']);
  });

  it('inheriting every failure yields nothing new — the operator policy', () => {
    // "For brownfield we inherit existing test failures, but we cannot be expected to fix them."
    expect(plugin().newFailures(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});

describe('NO ECOSYSTEM LITERAL REMAINS IN THE GATE', () => {
  const code = () => readFileSync(GATE, 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('the gate is non-empty, so these assertions are not vacuous', () => {
    expect(code().length).toBeGreaterThan(200);
  });

  it('the gate is VALID SHELL', () => {
    // Caught 2026-08-11: the rewrite left an apostrophe inside an embedded JS comment, which
    // closed the surrounding single-quoted shell string. Every literal assertion in this file
    // still passed while the script would not parse — a file that cannot run is not a gate, and
    // no amount of checking its TEXT reveals that.
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('bash', ['-n', GATE], { encoding: 'utf8' });
    expect(r.status, `bash -n rejected the gate:\n${r.stderr}`).toBe(0);
  });

  for (const banned of ['node_modules', 'error [A-Z0-9]', 'tsconfig']) {
    it(`does not name '${banned}'`, () => {
      expect(
        code(),
        `'${banned}' is a project fact — the vendor dir is declared in dependency-check.json and ` +
        'the error shape in verification.json',
      ).not.toContain(banned);
    });
  }

  it('it routes parsing through the plugin', () => {
    expect(code()).toMatch(/parseFailures|newFailures|verification-plugin/);
  });
});
