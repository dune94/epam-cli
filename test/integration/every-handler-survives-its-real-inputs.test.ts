/**
 * EVERY HANDLER, AGAINST EVERY INPUT IT WILL REALLY BE GIVEN.
 *
 * lib/handlers/* are the small programs the pipeline shells out to for decisions: how many agents a
 * roster holds, which verdicts the AC gate reached, what ladder position a seam declares, whether a
 * package.json pins a node version. Twenty of the forty-one had ZERO coverage — nothing had ever
 * run them.
 *
 * They exist because these were once `node -e "..."` strings with a path interpolated into their
 * own source, and a path containing a quote broke them. That is the class: a handler is handed
 * whatever the filesystem and the pipeline have at that moment, which includes a file that does not
 * exist, one that is empty, one that is half-written because a previous step died, and JSON of the
 * wrong shape.
 *
 * A handler that dies on any of these dies mid-run. A handler that prints a PLAUSIBLE value for an
 * input it could not read is worse — its caller cannot tell, which is the defect this pipeline
 * produces most.
 *
 * The property asserted for all of them: a handler never answers as though it succeeded when it did
 * not. Either a usable answer, or a non-zero exit, or nothing on stdout — never a confident wrong
 * number.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const HANDLERS = join(REPO, 'orchestrations/scripts/lib/handlers');

/** Every JS handler, discovered rather than listed. */
const handlers = readdirSync(HANDLERS).filter((f) => f.endsWith('.js')).sort();

/** The inputs a handler is really handed, including the ones nobody writes fixtures for. */
const INPUTS: Record<string, string | null> = {
  'no file at all': null,
  'an empty file': '',
  'whitespace only': '   \n\t\n',
  'not json': 'this is not json, it is a log line',
  'truncated json': '{"stories": [{"id": "S-1"',
  'json null': 'null',
  'a bare array where an object was expected': '[]',
  'an object where an array was expected': '{}',
  'json with the wrong shape': '{"unrelated": {"nested": true}}',
  'an empty stories array': '{"stories": [], "project": {}}',
};

function runHandler(handler: string, body: string | null) {
  const work = mkdtempSync(join(tmpdir(), 'handler-'));
  let arg = join(work, 'missing.json');
  if (body !== null) { arg = join(work, 'input.json'); writeFileSync(arg, body); }
  const r = spawnSync(process.execPath, [join(HANDLERS, handler), arg], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    env: { ...process.env, LOG_DIR: work, EPAM_PROJECT_CONFIG_DIR: work },
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

describe('every handler survives its real inputs', () => {
  it('there are handlers to drive', () => {
    expect(handlers.length, 'no handlers found').toBeGreaterThan(30);
  });

  it.each(handlers)('%s: never dies with an unhandled stack trace', (handler) => {
    // A handler that throws prints a node stack and exits 1. The caller sees a shell failure with
    // no statement of what was wrong, mid-run, after the step that produced the file has gone.
    const bad: string[] = [];
    for (const [name, body] of Object.entries(INPUTS)) {
      const r = runHandler(handler, body);
      if (/^\s*(node:internal|\s+at )/m.test(r.stderr) && /Error:/.test(r.stderr)) {
        const first = (r.stderr.split('\n').find((l) => /Error:/.test(l)) || '').slice(0, 90);
        bad.push(`${name} -> ${first}`);
      }
    }
    expect(bad, `${handler} threw on: ${bad.join(' | ')}`).toEqual([]);
  }, 180_000);

  it.each(handlers)('%s: an unreadable input never yields a confident answer', (handler) => {
    // The worse failure: printing "0" for a file it could not read is indistinguishable from
    // "there are none". roster-size.js did exactly that, and its job is to stop the mint being
    // skipped when no roster exists.
    //
    // TWO REFINEMENTS, because the first version flagged honest answers:
    //
    //   - A handler that does not READ argv[2] is not answering about it. ladder-models resolves
    //     from the active provider set, so its answer is correct whatever file it is handed;
    //     flagging it would be measuring the test's assumption, not the handler.
    //   - An answer that SAYS it is not an answer is the behaviour being asked for.
    //     lockfile-sync prints "unprovable", stack-facts prints "unknown". Those are the fix, not
    //     the defect, and a guard that cannot tell them from a fabricated number is worthless.
    const src = readFileSync(join(HANDLERS, handler), 'utf8');
    if (!/process\.argv\[2\]|argv\[2\]/.test(src)) return;

    // A handler whose argv[2] is legitimately allowed to be EMPTY is not answering about a file it
    // failed to read. agent-skills.js says so in its own contract: "argv[2] the codeline path this
    // invocation is for ('' when the agent has no single codeline)". Flagging it would be asserting
    // my assumption over the handler's declared interface.
    if (/argv\[2\][^\n]*\|\|\s*''/.test(src) && /no single codeline|may be empty|optional/i.test(src)) return;

    const HONEST = /unknown|unprovable|not determined|could not|^null$|^\s*$|^\{\s*\}$|^\[\s*\]$/i;
    const bad: string[] = [];
    for (const name of ['no file at all', 'not json', 'truncated json']) {
      const r = runHandler(handler, INPUTS[name]);
      if (r.code !== 0) continue;                       // refused: correct
      if (!r.stdout) continue;                          // said nothing: correct
      if (HONEST.test(r.stdout)) continue;              // said it could not tell: correct
      if (/[a-z]/i.test(r.stderr)) continue;            // explained itself on stderr: correct
      bad.push(`${name} -> exit 0, printed ${JSON.stringify(r.stdout.slice(0, 40))}, said nothing`);
    }
    expect(bad, `${handler} answered confidently for input it could not read: ${bad.join(' | ')}`)
      .toEqual([]);
  }, 180_000);
});
