/**
 * NO AGENT EVIDENCE IS CUT MID-MEANING.
 *
 * Operator mandate, 2026-08-15: "i want no truncation of inputs anywhere in pipeline".
 *
 * Every site here severed text INSIDE a unit of meaning and handed it to a model as
 * evidence, as a retry instruction, or as a search query. A severed literal is worse than
 * an absent one: it reads as complete, so the reader acts on the fragment. The standing
 * rule is drop whole entries or nothing — never cut inside one.
 *
 * The shell sites are proven by EXTRACTING THE REAL LINES from the shipped script and
 * running them under bash against fixtures. A source-text grep would pass on a comment.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const ANALYST_SH = join(ROOT, 'orchestrations/scripts/agent-attempt-analyst.sh');

/** A literal placed far past every old cut — it survives only if nothing truncates. */
const MARKER = 'DELIMITER_IS_HASH_NOT_DASH';
const long = (n: number) => 'x'.repeat(n) + MARKER;

function runBash(script: string) {
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return (res.stdout || '') + (res.stderr || '');
}

/** Pull a verbatim slice of the shipped script between two anchors. */
function slab(file: string, startAnchor: string, endAnchor: string) {
  const src = readFileSync(file, 'utf8');
  const a = src.indexOf(startAnchor);
  expect(a, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
  const b = src.indexOf(endAnchor, a);
  expect(b, `end anchor not found: ${endAnchor}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('the gate sees the whole failure evidence', () => {
  function readEvidence(len: number) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-ev-'));
    try {
      const resultJson = join(dir, 'result.json');
      const logFile = join(dir, 'run.log');
      writeFileSync(resultJson, JSON.stringify({ result: long(len) }));
      writeFileSync(logFile, long(len) + '\n');
      const block = slab(CLAUDE_SH, '# Read failure evidence', 'local _failures_file');
      return runBash(`
        set -uo pipefail
        result_json=${JSON.stringify(resultJson)}
        log_file=${JSON.stringify(logFile)}
        VERIFICATION_FAILURE=${JSON.stringify(long(len))}
        ${block.replace(/\blocal\b/g, '')}
        printf 'RESULT=%s\\n' "$(case "$result_text" in *${MARKER}*) echo yes;; *) echo no;; esac)"
        printf 'LOG=%s\\n'    "$(case "$log_tail" in *${MARKER}*) echo yes;; *) echo no;; esac)"
        printf 'VF=%s\\n'     "$(case "$test_failure_snippet" in *${MARKER}*) echo yes;; *) echo no;; esac)"
      `);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is not vacuous — the fixture exceeds every old cut', () => {
    expect(long(4000).length).toBeGreaterThan(1500);
  });

  it('keeps the agent result, the log and the verification failure whole', () => {
    const out = readEvidence(4000);
    expect(out, 'agent result was cut at 1500').toContain('RESULT=yes');
    expect(out, 'log tail was cut at 1500').toContain('LOG=yes');
    expect(out, 'verification failure was cut at 1000').toContain('VF=yes');
  });
});

describe("the writer's self-heal notes arrive whole", () => {
  it('carries a rule sitting past the old 1500 cut', () => {
    // A self-heal note exists so the writer stops repeating a mistake. Cut one mid-literal
    // and it teaches the wrong rule, because the literal IS the fix.
    const dir = mkdtempSync(join(tmpdir(), 'addendum-'));
    try {
      const profiles = join(dir, 'profiles.json');
      writeFileSync(profiles, JSON.stringify({
        'some-role': `[Self-Heal] ${'y'.repeat(2000)}\n[Self-Heal] ${MARKER}\n`,
      }));
      const block = slab(CLAUDE_SH, 'skill_addendum=""', '\n    fi');
      const out = runBash(`
        set -uo pipefail
        profiles_file=${JSON.stringify(profiles)}
        story_role="some-role"
        ${block}
        fi
        printf 'MARK=%s\\n' "$(case "$skill_addendum" in *${MARKER}*) echo yes;; *) echo no;; esac)"
      `);
      expect(out).toContain('MARK=yes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the attempt analyst sees what the agent actually did', () => {
  it('keeps the failed output and the failing prompt whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyst-in-'));
    try {
      const failed = join(dir, 'failed.txt');
      const ctx = join(dir, 'ctx.txt');
      writeFileSync(failed, long(8000));
      writeFileSync(ctx, long(8000));
      const block = slab(ANALYST_SH, '_failed_output=', '\n\n');
      const out = runBash(`
        set -uo pipefail
        FAILED_OUTPUT_FILE=${JSON.stringify(failed)}
        CONTEXT_FILE=${JSON.stringify(ctx)}
        ${block}
        printf 'OUT=%s\\n' "$(case "$_failed_output" in *${MARKER}*) echo yes;; *) echo no;; esac)"
        printf 'CTX=%s\\n' "$(case "$_context" in *${MARKER}*) echo yes;; *) echo no;; esac)"
      `);
      expect(out, 'failed output was cut at 4000').toContain('OUT=yes');
      expect(out, 'the failing prompt was cut at 6000').toContain('CTX=yes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A cut QUERY does not shorten the answer — it silently changes the question, and the
 * caller cannot tell retrieval was narrowed. These read source because the cut was a
 * literal `.slice()` on the query string; there is no artifact to execute without a
 * codegraph/semble binary present.
 */
describe('a search query is never shortened', () => {
  const cases = [
    ['lib/codegraph-context.js', /keywords\.replace\([^)]*\)\.slice\(0,\s*\d+\)/],
    ['lib/codegraph-context.js', /query\.replace\([^)]*\)\.slice\(0,\s*\d+\)/],
    ['lib/semble-context.js', /query\.replace\([^)]*\)\.slice\(0,\s*\d+\)/],
  ] as const;

  for (const [rel, re] of cases) {
    it(`${rel} passes the whole query (${re.source.slice(0, 20)}…)`, () => {
      const src = readFileSync(join(ROOT, 'orchestrations/scripts', rel), 'utf8');
      expect(src).not.toMatch(re);
      // Non-vacuous: the assignment still exists, it just no longer cuts.
      expect(src).toMatch(/const safeQuery = /);
    });
  }
});

describe('spec-pass inputs arrive whole', () => {
  const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('cross-codeline contracts are neither capped nor cut', () => {
    expect(SRC, 'contract list capped at N files').not.toMatch(/files\.slice\(0,\s*\d+\)/);
    expect(SRC, 'each contract body cut mid-document')
      .not.toMatch(/readFileSync\([^)]*'utf8'\)\.slice\(0,\s*\d+\)/);
  });

  it('prior coordinator notes are not sliced into the prompt', () => {
    expect(SRC).not.toMatch(/priorNotes\.slice\(0,\s*\d+\)/);
  });
});
