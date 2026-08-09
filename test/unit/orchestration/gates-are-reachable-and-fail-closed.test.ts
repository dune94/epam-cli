/**
 * THE FOUR DEFECTS FROM THE GATE REVIEW OF 2026-08-09.
 *
 * A deep review of all 64 gate-like functions turned up four real problems. Three of them are the
 * same idea from different angles: a gate whose failure cannot reach anyone.
 *
 *   1. _run_vitest_check — 25 lines, two failure returns, ZERO call sites. A gate nobody calls.
 *   2. The CPA estimate reviewer — unparseable output defaults to `pass`, in three separate
 *      places. An estimate nobody reviewed is treated as approved. The codebase already settled
 *      this question the other way: code-review-cycle.sh carries "SAFE default = BLOCK, never
 *      silently approve an unreviewed change (2026-07-23)" and implements it. Same question,
 *      opposite answer, one file apart.
 *   3. run_hybrid_precoordination — success is proxied by "the log file is non-empty", so an
 *      agent that errors after writing one line counts as having succeeded. The exit status is
 *      available and discarded; the file even carries comments elsewhere explaining that a
 *      `| tee` pipeline returns tee's status and PIPESTATUS must be read instead.
 *   4. The re-review invocation — `|| true`, so a failed re-implementation of a story the
 *      reviewer rejected leaves no trace at all.
 *
 * The through-line is that none of these announce themselves. A dead gate looks identical to a
 * passing one in the log: silence. That is why the first test here is structural — it asserts no
 * gate is unreachable, so the next dead one is caught by the suite rather than by reading 64
 * functions again.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CTX = join(ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const files = () => [
  join(ROOT, 'orchestrations/scripts/claude.sh'),
  ORCH,
  ...readdirSync(join(ROOT, 'orchestrations/scripts/lib'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join(ROOT, 'orchestrations/scripts/lib', f)),
];

describe('DEFECT 1: no gate is unreachable', () => {
  /**
   * Exempt with a reason. A helper that is genuinely a library entry point, or is invoked
   * indirectly, is not a dead gate — but it has to be named rather than assumed.
   */
  const EXEMPT: Record<string, string> = {};

  function unreachable(): string[] {
    const srcs = files().map((f) => ({ f, s: readFileSync(f, 'utf8') }));
    const all = srcs.map((x) => x.s).join('\n');
    const dead: string[] = [];
    for (const { s } of srcs) {
      for (const m of s.matchAll(/^([a-z_][a-z0-9_]*)\(\) *\{\n/gm)) {
        const n = m[1];
        if (!/^(_?run_|verify_|check_)/.test(n)) continue;
        if (n in EXEMPT) continue;
        const calls = all.split('\n').filter((l) => {
          const t = l.trim();
          if (t.startsWith('#') || t.includes(`${n}() {`)) return false;
          return new RegExp(`(^|[^\\w.])${n}\\b`).test(l);
        });
        if (calls.length === 0) dead.push(n);
      }
    }
    return [...new Set(dead)].sort();
  }

  it('every gate function has at least one call site', () => {
    expect(
      unreachable(),
      'these gates can never run — they are indistinguishable from a passing gate in the log',
    ).toEqual([]);
  });

  it('the sweep actually inspects gates — a broken pattern would pass everything', () => {
    const all = files().map((f) => readFileSync(f, 'utf8')).join('\n');
    const count = [...all.matchAll(/^(_?run_|verify_|check_)[a-z0-9_]*\(\) *\{\n/gm)].length;
    expect(count).toBeGreaterThan(20);
  });
});

