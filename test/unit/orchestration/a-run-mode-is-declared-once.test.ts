/**
 * "RESUME THE WRITER" IS ONE NAME, NOT SIX FLAGS AN OPERATOR MUST REMEMBER.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION. 2026-08-13.
 *
 * The operator asked for a writer resume. It was launched with three environment variables —
 * EPAM_SPEC_MODE=0, EPAM_SKIP_AGENT_MINT=1, EPAM_SKIP_JIRA_INGEST=1 — and needed six. CPA, the
 * pre-phase skill assessment and the regression guard all ran anyway, because each is a separate
 * default-ACTIVE step and nothing tied them to the stated intent. Four minutes of a run doing work
 * nobody asked for, and the operator had to notice it themselves.
 *
 * The intent already exists in the codebase, in run-checkpoint.sh:
 *
 *     pre-writer) EPAM_SPEC_MODE=0, EPAM_SKIP_AGENT_MINT=1, SKIP_CPA=1,
 *                 SKIP_SKILL_ASSESSMENT=1, EPAM_SKIP_JIRA_INGEST=1
 *
 * but it is reachable only through a checkpoint, and even that list omits the regression guard.
 * So there are two half-definitions of one idea and no name for it.
 *
 * A MODE IS DATA. The engine reads what a mode skips; it does not know the modes. Adding one is a
 * config edit, and no mode can be half-applied because nobody assembles it by hand.
 *
 * FAILS CLOSED. An unknown mode is a hard error, never a silent full run — a typo must not cost
 * an hour of gates the operator thought they had turned off.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const MODES = join(ROOT, 'orchestrations/config/run-modes.json');
const LIB = join(ROOT, 'orchestrations/scripts/lib/run-modes.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Resolve a mode through the REAL library and report the environment it produced. */
function resolve(mode: string, modesFile = MODES): { out: string; rc: number } {
  const script = `set -uo pipefail
error() { printf 'ERROR %s\\n' "$*"; }
RUN_MODES_FILE=${JSON.stringify(modesFile)}
export RUN_MODES_FILE
NODE_BIN=${JSON.stringify(process.execPath)}
. ${JSON.stringify(LIB)}
apply_run_mode ${JSON.stringify(mode)} || { echo "REFUSED"; exit 3; }
for v in EPAM_SPEC_MODE EPAM_SKIP_AGENT_MINT EPAM_SKIP_JIRA_INGEST SKIP_CPA SKIP_SKILL_ASSESSMENT SKIP_REGRESSION_GUARD; do
  printf '%s=%s\\n' "$v" "$(eval echo \\$$v)"
done`;
  try {
    return { out: execFileSync('bash', ['-c', script], { encoding: 'utf8' }), rc: 0 };
  } catch (e: any) {
    return { out: (e.stdout || '') + (e.stderr || ''), rc: e.status ?? -1 };
  }
}

describe('THE MODE EXISTS AND IS DATA', () => {
  it('run-modes.json declares the modes, and the engine does not', () => {
    expect(existsSync(MODES), 'there is no declaration file, so modes live in code').toBe(true);
    const modes = JSON.parse(readFileSync(MODES, 'utf8'));
    expect(Object.keys(modes.modes || {}).length).toBeGreaterThan(0);
  });

  it('writer-only is declared, and says what it is for', () => {
    const modes = JSON.parse(readFileSync(MODES, 'utf8'));
    expect(modes.modes['writer-only']).toBeTruthy();
    expect(String(modes.modes['writer-only']._what || ''),
      'a mode with no stated purpose is a magic string').not.toBe('');
  });

  it('every declared skip is a real KEY=VALUE, not prose', () => {
    const modes = JSON.parse(readFileSync(MODES, 'utf8'));
    for (const [name, m] of Object.entries<any>(modes.modes)) {
      expect(Array.isArray(m.skips), `${name} declares no skips array`).toBe(true);
      for (const s of m.skips) {
        expect(s, `${name} declares a malformed skip '${s}'`).toMatch(/^[A-Z][A-Z0-9_]*=\S+$/);
      }
    }
  });

  it('no mode names a project, client or codeline', () => {
    const raw = readFileSync(MODES, 'utf8').toLowerCase();
    for (const p of ['metrolinx', 'gotransit', 'upexpress', 'contentstack']) {
      expect(raw, `run-modes.json names '${p}' — a mode must work for any project`).not.toContain(p);
    }
  });
});

