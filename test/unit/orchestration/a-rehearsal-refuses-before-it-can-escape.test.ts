/**
 * THE REHEARSAL SANDBOX — 80 lines, no test, and every refusal in it is a safety boundary.
 *
 * A replay hands back what a recorded run said, and the agent loop executes those turns FOR REAL: a
 * recorded bash call really runs, a recorded write really writes. That fidelity is the point — the
 * gates downstream judge real artefacts — and it is also the hazard. Its own header: one recorded
 * session carries 216 bash calls, 131 of them writes, at ABSOLUTE paths inside working trees.
 *
 * So every refusal here is the difference between a discarded overlay and a rehearsal writing into
 * real repositories:
 *
 *   NO CASSETTE   there is nothing to replay, and the run would call a paid provider
 *   NOT A CASSETTE  a directory without a manifest cannot say what it will touch
 *   NO ROOTS      the rehearsal cannot be isolated, so it must not start
 *
 * The roots are never listed in the script: a list there would be a guess about one machine's layout
 * and would under-cover silently the moment a project moved.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/rehearse.sh');

function rehearse(args: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_COVERAGE_GATED: '0' },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const cassette = (manifest?: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'cass-'));
  if (manifest !== undefined) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
};

describe('a rehearsal refuses before it can touch a real tree', () => {
  it('WITHOUT a cassette it refuses, and says the run would otherwise be paid', () => {
    // The consequence is the point: an operator who reads "required" types a flag; one who reads
    // "would call a paid provider" understands why the flag exists.
    const r = rehearse(['--', 'true']);
    expect(r.code, 'it rehearsed with nothing to replay').not.toBe(0);
    expect(r.out, 'the refusal does not explain the consequence').toMatch(/paid provider/i);
  }, 180_000);

  it('a cassette path that does not exist is refused, naming it', () => {
    const r = rehearse(['--cassette', '/no/such/cassette', '--', 'true']);
    expect(r.code).not.toBe(0);
    expect(r.out, 'the refusal does not name the path it looked for').toContain('/no/such/cassette');
  }, 180_000);

  it('a directory with NO MANIFEST is not a cassette, and is refused as such', () => {
    // Without a manifest it cannot say which trees it will touch, so it cannot be isolated — and a
    // rehearsal that cannot be isolated writes into real repositories.
    const r = rehearse(['--cassette', cassette(), '--', 'true']);
    expect(r.code, 'a directory with no manifest was rehearsed').not.toBe(0);
    expect(r.out, 'the refusal does not say what makes it not a cassette').toMatch(/manifest/i);
  }, 180_000);

  it('a manifest declaring NO ROOTS is refused — the rehearsal cannot be isolated', () => {
    const r = rehearse(['--cassette', cassette({ session: 's', roots: [] }), '--', 'true']);
    expect(r.code, 'a rehearsal ran with nothing isolated').not.toBe(0);
    expect(r.out, 'the refusal does not say the rehearsal cannot be isolated')
      .toMatch(/cannot be isolated|no roots/i);
    expect(r.out, 'it does not say how to fix it').toMatch(/re-export|exporter/i);
  }, 180_000);

  it('and a manifest with no roots FIELD is treated the same as an empty one', () => {
    const r = rehearse(['--cassette', cassette({ session: 's' }), '--', 'true']);
    expect(r.code, 'a manifest missing its roots field was rehearsed anyway').not.toBe(0);
  }, 180_000);

  it('an unknown option is refused rather than silently ignored', () => {
    // A mis-typed --keep would discard the overlay an operator meant to inspect.
    const r = rehearse(['--cassette', cassette({ roots: ['/tmp'] }), '--not-a-flag', '--', 'true']);
    expect(r.code, 'an unknown option was accepted').not.toBe(0);
    expect(r.out).toMatch(/unknown option/i);
  }, 180_000);

  it('--help explains itself and exits cleanly', () => {
    const r = rehearse(['--help']);
    expect(r.code).toBe(0);
    expect(r.out, 'the help does not mention the cassette it requires').toMatch(/--cassette/);
  }, 180_000);

  it('the script names no tree of its own — the manifest decides what is isolated', () => {
    // A list here would be a guess about one machine's layout, and would under-cover silently the
    // moment a project moved.
    const src = readFileSync(SCRIPT, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(src, 'a hard-coded tree appears in the rehearsal sandbox')
      .not.toMatch(/\/home\/[a-z]+\/|metrolinx|gotransit/i);
  });
});
