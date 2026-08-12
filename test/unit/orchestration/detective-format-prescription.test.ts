/**
 * A fix that depends on a data format must SAY what the format is.
 *
 * Live metrolinx 2026-07-26, run 5. The detective's prescription was:
 *
 *   "Change line 17 from strict equality to a prefix match that accounts for
 *    the return-trip key suffix appended by getDispatchLineItemKey"
 *
 * Everything about that is true, and it is still not enough to implement from.
 * It says "a prefix match ... suffix" without ever stating WHAT the suffix is.
 * The implementer guessed `-`; the repository declares `const DIVIDER = '#'`.
 * The resulting change — `startsWith(discount.lineItemId + '-')` — can never
 * match, and the bug shipped unfixed behind a plausible-looking diff.
 *
 * It also named `getDispatchLineItemKey`, the function that CONSTRUCTS the key,
 * when a matcher needs `parseDispatchLineItemKey`, the one that reads it. Naming
 * the writer invites the implementer to reconstruct the format by hand — which
 * is exactly what happened.
 *
 * So a prescription that turns on a string format must either quote the literal
 * or name the constant that owns it. Otherwise it is asking the next agent to
 * guess, and this pipeline has now proved that it will.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const HELPER = join(__dirname, '../../../orchestrations/scripts/lib/fix_prescription_check.py');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fix-prescription-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const KEYS = {
  'src/keys.ts':
    "const DIVIDER = '#';\nconst RETURN_TRIP_TAIL = 'return';\n" +
    'export function getDispatchLineItemKey(id: string, isReturn = false) {\n' +
    '  return isReturn ? `${id}${DIVIDER}${RETURN_TRIP_TAIL}` : id;\n}\n' +
    'export function parseDispatchLineItemKey(key: string) { return key.split(DIVIDER)[0]; }\n',
};

/** Exit 0 = prescription is implementable; 1 = under-specified. */
function check(fix: string, repo: string, helper = 'getDispatchLineItemKey') {
  const r = spawnSync('python3', [HELPER, repo, helper, fix], { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, reason: (r.stdout || '').trim() };
}

describe('a format-dependent fix must name the format', () => {
  it('rejects the live run-5 prescription — "a prefix match" with no separator', () => {
    const repo = repoWith(KEYS);
    const r = check(
      'Change line 17 from strict equality to a prefix match that accounts for the ' +
      'return-trip key suffix appended by getDispatchLineItemKey', repo);
    expect(r.ok,
      'this exact wording let the implementer guess "-" when the repo uses "#", ' +
      'shipping a fix that could never match').toBe(false);
    expect(r.reason).toMatch(/separator|literal|constant|format/i);
  });

  it('accepts the same fix once it quotes the separator', () => {
    const repo = repoWith(KEYS);
    const r = check(
      "Change line 17 to a prefix match on the '#' separator that getDispatchLineItemKey " +
      'appends for return trips', repo);
    expect(r.ok, 'a fully-specified prescription was rejected').toBe(true);
  });

  it('accepts a fix that names the constant instead of the literal', () => {
    const repo = repoWith(KEYS);
    expect(check('Split on DIVIDER before comparing the ids', repo).ok).toBe(true);
  });

  it('accepts a fix that delegates to the parser and does no string surgery itself', () => {
    // The best prescription: no format handling at all, because the helper owns it.
    const repo = repoWith(KEYS);
    const r = check('Use parseDispatchLineItemKey(lineItem.id).id instead of lineItem.id',
                    repo, 'parseDispatchLineItemKey');
    expect(r.ok, 'delegating to the parser is the ideal fix and must not be flagged').toBe(true);
  });

  it('ignores fixes that do not depend on a format at all', () => {
    const repo = repoWith(KEYS);
    expect(check('Return early when discountsForDispatch is empty', repo).ok).toBe(true);
  });

  it('warns when the prescribed helper CONSTRUCTS the value being matched', () => {
    // Naming the writer invites hand-reconstruction of the format; naming the
    // parser makes the format impossible to get wrong.
    const repo = repoWith(KEYS);
    const r = check(
      "prefix match on the '#' separator appended by getDispatchLineItemKey", repo,
      'getDispatchLineItemKey');
    expect(r.reason, 'nothing points out that a parser exists for the same format')
      .toMatch(/parse|reads it|counterpart/i);
  });

  it('fails open when the repo cannot be read', () => {
    // A prescription check must never be the reason a run stalls.
    expect(check('a prefix match with no separator named', '/nonexistent').ok).toBe(true);
  });
});


// THE PROMPT MOVED OUT OF THE ENGINE (2026-08-12) into
// orchestrations/prompts/templates/code-graph-detective.json. Asserting its text against the
// SOURCE of spec-mode-runner.js now proves nothing — and asserting prompt text against source
// never proved much: it passes on a comment or a dead branch. This renders the real prompt and
// asserts what the model is actually sent.
const DETECTIVE_PROMPT = (() => {
  const lib = require('node:path').join(__dirname, '../../../orchestrations/scripts/lib/prompt-library.js');
  return require(lib).buildPrompt(
    'code-graph-detective',
    require('node:path').join(__dirname, '../../../orchestrations/projects/metrolinx'),
    {
      __DETECTIVE_PROFILE__: '', __REPO_PATH__: '/REPO', __TOOL_PATH__: '/TOOL',
      __STORY_TITLE__: 'T', __STORY_DESCRIPTION__: '', __STORY_ACS__: '- AC',
      __KIND_AND_CORRECTIVE_CONTEXT__: '', __PRESEED_BLOCK__: '', __PRESCRIPTION_RULES__: '',
    },
  );
})();

describe('the detective enforces it', () => {
  const SPEC = require('node:fs').readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('asks for the literal or the constant, not a description of it', () => {
    expect(DETECTIVE_PROMPT, 'the prompt still permits "a prefix match" with no separator named')
      .toMatch(/NAME THE FORMAT/);
  });

  it('tells the detective to prescribe the parser, not the writer', () => {
    expect(DETECTIVE_PROMPT).toMatch(/PREFER THE PARSER OVER THE WRITER/);
  });

  it('checks the prescription and retries when it is under-specified', () => {
    expect(SPEC).toMatch(/fix_prescription_check/);
    expect(SPEC, 'the check runs but its verdict changes nothing')
      .toMatch(/UNDER-SPECIFIED[\s\S]{0,200}continue/);
  });

  it('never blocks on the check itself', () => {
    const i = SPEC.indexOf('fix_prescription_check');
    expect(SPEC.slice(Math.max(0, i - 600), i + 600)).toMatch(/catch\s*\{/);
  });
});

describe('the check is language-agnostic — the engine must not assume a stack', () => {
  it('works on a Python repo', () => {
    // The first version filtered to .ts/.js and matched `const|let|var` and
    // `function|const` declarations. On any other stack it would find nothing,
    // fail open, and silently do nothing at all — a no-op wearing the costume
    // of a safeguard.
    const repo = repoWith({
      'app/keys.py':
        "DIVIDER = '#'\n"
        + 'def get_dispatch_line_item_key(id, is_return=False):\n'
        + "    return f'{id}{DIVIDER}return' if is_return else id\n"
        + 'def parse_dispatch_line_item_key(key):\n    return key.split(DIVIDER)[0]\n',
    });
    expect(check('use a prefix match for the suffix', repo, 'get_dispatch_line_item_key').ok,
      'an under-specified fix passed because the checker could not read Python').toBe(false);
    expect(check('split on DIVIDER before comparing', repo, 'get_dispatch_line_item_key').ok,
      'a constant that genuinely exists in a .py file was not recognised').toBe(true);
  });

  it('works on a Go repo', () => {
    const repo = repoWith({
      'pkg/keys.go':
        'const Divider = "#"\n'
        + 'func BuildDispatchKey(id string, isReturn bool) string { return id + Divider }\n'
        + 'func ParseDispatchKey(key string) string { return strings.Split(key, Divider)[0] }\n',
    });
    const r = check('prefix match on the suffix appended by BuildDispatchKey', repo, 'BuildDispatchKey');
    expect(r.ok, 'a Go repo was not scanned at all').toBe(false);
    expect(r.reason, 'the Go parser counterpart was not found').toMatch(/ParseDispatchKey/);
  });

  it('does not treat vendored code as project source', () => {
    // Vendor directories are read from the project's own config and gitignore,
    // not from a list this engine invents.
    const repo = repoWith({
      '.gitignore': 'node_modules/\n',
      'node_modules/dep/keys.js': "const SEPARATOR = '@';\n",
      'src/app.js': 'export const x = 1;\n',
    });
    expect(check('split on SEPARATOR before comparing', repo, '').ok,
      'a constant from a vendored dependency was accepted as project evidence').toBe(false);
  });
});
