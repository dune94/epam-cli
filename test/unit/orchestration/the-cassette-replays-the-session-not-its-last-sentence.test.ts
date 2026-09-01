/**
 * A CASSETTE HOLDS 178 TURNS. THE READER SERVED THE LAST SENTENCE.
 *
 * cassetteReply() walks a capture's turns in reverse and returns the first one carrying text:
 * "Turns are indexed; the last one carries the answer the pipeline consumed." True for a seam that
 * answers by TALKING. False, and quietly destructive, for one that answers by ACTING.
 *
 * roster-specialiser writes its roster with bash. Its recording is a 178-turn session containing
 * 216 bash references — the reads, the batched persona dumps, the write itself, and then a sentence
 * describing what it had done. The reader returned the sentence. Serving it left no file behind,
 * the contract refused three attempts running, and the pipeline halted at mint with "the agent
 * wrote no roster" — naming a destination, three stages downstream of the cause.
 *
 * The Langfuse source already learned exactly this and says so in its own comment: "Replaying any
 * ONE of them reproduces a fragment: the capture I first served was an exploratory read, so the
 * roster was never written and the contract refused it three runs running." It returns whole
 * sessions, in order, as { turns, multi: true }. The cassette source never got that fix, so the
 * richest recordings in the repository were the ones least able to be replayed.
 *
 * THE FIXTURE IS ASSERTED FIRST. If the cassette on disk stopped carrying tool calls, every claim
 * below would pass for the wrong reason.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LOADER = join(REPO, 'orchestrations/scripts/mock-expectations.js');
const PRD = join(REPO, 'orchestrations/projects/mock3/prd.json');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const SEAM = 'roster-specialiser';
const CASSETTE = join(REPO,
  'orchestrations/cassettes/metrolinx-latest-20260823T034354Z/roster-specialiser.json');

function mockServerUp(): boolean {
  const r = spawnSync(NODE20, ['-e', `
    const http = require('http');
    const rq = http.request({ host: '127.0.0.1', port: 1080, path: '/mockserver/status',
      method: 'PUT', timeout: 4000 }, (res) => process.exit(res.statusCode === 200 ? 0 : 1));
    rq.on('error', () => process.exit(1));
    rq.on('timeout', () => process.exit(1));
    rq.end();`], { timeout: 15000 });
  return r.status === 0;
}

const UP = mockServerUp();
const out = UP ? (() => {
  const r = spawnSync(NODE20, [LOADER], {
    encoding: 'utf8', timeout: 560000, cwd: REPO, env: { ...process.env, PRD_FILE: PRD },
  });
  return (r.stdout || '') + (r.stderr || '');
})() : '';

/** The line the report gives for one seam, wherever it landed. */
function lineFor(seam: string): string {
  return out.split('\n').find((l) => l.trim().startsWith(seam)) || '';
}

describe('the cassette replays the session, not its last sentence', () => {
  it('THE FIXTURE: the recording really is a multi-turn session that made tool calls', () => {
    expect(UP, 'MockServer is not reachable on :1080').toBe(true);
    expect(existsSync(CASSETTE), 'the driving cassette is gone').toBe(true);
    const doc = JSON.parse(readFileSync(CASSETTE, 'utf8'));
    const turns = Array.isArray(doc) ? doc : Object.keys(doc).filter((k) => /^\d+$/.test(k)).map((k) => doc[k]);
    expect(turns.length, 'the cassette is single-turn; this test would prove nothing')
      .toBeGreaterThan(1);
    const calls = turns.reduce((n: number, t: any) => n + ((t && t.toolCalls) || []).length, 0);
    expect(calls, 'the cassette carries no tool calls at all').toBeGreaterThan(0);
  }, 30_000);

  it('THE DEFECT: the seam is served from its recording, not set aside as prose', () => {
    const line = lineFor(SEAM);
    expect(line, `${SEAM} appears nowhere in the report`).not.toBe('');
    expect(line, `${SEAM} was set aside as unusable though its recording carries the tool calls `
      + `that do the work:\n  ${line}`).not.toMatch(/prose|ends in prose/i);
  }, 600_000);

  it('and the report says it is a session, so a reader can see what will be replayed', () => {
    expect(lineFor(SEAM), 'the entry does not identify a multi-turn replay')
      .toMatch(/turn|tool call/i);
  }, 600_000);

  it('the accounting still holds — nothing was fixed by losing a seam', () => {
    const num = (re: RegExp) => { const m = re.exec(out); return m ? Number(m[1]) : null; };
    const total = /(\d+) of (\d+) declared seam\(s\) accounted for/.exec(out);
    expect(total, 'no accounting line printed').not.toBeNull();
    expect(Number(total![1]), `${total![1]} of ${total![2]} accounted for`).toBe(Number(total![2]));
    expect(num(/covered (\d+) seam/i)!, 'the covered count went down').toBeGreaterThan(9);
  }, 600_000);
});
