/**
 * A DIAGNOSTIC THAT LANDS IN THE PROMPT IS AN INSTRUCTION.
 *
 * The writer's prompt is built by a function whose stdout is captured:
 *
 *     prompt="$(build_implementation_prompt "$story_id")"
 *
 * and log()/warning()/info()/success() all `echo` to STDOUT. Every diagnostic emitted while the
 * prompt is being assembled therefore becomes part of the prompt. error() already writes to
 * stderr; the other four were simply never made consistent with it.
 *
 * Measured in the live prompt the writer received on 2026-08-10 (claude_outputs/
 * AMSD-2041_20260810_200252.log), inside the "## Files to Create/Modify" list:
 *
 *     - \x1b[1;33m[WARNING]\x1b[0m Deliverable '.../src/context/contentstackContext.tsx'
 *       resolved case-insensitively to '/hom
 *     /home/.../src/context/ContentstackContext.tsx (ReadFile this only if you need it ...)
 *
 * The warning text is spliced INTO a list entry and breaks the path across two lines. ANSI escape
 * codes and timestamps sit in the instruction body. The corrupted entry is the case-mismatched
 * file — that is, the resolver's diagnostic destroys the rendering of the very path it just
 * repaired — and it appears twice, because the declared list contains that path twice.
 *
 * So the writer is handed a malformed deliverable list, and no amount of rewording the
 * instructions can fix it: the damage is in the data, injected by the logging.
 *
 * THE RULE: diagnostics go to stderr. They still reach the run log (the launcher redirects both
 * streams), they simply stop being able to reach a captured string. This is a property of the
 * whole file, not of one call site — any future function that logs while its stdout is captured
 * would reintroduce it — so the sweep below covers every diagnostic in the script.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const DIAGNOSTICS = ['log', 'warning', 'info', 'success', 'error'];

/** Extract one function definition from claude.sh, by name. */
function fnBody(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf(`\n${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in claude.sh`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

/**
 * Run a diagnostic and report which stream it used — executed, not inspected.
 * PROGRESS_LOG is pointed at /dev/null so the file-append half is inert.
 */
function streamOf(name: string): { stdout: string; stderr: string } {
  const script = `
set -uo pipefail
PROGRESS_LOG=/dev/null
BLUE=''; YELLOW=''; RED=''; GREEN=''; CYAN=''; MAGENTA=''; BOLD=''; NC=''
${fnBody(name)}
${name} "DIAGNOSTIC_MARKER"
`;
  const out = execFileSync('bash', ['-c', `${script.replace(/`/g, '\\`')} 2>/tmp/epam-diag-stderr.$$; cat /tmp/epam-diag-stderr.$$ >&2; rm -f /tmp/epam-diag-stderr.$$`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: out, stderr: '' };
}

/** Simpler and exact: capture the two streams separately. */
function streams(name: string): { out: string; err: string } {
  const body = fnBody(name);
  const runner = `
set -uo pipefail
PROGRESS_LOG=/dev/null
BLUE=''; YELLOW=''; RED=''; GREEN=''; CYAN=''; MAGENTA=''; BOLD=''; NC=''
${body}
${name} "DIAGNOSTIC_MARKER"
`;
  const res = execFileSync('bash', ['-c',
    `out=$(bash -s <<'SCRIPT' 2>/tmp/e.$$\n${runner}\nSCRIPT\n); err=$(cat /tmp/e.$$); rm -f /tmp/e.$$; printf 'OUT<%s>ERR<%s>' "$out" "$err"`],
    { encoding: 'utf8' });
  const m = res.match(/OUT<([\s\S]*)>ERR<([\s\S]*)>$/);
  return { out: m?.[1] ?? '', err: m?.[2] ?? '' };
}

describe('the harness really runs the diagnostics', () => {
  it('each diagnostic function exists and emits its message somewhere', () => {
    for (const d of DIAGNOSTICS) {
      const { out, err } = streams(d);
      expect(`${out}${err}`, `${d}() emitted nothing — the harness is not exercising it`)
        .toContain('DIAGNOSTIC_MARKER');
    }
  });
});

describe('THE DEFECT: a captured prompt must not be able to absorb a diagnostic', () => {
  it('no diagnostic writes to stdout', () => {
    const offenders = DIAGNOSTICS.filter((d) => streams(d).out.includes('DIAGNOSTIC_MARKER'));
    expect(
      offenders,
      'these reach stdout, so any diagnostic emitted while build_implementation_prompt runs is ' +
      'captured into the writer prompt — measured live inside the deliverable list, splitting a ' +
      'path across two lines',
    ).toEqual([]);
  });

  it('every diagnostic still reaches stderr, so the run log keeps them', () => {
    for (const d of DIAGNOSTICS) {
      expect(streams(d).err, `${d}() went silent — diagnostics must move, not disappear`)
        .toContain('DIAGNOSTIC_MARKER');
    }
  });
});

describe('the shipped prompt artifact carries no diagnostic residue', () => {
  // Guards the rendering itself, not just the functions: a new stdout-writing helper would show
  // up here even if it is not one of the named diagnostics.
  const RESIDUE: Array<[string, RegExp]> = [
    ['ANSI escape codes', /\[[0-9;]*m/],
    ['[WARNING] markers', /\[WARNING\]/],
    ['[ERROR] markers', /\[ERROR\]/],
    ['log timestamps', /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/],
  ];

  it('the prompt builder emits no diagnostic markers on stdout', () => {
    // Render the deliverable-resolution path, which is where the live pollution came from:
    // _resolve_deliverable_path warns while the builder's stdout is being captured.
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('\n_resolve_deliverable_path() {');
    const end = src.indexOf('\n}\n', start);
    const resolver = src.slice(start, end + 3);

    const script = `
set -uo pipefail
PROGRESS_LOG=/dev/null
BLUE=''; YELLOW=''; RED=''; GREEN=''; CYAN=''; MAGENTA=''; BOLD=''; NC=''
${fnBody('warning')}
${fnBody('log')}
${resolver}
d=$(mktemp -d); mkdir -p "$d/src"
printf 'x\\n' > "$d/src/RealName.x"
# A declared path whose case does not match the checkout — the live case.
captured=$(_resolve_deliverable_path "$d/src/realname.x")
printf '%s' "$captured"
rm -rf "$d"
`;
    const captured = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const [label, re] of RESIDUE) {
      expect(re.test(captured), `${label} leaked into a captured value: ${JSON.stringify(captured.slice(0, 160))}`).toBe(false);
    }
    expect(captured, 'the resolver returned nothing — the assertion above would be vacuous').not.toBe('');
  });
});
