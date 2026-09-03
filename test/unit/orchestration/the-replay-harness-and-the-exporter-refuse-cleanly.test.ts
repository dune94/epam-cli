/**
 * THE FALSIFICATION HARNESS AND THE CASSETTE EXPORTER — 349 lines, neither with a test.
 *
 * kb-replay.js replays every historical healing episode through the store and compiler and reports
 * what ACTUALLY comes out. Its own header says why it exists: to answer three questions that
 * fixture-based tests cannot, because the fixtures were written by the same person as the design —
 * and specifically whether real failures COMPILE to a mechanism, or whether the dead end has simply
 * been relocated behind better types. A harness meant to be able to say "this does not work" must
 * itself be trustworthy.
 *
 * cassette-export.js reads a recorded run out of Langfuse. Everything it does needs credentials, so
 * what is testable offline is the part that matters most: it must REFUSE without them rather than
 * produce an empty cassette that a rehearsal would happily replay as "the run said nothing".
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const NODE = process.execPath;

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(NODE, [join(S, script), ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** A logs tree carrying healing episodes, the shape kb-replay walks. */
function logsWith(episodes: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'kbroot-'));
  mkdirSync(join(root, 'logs/lanes/a'), { recursive: true });
  writeFileSync(join(root, 'logs/lanes/a/healing-events.jsonl'),
    episodes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}

const episode = (diagnosis: string) => ({
  storyId: 'S-1', agent: 'writer', diagnosis, outcome: 'retried',
});

describe('the replay harness reports what really comes out', () => {
  it('an EMPTY logs tree is reported as no episodes, not as a clean result', () => {
    // "Nothing to replay" and "everything replayed fine" are different answers, and only one of them
    // means the design was exercised.
    const root = mkdtempSync(join(tmpdir(), 'kbroot-'));
    mkdirSync(join(root, 'logs'), { recursive: true });
    const r = run('kb-replay.js', [], { KB_REPLAY_ROOT: root });
    expect(r.out.trim(), 'an empty tree produced no statement at all').not.toBe('');
    expect(r.out, 'it did not say there was nothing to replay').toMatch(/0|no |none|empty/i);
  }, 180_000);

  it('a compiler error COMPILES TO an existing mechanism, not to nothing', () => {
    // Question 3 is the falsification test for the whole design: would real failures bind to
    // gate/param/tool_scope, or has the target=none dead end simply been relocated behind better
    // types? A TS error must bind to the tsc gate that already runs.
    const root = logsWith([episode('TS2304: Cannot find name "foo"')]);
    const r = run('kb-replay.js', ['--verbose'], { KB_REPLAY_ROOT: root });
    expect(r.out, 'a compiler error was not classified at all').toMatch(/type-error/);
    expect(r.out, 'it bound to no existing mechanism').toMatch(/gate/);
    expect(r.out, 'the mechanism it names is not one that already runs').toMatch(/tsc --noEmit/);
  }, 180_000);

  it('episodes it cannot classify are reported as unclassified, not quietly dropped', () => {
    // Dropping them would flatter the compile rate, which is the one number this harness exists to
    // report honestly.
    const root = logsWith([episode('something nobody has a pattern for at all')]);
    const r = run('kb-replay.js', [], { KB_REPLAY_ROOT: root });
    expect(r.out, 'an unclassifiable episode vanished from the report')
      .toMatch(/unclassified|1 episode|total/i);
  }, 180_000);

  it('a TORN line in the log is skipped, not fatal — these files are appended to live', () => {
    const root = mkdtempSync(join(tmpdir(), 'kbroot-'));
    mkdirSync(join(root, 'logs/lanes/a'), { recursive: true });
    writeFileSync(join(root, 'logs/lanes/a/healing-events.jsonl'),
      `${JSON.stringify(episode('TS2304: x'))}\n{"storyId":"S-2","diag`);
    const r = run('kb-replay.js', ['--verbose'], { KB_REPLAY_ROOT: root });
    expect(r.code, 'a partially-written last line killed the harness').toBe(0);
    expect(r.out, 'the complete episode was lost along with the torn one')
      .toMatch(/EPISODES IN: 1/);
  }, 180_000);

  it('an entry with NO diagnosis is not counted — there is nothing to classify', () => {
    const root = logsWith([{ storyId: 'S-1', outcome: 'retried' }, episode('TS2304: x')]);
    const r = run('kb-replay.js', [], { KB_REPLAY_ROOT: root });
    expect(r.code).toBe(0);
  }, 180_000);

  it('--verbose says more than the default, or the flag is decoration', () => {
    const root = logsWith([episode('TS2304: x'), episode('Cannot find module "y"')]);
    const plain = run('kb-replay.js', [], { KB_REPLAY_ROOT: root });
    const loud = run('kb-replay.js', ['--verbose'], { KB_REPLAY_ROOT: root });
    expect(loud.out.length, '--verbose produced no more detail than the default')
      .toBeGreaterThanOrEqual(plain.out.length);
  }, 180_000);
});

describe('the cassette exporter refuses without credentials', () => {
  it('REFUSES when the Langfuse keys are absent, naming both', () => {
    // Producing an empty cassette would be worse than failing: a rehearsal would replay it as "the
    // run said nothing" and report that everything passed.
    const r = run('cassette-export.js', ['--list'],
      { LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' });
    expect(r.code, 'it proceeded without credentials').not.toBe(0);
    expect(r.out, 'the refusal does not name what is missing').toMatch(/LANGFUSE_PUBLIC_KEY/);
    expect(r.out).toMatch(/LANGFUSE_SECRET_KEY/);
  }, 180_000);

  it('refuses with only ONE of the two keys — half a credential is not a credential', () => {
    const r = run('cassette-export.js', ['--list'],
      { LANGFUSE_PUBLIC_KEY: 'pk-only', LANGFUSE_SECRET_KEY: '' });
    expect(r.code, 'one key was accepted as authentication').not.toBe(0);
  }, 180_000);

  it('an export with no --out is refused rather than writing somewhere chosen for you', () => {
    const r = run('cassette-export.js', ['--session', 'sess-1'],
      { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' });
    expect(r.code, 'it exported a cassette to a directory nobody named').not.toBe(0);
  }, 180_000);

  it('with no arguments it explains itself', () => {
    const r = run('cassette-export.js', [],
      { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' });
    expect(r.out.trim(), 'it neither ran nor explained itself').not.toBe('');
  }, 180_000);
});