describe('WRITER-ONLY MEANS WRITER ONLY', () => {
  const EXPECTED: Record<string, string> = {
    EPAM_SPEC_MODE: '0',
    EPAM_SKIP_AGENT_MINT: '1',
    EPAM_SKIP_JIRA_INGEST: '1',
    SKIP_CPA: '1',
    SKIP_SKILL_ASSESSMENT: '1',
    SKIP_REGRESSION_GUARD: 'true',
  };

  for (const [k, v] of Object.entries(EXPECTED)) {
    it(`sets ${k}=${v}`, () => {
      // Each asserted separately: the failure that started this was ONE missing variable, and a
      // single combined assertion would have reported "mode wrong" without saying which.
      const r = resolve('writer-only');
      expect(r.rc, r.out).toBe(0);
      expect(r.out).toContain(`${k}=${v}`);
    });
  }

  it('the whole intent applies together — no half-applied mode', () => {
    const r = resolve('writer-only');
    for (const [k, v] of Object.entries(EXPECTED)) expect(r.out).toContain(`${k}=${v}`);
  });
});

describe('AN UNKNOWN MODE FAILS CLOSED', () => {
  it('a typo is refused, not silently ignored', () => {
    // Silently ignoring it runs every gate the operator thought they had turned off.
    const r = resolve('writer-onlyy');
    expect(r.rc, 'an unknown mode was accepted').not.toBe(0);
    expect(r.out).toMatch(/writer-onlyy/);
  });

  it('the refusal lists the modes that DO exist', () => {
    expect(resolve('nonsense').out).toMatch(/writer-only/);
  });

  it('an unreadable declaration file is refused too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-modes-')); dirs.push(dir);
    const bad = join(dir, 'run-modes.json');
    writeFileSync(bad, '{ not json');
    const r = resolve('writer-only', bad);
    expect(r.rc, 'a broken declaration file was treated as "no modes"').not.toBe(0);
  });

  it('an EMPTY mode name changes nothing and is not an error', () => {
    // The common case: no mode requested. It must not refuse, and must not set anything.
    const r = resolve('');
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain('SKIP_CPA=');
    expect(r.out).not.toContain('SKIP_CPA=1');
  });
});

describe('AN EXPLICIT SETTING BY THE OPERATOR WINS', () => {
  it('a mode does not override a variable the operator set deliberately', () => {
    // An operator running writer-only who still wants the regression baseline must be able to say
    // so. A mode is a default set, not a straitjacket.
    const script = `set -uo pipefail
error() { printf 'ERROR %s\\n' "$*"; }
RUN_MODES_FILE=${JSON.stringify(MODES)}
NODE_BIN=${JSON.stringify(process.execPath)}
SKIP_REGRESSION_GUARD=false
export RUN_MODES_FILE SKIP_REGRESSION_GUARD
. ${JSON.stringify(LIB)}
# A launcher snapshots the operator's environment before reading any config file; that snapshot
# is what distinguishes a deliberate choice from a project default.
snapshot_operator_env
apply_run_mode writer-only
printf 'SKIP_REGRESSION_GUARD=%s\\n' "$SKIP_REGRESSION_GUARD"
printf 'SKIP_CPA=%s\\n' "$SKIP_CPA"`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(out, "the mode overrode the operator's own setting").toContain('SKIP_REGRESSION_GUARD=false');
    expect(out, 'the rest of the mode did not apply').toContain('SKIP_CPA=1');
  });
});

describe('THE CHECKPOINT AND THE MODE CANNOT DRIFT', () => {
  it("the checkpoint's pre-writer stage resolves through the same declaration", () => {
    // Two half-definitions of one idea is what produced this defect: run-checkpoint.sh's
    // pre-writer list omitted the regression guard, and nothing reconciled them.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh'), 'utf8');
    const i = src.indexOf('resume_skip_env() {');
    const body = src.slice(i, src.indexOf('\n}', i));
    expect(body, 'resume_skip_env still hand-lists its skips instead of naming a mode')
      .toMatch(/run_mode_env/);
    expect(body, 'the pre-writer stage no longer maps to the writer-only mode').toContain('writer-only');
  });
});
