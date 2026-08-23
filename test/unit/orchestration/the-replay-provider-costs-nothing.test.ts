/**
 * A REHEARSAL THAT SPENDS NOTHING.
 *
 * Every run-killing bug this month was plumbing — an unbound variable, a function used and never
 * imported, an env var handed the wrong directory — and every one of them was found by paying a
 * provider to reach the line that broke. Langfuse has been recording each turn of every run all
 * along, so a rehearsal does not need to generate anything: it replays what a real run said.
 *
 * These tests hold the replay provider to the two properties that make it worth having:
 *   - it NEVER reaches the network, whatever it is asked
 *   - when the pipeline diverges from the recording, it SAYS SO rather than inventing an answer
 *
 * The second is the one that matters. A replay that answers a turn it has no recording for is a
 * rehearsal that passes for reasons unrelated to the code under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayProvider } from '../../../src/providers/replay/ReplayProvider.js';
import type { ProviderRequest } from '../../../src/providers/types.js';

const { safeSeamFile } = require('../../../orchestrations/scripts/lib/cassette-store.js');

const REQ: ProviderRequest = {
  messages: [{ role: 'user', content: 'anything at all' }],
  model: 'whatever',
  stream: false,
};

let dir: string;
const ENV = { ...process.env };

const cassette = (seams: Record<string, unknown[]>) => {
  const d = mkdtempSync(join(tmpdir(), 'cassette-'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ session: 'TEST', seams: [] }));
  for (const [seam, turns] of Object.entries(seams)) {
    // Named by the EXPORTER's own encoder. Hand-authoring the encoded file name would test this
    // suite's idea of the convention rather than the one the recorder and the replay share.
    writeFileSync(join(d, `${safeSeamFile(seam)}.json`), JSON.stringify(turns));
  }
  return d;
};

beforeEach(() => { dir = ''; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  process.env = { ...ENV };
});

describe('it replays a recorded run', () => {
  it('hands back the recorded turns of a seam, in order', async () => {
    dir = cassette({
      'team-lead-review': [
        { text: 'first', toolCalls: [] },
        { text: 'second', toolCalls: [] },
      ],
    });
    process.env.EPAM_AGENT_NAME = 'team-lead-review';
    delete process.env.EPAM_STORY_ID;

    const p = new ReplayProvider(dir);
    const a = await p.complete(REQ);
    const b = await p.complete(REQ);

    expect(a.content.map((c) => c.text).join('')).toBe('first');
    expect(b.content.map((c) => c.text).join('')).toBe('second');
  });

  it('reconstructs TOOL CALLS, so a recorded writer really writes', async () => {
    // The agent loop is not replayed — it runs for real against the replayed turns. A recorded
    // write_file call therefore puts real content on disk and every gate downstream judges a real
    // artefact. Without this the rehearsal would be a mime of a run: writers producing nothing and
    // every gate failing for reasons the code under test did not cause.
    dir = cassette({
      writer: [{
        text: '',
        toolCalls: [{ name: 'write_file', input: { path: 'a.ts', content: 'export const x = 1;' } }],
      }],
    });
    process.env.EPAM_AGENT_NAME = 'writer';
    delete process.env.EPAM_STORY_ID;

    const res = await new ReplayProvider(dir).complete(REQ);
    const uses = res.content.filter((c) => c.type === 'tool_use');
    expect(uses).toHaveLength(1);
    expect(uses[0].name).toBe('write_file');
    expect(uses[0].input).toEqual({ path: 'a.ts', content: 'export const x = 1;' });
    expect(res.stopReason).toBe('tool_use');
  });

  it('keys on the SAME label Langfuse recorded — agent · story', async () => {
    dir = cassette({ 'code-graph-detective · AMSD-2041': [{ text: 'found it', toolCalls: [] }] });
    process.env.EPAM_AGENT_NAME = 'code-graph-detective';
    process.env.EPAM_STORY_ID = 'AMSD-2041';

    const res = await new ReplayProvider(dir).complete(REQ);
    expect(res.content.map((c) => c.text).join('')).toBe('found it');
  });

  it('reports ZERO tokens and zero cost — nothing was generated', async () => {
    dir = cassette({ seam: [{ text: 'x', toolCalls: [] }] });
    process.env.EPAM_AGENT_NAME = 'seam';
    delete process.env.EPAM_STORY_ID;

    const res = await new ReplayProvider(dir).complete(REQ);
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.outputTokens).toBe(0);
  });
});

describe('divergence is REPORTED, never invented', () => {
  it('a seam the recording never exercised is a hard failure', async () => {
    dir = cassette({ 'some-other-seam': [{ text: 'x', toolCalls: [] }] });
    process.env.EPAM_AGENT_NAME = 'a-seam-that-was-never-recorded';
    delete process.env.EPAM_STORY_ID;

    await expect(new ReplayProvider(dir).complete(REQ))
      .rejects.toThrow(/a-seam-that-was-never-recorded/);
  });

  it('running PAST the end of a seam\'s recording is a hard failure naming the seam', async () => {
    // The pipeline now calls this seam more times than the recorded run did. That is a real
    // difference in behaviour and the whole point of the rehearsal — so it surfaces by name
    // instead of being answered with a repeat of the last turn.
    dir = cassette({ reviewer: [{ text: 'only turn', toolCalls: [] }] });
    process.env.EPAM_AGENT_NAME = 'reviewer';
    delete process.env.EPAM_STORY_ID;

    const p = new ReplayProvider(dir);
    await p.complete(REQ);
    await expect(p.complete(REQ)).rejects.toThrow(/reviewer.*1 turn/s);
  });

  it('an empty recorded turn is REPLAYED, not treated as absent', async () => {
    // A model that returned nothing is a real thing that happened — it is how several of this
    // month's failures looked. Skipping those turns would rehearse a run that never occurred.
    dir = cassette({ seam: [{ text: '', toolCalls: [] }] });
    process.env.EPAM_AGENT_NAME = 'seam';
    delete process.env.EPAM_STORY_ID;

    const res = await new ReplayProvider(dir).complete(REQ);
    expect(res.content.map((c) => c.text).join('')).toBe('');
    expect(res.stopReason).toBe('end_turn');
  });
});

describe('the recorder and the replay cannot drift apart', () => {
  // The seam-name encoding exists in two files by necessity — the exporter is CommonJS in the
  // orchestration layer, the provider is TypeScript in the CLI — and the failure mode if they
  // diverge is silent and expensive: the replay looks up a name the exporter never wrote and
  // reports "this seam was never recorded" about a seam that was recorded perfectly well.
  //
  // The characters checked are the ones the pipeline's own seam names actually contain.
  it('encodes every real seam-name shape identically on both sides', async () => {
    const names = [
      'team-lead-review',
      'qa-gate:sast',
      'code-graph-detective · AMSD-2041',
      'SPEC_AGENT:plan · AMSD-2041',
      'chain call',
      'a/b',
      // LONG ENOUGH TO CROSS THE FILESYSTEM BOUND. The first version of this guard used only
      // short names, so the two encoders drifted a second time — over the truncation rule — and
      // the guard stayed green while doing so.
      `project-roster-review:plan · ${'read_file,list_files,search,codegraph_query,'.repeat(6)}`,
    ];
    for (const n of names) {
      // The provider's encoder is private, so it is exercised the way the pipeline exercises it:
      // a cassette written by the EXPORTER must be readable by the PROVIDER under the same name.
      const d = mkdtempSync(join(tmpdir(), 'drift-'));
      try {
        writeFileSync(join(d, `${safeSeamFile(n)}.json`), JSON.stringify([{ text: n, toolCalls: [] }]));
        writeFileSync(join(d, 'manifest.json'), JSON.stringify({ session: 'TEST' }));
        process.env.EPAM_AGENT_NAME = n;
        delete process.env.EPAM_STORY_ID;
        // Reading it back proves the two encoders agree for this name; a mismatch throws.
        // AWAITED, and asserting the CONTENT: an un-awaited `resolves` is the vacuous shape that
        // let three runtime bugs ship this month — it passes whatever the promise does.
        const res = await new ReplayProvider(d).complete(REQ);
        expect(res.content.map((c) => c.text).join(''), `seam '${n}' did not round-trip`).toBe(n);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

describe('a seam name the pipeline really produced', () => {
  // Trace names come from the running pipeline, so their length is not the cassette's to assume.
  // One real session labelled a seam with an entire tool grant; the export died with ENAMETOOLONG
  // partway through and left a half-written directory that still looked like a cassette.
  const LONG = `project-roster-review:plan · ${
    'read_file,list_files,search,codegraph_query,resolve_test_file,codeline_facts,git_state,'
    + 'check_anti_patterns,resolve_package_symbol,dependency_contract,dependency_available,scan_secrets'}`;

  it('a name far past the filesystem limit still writes and reads back', async () => {
    dir = mkdtempSync(join(tmpdir(), 'long-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ session: 'TEST' }));
    const file = `${safeSeamFile(LONG)}.json`;
    expect(Buffer.byteLength(file), 'the file name would be rejected by the filesystem')
      .toBeLessThanOrEqual(255);
    writeFileSync(join(dir, file), JSON.stringify([{ text: 'recorded', toolCalls: [] }]));

    process.env.EPAM_AGENT_NAME = LONG;
    delete process.env.EPAM_STORY_ID;
    const res = await new ReplayProvider(dir).complete(REQ);
    expect(res.content.map((c) => c.text).join('')).toBe('recorded');
  });

  it('two different long names do NOT collide onto one file', () => {
    // Truncation alone would hand one seam another's recorded answers — silently, and only for
    // the seams whose names happen to share a prefix, which is exactly the hard case to notice.
    const a = safeSeamFile(`${LONG}-alpha`);
    const b = safeSeamFile(`${LONG}-beta`);
    expect(a).not.toBe(b);
  });
});
