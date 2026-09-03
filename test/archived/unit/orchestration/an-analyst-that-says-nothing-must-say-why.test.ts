/**
 * THREE DIFFERENT FAILURES, ONE MESSAGE — AND ONE OF THEM SILENT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * run_failure_analyst can fail in three distinguishable ways, and the code reports them as
 * two, one of which says nothing at all:
 *
 *   1. THE CALL FAILED (model unreachable, non-zero exit, timeout)
 *          else
 *              _analyst_call_ok="false"      <- NO LOG. NOTHING.
 *
 *   2. THE CALL SUCCEEDED AND RETURNED NOTHING (0 bytes)
 *          "Could not parse JSON from analyst response"
 *
 *   3. THE CALL RETURNED PROSE OR MALFORMED JSON
 *          "Could not parse JSON from analyst response"   <- same message
 *
 * Live 2026-08-12: the analyst failed to parse on roughly half its first calls, and the
 * result files on disk were 0 BYTES — case 2. But from the log alone that is
 * indistinguishable from case 3, and case 1 would have left no trace whatsoever. Diagnosing
 * it required going to /tmp and measuring file sizes.
 *
 * The parser is NOT the problem: it already tries json.loads on the whole response, then
 * brace-matches to extract the first balanced object. If that finds nothing, there was
 * nothing to find.
 *
 * A recovery mechanism that cannot say why it failed cannot be repaired. This does not stop
 * the empty responses — their cause is a provider behaviour not yet established, and guessing
 * at a fix would be inventing a mechanism. It makes the next occurrence legible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

function analystFn(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('run_failure_analyst() {');
  expect(start, 'run_failure_analyst is gone — the test is stale, not the code').toBeGreaterThan(-1);
  let depth = 0; let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const code = () => analystFn().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('the harness is anchored', () => {
  it('the function is found and substantial', () => {
    expect(analystFn().length).toBeGreaterThan(3000);
  });

  it('the retry loop it describes still exists', () => {
    expect(code()).toMatch(/_analyst_call_ok/);
  });
});

describe('A FAILED CALL IS NEVER SILENT', () => {
  it('the invocation-failure branch logs something', () => {
    // `else _analyst_call_ok="false"` with no message means an unreachable gate model leaves
    // NO trace in the run log at all.
    const c = code();
    // LAST occurrence, not first: the first is `local analyst_raw="" ... _analyst_call_ok="false"`,
    // the declaration, which has no logging near it and made this pass for the wrong reason.
    const i = c.lastIndexOf('_analyst_call_ok="false"');
    expect(i, 'the failure branch is gone — the test is stale').toBeGreaterThan(-1);
    const branch = c.slice(i, i + 300);
    expect(branch, 'a failed analyst invocation still logs nothing')
      .toMatch(/warning |error /);
  });
});

describe('AN EMPTY RESPONSE IS NOT A MALFORMED ONE', () => {
  it('the two are reported differently', () => {
    // Both said "Could not parse JSON from analyst response". Diagnosing which required
    // measuring file sizes in /tmp.
    const c = code();
    expect(c, 'an empty response is still reported as a parse failure')
      .toMatch(/returned (an )?empty|empty response|no output/i);
  });

  it('the unparseable case shows what actually came back', () => {
    // "Could not parse JSON" without the text is unactionable: prose, an error page and a
    // truncated object all look identical from the log.
    const c = code();
    const i = c.search(/contained no JSON object/);
    expect(i, 'the no-JSON message is gone — the test is stale').toBeGreaterThan(-1);
    const around = c.slice(i, i + 300);
    expect(around, 'the response text is never surfaced, so the cause cannot be identified')
      .toMatch(/_analyst_snippet/);
  });
});

describe('THE PARSER IS NOT WEAKENED', () => {
  it('it still tries a whole-text parse before extracting a balanced object', () => {
    // The parser is fine and must stay fine — this change is about REPORTING.
    const c = code();
    expect(c).toMatch(/json\.loads\(text\.strip\(\)\)/);
    expect(c).toMatch(/depth = 0/);
  });
});