describe('DEFECT 2: an unreviewed CPA estimate is not approved', () => {
  /**
   * The shipped parser, lifted verbatim: the python that turns reviewer text into a verdict,
   * plus the `|| echo` shell fallback that runs when even that fails. Both decide the same
   * question and both had to be checked.
   */
  function cpaVerdict(reviewerOutput: string): string {
    const src = readFileSync(CTX, 'utf8');
    const marker = 'm = re.search(r\'\\"verdict\\"';
    const mi = src.indexOf(marker);
    expect(mi, 'the CPA verdict parser was not found — this test is pinned to stale text').toBeGreaterThan(-1);
    const start = src.lastIndexOf('python3 -c "', mi) + 'python3 -c "'.length;
    const endMark = '\n" 2>/dev/null || echo "';
    const end = src.indexOf(endMark, mi);
    const py = src.slice(start, end);
    const fallback = src.slice(end + endMark.length, src.indexOf('"', end + endMark.length));
    const dir = mkdtempSync(join(tmpdir(), 'cpa-')); dirs.push(dir);
    const f = join(dir, 'review.txt');
    writeFileSync(f, reviewerOutput);
    const pyf = join(dir, 'parse.py');
    writeFileSync(pyf, py.replace(/\\"/g, '"'));
    return execFileSync('bash', ['-c',
      `cat ${JSON.stringify(f)} | python3 ${JSON.stringify(pyf)} 2>/dev/null || echo ${JSON.stringify(fallback)}`,
    ], { encoding: 'utf8' }).trim();
  }

  it('a clean pass verdict is still a pass', () => {
    expect(cpaVerdict('{"verdict":"pass","reason":"estimate is sound"}')).toBe('pass');
  });

  it('a clean fail verdict is still a fail', () => {
    expect(cpaVerdict('{"verdict":"fail","reason":"way off"}')).toBe('fail');
  });

  it('UNPARSEABLE output does not approve the estimate', () => {
    expect(
      cpaVerdict('the model rambled and never produced JSON'),
      'an estimate nobody reviewed is treated as approved — the opposite of the convention ' +
      'code-review-cycle.sh states explicitly',
    ).not.toBe('pass');
  });

  it('empty output does not approve the estimate', () => {
    expect(cpaVerdict('')).not.toBe('pass');
  });

  it('JSON with no verdict key does not approve the estimate', () => {
    expect(cpaVerdict('{"reason":"I forgot the verdict"}')).not.toBe('pass');
  });
});

describe('DEFECT 3: coordination success is not "the log is non-empty"', () => {
  /** Runs the real function with the agent call stubbed to a chosen outcome. */
  function hybrid(opts: { exit: number; writes: boolean }) {
    const src = readFileSync(ORCH, 'utf8');
    const start = src.indexOf('run_hybrid_precoordination() {');
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);
    const dir = mkdtempSync(join(tmpdir(), 'hpc-')); dirs.push(dir);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    // No `set -u`: the real scripts run under `set -e` only, and a harness stricter than
    // production fails on variables the function legitimately leaves unset.
    const out = execFileSync('bash', ['-c',
      `LOG_DIR=${JSON.stringify(join(dir, 'logs'))}
       PROJECT_ROOT=${JSON.stringify(dir)}
       MESSAGES_JSONL=${JSON.stringify(join(dir, 'logs', 'agent-messages.jsonl'))}
       PRD_REL="prd.json"
       log() { :; }; info() { :; }; success() { echo "OK:$*"; }
       warning() { echo "WARN:$*"; }; error() { echo "ERR:$*"; }
       run_orch_prompt_with_tools() { ${opts.writes ? 'echo "some output"' : 'true'}; return ${opts.exit}; }
${fn}
       run_hybrid_precoordination core; echo "RC=$?"`,
    ], { encoding: 'utf8' });
    return out;
  }

  it('an agent that fails but writes output is not counted as success', () => {
    const out = hybrid({ exit: 1, writes: true });
    expect(
      out,
      'the agent errored and the log was non-empty, so the failure was invisible',
    ).toMatch(/WARN|ERR/);
  });

  it('a clean run is still a success', () => {
    expect(hybrid({ exit: 0, writes: true })).not.toMatch(/ERR:/);
  });

  it('an agent that succeeds but writes nothing is still flagged', () => {
    expect(hybrid({ exit: 0, writes: false })).toMatch(/WARN/);
  });
});

describe('DEFECT 4: a failed re-review leaves a trace', () => {
  it('the re-implementation call does not discard its exit status', () => {
    // `|| true` on the story that the REVIEWER REJECTED means the one attempt to address the
    // feedback can fail completely and silently, and the loop moves on as if it had run.
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('rereview${_review_cycle}.log"');
    expect(i, 'the re-review invocation was not found').toBeGreaterThan(-1);
    const line = src.slice(src.lastIndexOf('\n', i) + 1, src.indexOf('\n', i));
    expect(
      line.includes('|| true'),
      'the failure is discarded outright — nothing logs it and nothing counts it',
    ).toBe(false);
  });

  it('and the surrounding block reports the failure', () => {
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('rereview${_review_cycle}.log"');
    const block = src.slice(i, i + 500);
    expect(block).toMatch(/warning|error/);
  });
});

/**
 * DEFECT 6, found by the SECOND review pass — the same defect as (2), in a file pass 1 did not
 * check the same way.
 *
 * run_prd_change_reviewer gates changes to the PRD itself: ac_patch, tc_patch, skill_note,
 * profile_addendum. Acceptance criteria are supposed to be immutable, so this is the gate that
 * stops them drifting. It defaulted to `pass` in four separate places, including an explicit
 *
 *     || echo '{"verdict":"pass","issues":[],"reason":"reviewer unavailable"}'
 *
 * — a reviewer that could not be reached approves the change and says so in the reason field.
 *
 * Pass 1 missed this because I grepped for the `jq ... // "approved"` shape and found the
 * python `.get('verdict','pass')` shape only in contextualize-stories.sh. Two files, one
 * pattern, one search that only covered one of them. That is the argument for the second pass.
 *
 * The documented exemption stays: with NO gate model configured the reviewer is disabled and
 * returns pass, which is a deliberate opt-out rather than a failure to review. The distinction
 * is between "not asked" and "asked and got no answer".
 */
describe('DEFECT 6: an unreviewed PRD change is not approved', () => {
  function reviewer(opts: { configured?: boolean; output?: string; exit?: number }) {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const start = src.indexOf('run_prd_change_reviewer() {');
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);
    const dir = mkdtempSync(join(tmpdir(), 'prdrev-')); dirs.push(dir);
    writeFileSync(join(dir, 'ai-run.sh'),
      `#!/usr/bin/env bash\ncat > /dev/null\nprintf '%s' ${JSON.stringify(opts.output ?? '')}\nexit ${opts.exit ?? 0}\n`);
    execFileSync('chmod', ['+x', join(dir, 'ai-run.sh')]);
    const out = execFileSync('bash', ['-c',
      `SCRIPT_DIR=${JSON.stringify(dir)}
       ORCH_GATE_PROVIDER=${JSON.stringify(opts.configured === false ? '' : 'stub')}
       ORCH_GATE_MODEL="stub-model"
       ORCH_GATE_ALLOWED_TOOLS=""
       log() { :; }; warning() { :; }; info() { :; }; success() { :; }; error() { :; }
${fn}
       run_prd_change_reviewer S1 ac_patch '{"a":1}' '{"a":2}' 2>/dev/null`,
    ], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).pop() ?? '';
  }

  it('a clean pass verdict still passes', () => {
    expect(reviewer({ output: '{"verdict":"pass","issues":[],"reason":"fine"}' })).toBe('pass');
  });

  it('a clean fail verdict still fails', () => {
    expect(reviewer({ output: '{"verdict":"fail","issues":["bad"],"reason":"no"}' })).toBe('fail');
  });

  it('an UNREACHABLE reviewer does not approve the change', () => {
    expect(
      reviewer({ output: '', exit: 1 }),
      'the reviewer could not be reached and the acceptance-criteria change was approved',
    ).not.toBe('pass');
  });

  it('UNPARSEABLE output does not approve the change', () => {
    expect(reviewer({ output: 'I could not decide, sorry' })).not.toBe('pass');
  });

  it('JSON with no verdict key does not approve the change', () => {
    expect(reviewer({ output: '{"issues":[],"reason":"forgot the verdict"}' })).not.toBe('pass');
  });

  it('a reviewer that is NOT CONFIGURED still passes — disabled is not the same as failed', () => {
    // The documented opt-out: no gate model means the reviewer was never asked. Turning that
    // into a block would stop every run that does not configure a gate provider.
    expect(reviewer({ configured: false })).toBe('pass');
  });
});
