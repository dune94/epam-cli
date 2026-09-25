/**
 * REPLAY A RUN'S RECORDED REQUESTS THROUGH THE AGENT — seconds, not a 40-minute run.
 *
 * Every exchange a mock-agent run makes is journalled with the exact request the pipeline sent.
 * Replaying those requests through the agent as it is NOW, and reconciling each answer against the
 * code as it is now, shows at once whether a change to the agent (or to a contract) leaves any seam
 * with an answer the pipeline would refuse. MOCK_AGENT_REPLAY_JOURNAL names the journal directory;
 * without it this is skipped. Acting turns (tool calls) are not text answers and are not judged here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../integration/lib/fixture-install';
import { Declarations } from './declarations';
import { parse } from './wire';
import { correct } from './seams';
import { World } from './world';
import { reconcile } from './answer';

const J = process.env.MOCK_AGENT_REPLAY_JOURNAL || '';

describe.skipIf(!J || !existsSync(J))('replaying a recorded run through the agent as it is now', () => {
  it('every recorded request gets an answer the current contracts accept', () => {
    const decl = new Declarations(join(ROOT, 'orchestrations'));
    const world = new World(() => [], () => '', '');
    const behave = correct(world, ROOT);
    const stale: Record<string, number> = {};
    let judged = 0;
    for (const f of readdirSync(J).filter((x) => /^\d+-.*\.json$/.test(x))) {
      const j = JSON.parse(readFileSync(join(J, f), 'utf8'));
      if (j.negative) continue;
      const req = parse(j.path, JSON.stringify(j.request));
      if (!req) continue;
      const turn = behave({ n: j.n, seam: j.seam, template: j.template, coverage: j.coverage, story: j.story, attempt: j.attempt, req }, { decl } as never);
      if (!turn || turn.kind !== 'text') continue;
      judged += 1;
      const prompt = `${req.system}\n${req.messages.find((m) => m.role === 'user')?.text || ''}`;
      const why = reconcile(turn.text, decl.contractOf(j.seam), prompt, decl.templateText(j.template));
      if (why.length) { const k = `${j.seam} (${j.template}): ${why[0]}`; stale[k] = (stale[k] || 0) + 1; }
    }
    expect(judged, 'the journal held no replayable text exchanges').toBeGreaterThan(0);
    expect(stale, 'answers the current code would refuse').toEqual({});
  });
});
