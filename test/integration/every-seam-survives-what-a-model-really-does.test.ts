/**
 * EVERY SEAM, AGAINST EVERY SHAPE A MODEL ACTUALLY RETURNS.
 *
 * The seam tests so far assert a seam is REACHABLE: the runner is invoked, no flag swallowed its
 * neighbour, a prompt arrives, an answer comes back. Every bug that has killed a live run happens
 * AFTER that moment — in what the pipeline does with an answer that is plausible and wrong.
 *
 * Those shapes are not exotic. They are what models return every day:
 *
 *   the right word in the wrong field    seam: "implementer" — killed the 2026-08-31 run
 *   prose wrapped around the JSON        "Let me think... {...} Hope that helps."
 *   markdown fences                      ```json ... ```
 *   truncated mid-object                 the network cut it
 *   empty, or whitespace only            the model produced nothing
 *   a bare array where an object was declared
 *   a null where a string was declared
 *   an extra field nobody declared
 *   a verdict the seam has never emitted
 *
 * A seam that mishandles any of these mishandles it mid-run, having already spent. This drives all
 * 40 through the real hub against every shape and asserts the properties that must hold for all of
 * them.
 */
import { describe, it, expect } from 'vitest';
import { callSeamThroughHub, declaredSeams } from '../helpers/seam-receiver';

const SEAMS = declaredSeams();

/** What models really return, named for what it is. */
const SHAPES: Record<string, string> = {
  'prose around the json': 'Let me think about this.\n\n{"verdict":"pass"}\n\nHope that helps.',
  'markdown fenced': '```json\n{"verdict":"pass"}\n```',
  'truncated mid-object': '{"verdict":"pa',
  'empty': '',
  'whitespace only': '   \n  \t ',
  'a bare array': '[{"verdict":"pass"}]',
  'a bare string': 'pass',
  'null fields': '{"verdict":null,"issues":null}',
  'an undeclared extra field': '{"verdict":"pass","somethingNobodyDeclared":42}',
  'a verdict never emitted': '{"verdict":"inconclusive"}',
  'the right word in the wrong field': '{"kind":"pass","verdict":"implementer"}',
  'nested behind noise': '{"result":{"data":{"verdict":"pass"}}}',
};

describe('every seam survives what a model really does', () => {
  it('there are seams and shapes to cross — otherwise this proves nothing', () => {
    expect(SEAMS.length, 'no seams declared').toBeGreaterThan(30);
    expect(Object.keys(SHAPES).length, 'no shapes to try').toBeGreaterThan(10);
  });

  // One case per seam, crossing every shape inside it: a failure names the seam AND the shape,
  // without the suite becoming 480 separate cases.
  it.each(SEAMS)('%s: no shape makes it claim success it did not earn', (seam) => {
    const broken: string[] = [];
    for (const [name, reply] of Object.entries(SHAPES)) {
      const r = callSeamThroughHub(seam, `prompt for ${seam}`, { reply });

      // 1. It must still REACH its runner. A shape that stops the call happening at all is a
      //    failure upstream of the model, which no retry can fix.
      if (r.runnerArgv.length === 0) { broken.push(`${name}: never reached the runner`); continue; }

      // 2. The hub hands back exactly what the runner said — nothing merged in, nothing invented.
      //    A diagnostic joining the answer is the defect that cost two paid runs.
      if (r.stdout.replace(/\n$/, '') !== reply.replace(/\n$/, '')) {
        broken.push(`${name}: the hub returned something other than the runner's answer`);
      }

      // 3. An unusable answer must not arrive as a clean exit carrying output. "We could not tell"
      //    and "it is fine" have to stay distinguishable to the caller.
      if (!reply.trim() && r.code === 0 && r.stdout.trim()) {
        broken.push(`${name}: an empty answer produced output and a success code`);
      }
    }
    expect(broken, `${seam} mishandled — ${broken.join(' | ')}`).toEqual([]);
  }, 300_000);

  it.each(SEAMS)('%s: a runner that dies is never reported as an answer', (seam) => {
    const r = callSeamThroughHub(seam, `prompt for ${seam}`, { reply: '', exitCode: 1 });
    expect(r.code === 0 && r.stdout.trim() !== '',
      `${seam}: the runner exited 1 with no output and the hub reported success`).toBe(false);
  }, 120_000);
});
