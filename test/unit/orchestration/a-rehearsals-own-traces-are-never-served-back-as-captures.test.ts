/**
 * A REHEARSAL'S OWN TRACES ARE NEVER SERVED BACK AS CAPTURES.
 *
 * The mock loader takes a seam's reply from Langfuse when a run recorded one. A rehearsal on the
 * mockserver set is itself recorded — the cost seam writes an attempt trace for every call — so
 * the stand-in the loader invented for roster-specialiser on one launch was found as a "recorded"
 * reply on the next and served back: {"note":"stand-in artefact for roster-specialiser"}, three
 * launches running, the roster stage failing on its own echo (2026-09-13). The generation
 * observation carried model "replay" and was already skipped; the attempt trace carried no model
 * and was not.
 *
 * Two declarations: the mockserver set says it is a rehearsal and the recorder stamps every trace
 * of one (lib/langfuse-emit.js rehearsal:true); the loader skips stamped traces, and — for traces
 * recorded before the stamp existed — skips any body that is a stand-in of its own making.
 * Executed: the recorder under each set, and langfuseReply over a stub Langfuse.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';

const ROOT = join(__dirname, '../../../');
const CONFIG = join(ROOT, 'orchestrations/config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const emit = require(join(ROOT, 'orchestrations/scripts/lib/langfuse-emit.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loader = require(join(ROOT, 'orchestrations/scripts/mock-expectations.js'));

const setsDeclaringRehearsal = readdirSync(CONFIG).filter((f) => /^llm-defaults\..*\.json$/.test(f))
  .filter((f) => JSON.parse(readFileSync(join(CONFIG, f), 'utf8')).rehearsal === true)
  .map((f) => f.replace(/^llm-defaults\.(.*)\.json$/, '$1'));
const setsNot = readdirSync(CONFIG).filter((f) => /^llm-defaults\..*\.json$/.test(f))
  .filter((f) => JSON.parse(readFileSync(join(CONFIG, f), 'utf8')).rehearsal !== true)
  .map((f) => f.replace(/^llm-defaults\.(.*)\.json$/, '$1'));

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
const traceMeta = (f: any) => {
  const b = emit.buildIngestionBody(f, { traceId: 't1' });
  return (b.batch || []).find((e: any) => e.type === 'trace-create').body.metadata;
};

describe('the recorder stamps a rehearsal\'s traces', () => {
  it('a set that declares itself a rehearsal exists — otherwise this proves nothing', () => {
    expect(setsDeclaringRehearsal.length).toBeGreaterThan(0);
    expect(setsNot.length).toBeGreaterThan(0);
  });
  it.each(setsDeclaringRehearsal)('on the %s set every attempt trace carries rehearsal:true', (set) => {
    expect(withEnv({ EPAM_PROVIDER_SET: set, EPAM_REPLAY_CASSETTE_DIR: undefined }, () => traceMeta({ agent: 'x', model: 'm' })).rehearsal).toBe(true);
  });
  it.each(setsNot)('on the %s set it does not', (set) => {
    expect(withEnv({ EPAM_PROVIDER_SET: set, EPAM_REPLAY_CASSETTE_DIR: undefined }, () => traceMeta({ agent: 'x', model: 'm' })).rehearsal).toBeUndefined();
  });
  it('a cassette replay is a rehearsal on any set', () => {
    expect(withEnv({ EPAM_PROVIDER_SET: setsNot[0], EPAM_REPLAY_CASSETTE_DIR: '/some/cassette' }, () => traceMeta({ agent: 'x', model: 'm' })).rehearsal).toBe(true);
  });
});

describe('the loader never serves a rehearsal\'s echo', () => {
  let server: Server; let port = 0;
  const trace = (id: string, name: string, output: string, meta: any = {}) => ({ id, name, sessionId: 's', metadata: meta, timestamp: '2026-09-13T00:00:00Z',
    observations: [{ id: `${id}-o`, model: 'some-model', output, metadata: {} }] });
  const TRACES = [
    trace('t-echo', 'seam-x', '{"note":"stand-in artefact for seam-x"}', { rehearsal: true }),
    trace('t-old-echo', 'seam-x', '{"note":"stand-in artefact for seam-x"}', {}),
    trace('t-real', 'seam-y', '{"agents":{"alpha":{"persona":"real"}}}', {}),
  ];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname === '/api/public/traces') {
        const name = url.searchParams.get('name');
        res.end(JSON.stringify({ data: TRACES.filter((t) => t.name === name).map(({ observations, ...t }) => t) })); return;
      }
      const m = url.pathname.match(/^\/api\/public\/traces\/(.+)$/);
      if (m) { res.end(JSON.stringify(TRACES.find((t) => t.id === decodeURIComponent(m[1])) || {})); return; }
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as any).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const ask = (seam: string) => withEnv({ LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }, () => loader.langfuseReply(seam));

  it('a stamped rehearsal trace and an unstamped stand-in echo are both skipped — the seam has no capture', async () => {
    expect(await ask('seam-x')).toBeNull();
  });
  it('a real capture is still served', async () => {
    const r = await ask('seam-y');
    expect(r).toBeTruthy();
    expect(r.body).toContain('"persona":"real"');
  });
  it('the stand-in tell recognises what this loader invents', () => {
    expect(loader.isStandInBody('{"note":"stand-in artefact for roster-specialiser"}')).toBe(true);
    expect(loader.isStandInBody('stand-in reply for the agent-mint seam, long enough to satisfy the contract')).toBe(true);
    expect(loader.isStandInBody('{"agents":{}}')).toBe(false);
  });
});
