/**
 * AGENT KNOWLEDGE IS KEYED ON SOMETHING THAT SURVIVES THE RUN.
 *
 * KB-<role>.md persisted across the per-run reset by design — but the roster is ephemeral and
 * the mint invents a NEW role name each run for essentially the same agent. So the address
 * changed every run: 32 KB files accumulated, each holding what one run learned, none reachable
 * by any later run. The store persisted; the key did not.
 *
 * A codeline is stable, discovered rather than invented, already the investigator key, and the
 * subject of most durable learning — where the SDK is initialised here, how this repository
 * names its tests.
 *
 * And the roster is SET after the mint. Self-heal used to append into profiles.json, claiming
 * "future runs inherit this learning" while pre-run-reset restored that file from its original
 * at the start of every run. Two writers, one of them an unlocked read-modify-write, on a file
 * three parallel lanes read.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Execute the REAL resolver, extracted from claude.sh. */
function resolve(opts: { storyCodeline?: string; laneEnv?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'kbkey-')); dirs.push(dir);
  const agents = join(dir, 'agents'); mkdirSync(agents, { recursive: true });
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{ id: 'S-1', ...(opts.storyCodeline ? { codeline: opts.storyCodeline } : {}) }],
  }));

  const start = SRC.indexOf('_kb_file_for_story() {');
  const end = SRC.indexOf('\n}', start) + 2;
  expect(start, 'the KB resolver is gone from claude.sh').toBeGreaterThan(-1);
  const fn = SRC.slice(start, end);

  const script =
    `set +e\n` +
    (opts.laneEnv ? `export EPAM_CODELINE=${JSON.stringify(opts.laneEnv)}\n` : '') +
    `MAIN_PRD_FILE=${JSON.stringify(prd)}\n${fn}\n` +
    `_kb_file_for_story "S-1" ${JSON.stringify(agents)}\n`;
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return (res.stdout || '').trim().split('/').pop() || '';
}

describe('the KB file is named for the codeline', () => {
  it('a story in a lane resolves that lane KB', () => {
    expect(resolve({ storyCodeline: 'alpha' })).toBe('KB-alpha.md');
  });

  it('the lane environment wins — it cannot be stale', () => {
    expect(resolve({ storyCodeline: 'alpha', laneEnv: 'beta' })).toBe('KB-beta.md');
  });

  it('two lanes of one spanning story get DIFFERENT KB files', () => {
    expect(resolve({ laneEnv: 'alpha' })).not.toBe(resolve({ laneEnv: 'beta' }));
  });

  it('with no codeline at all it falls back to the shared KB, not a role name', () => {
    expect(resolve({})).toBe('KB-shared.md');
  });

  it('THE DEFECT: the key is never an agent role', () => {
    const name = resolve({ storyCodeline: 'alpha' });
    expect(
      name,
      'the key is regenerated every run, so nothing written under it is ever read again',
    ).not.toMatch(/engineer|specialist|investigator/);
  });
});

describe('nothing writes the roster after the mint', () => {
  it('claude.sh contains no writer to profiles.json', () => {
    expect(
      SRC.match(/mv\s+"\$_?\w*tmp_profiles"\s+"\$AGENT_PROFILES_FILE"/),
      'the unlocked read-modify-write on the roster is back',
    ).toBeNull();
    expect(
      SRC.match(/json\.dump\(profiles/),
      'the roster is being rewritten again — three parallel lanes read that file',
    ).toBeNull();
  });

  it('the skill target appends to a KB file instead', () => {
    expect(SRC).toMatch(/_skill_kb_file=\$\(_kb_file_for_story/);
    expect(SRC).toMatch(/survives into later runs/);
  });

  it('the syntax-escalation path does too, under a lock', () => {
    expect(SRC).toMatch(/_sx_kb_file=\$\(_kb_file_for_story/);
    const i = SRC.indexOf('_sx_kb_file=$(_kb_file_for_story');
    expect(SRC.slice(i, i + 700), 'the second writer is unguarded again').toMatch(/flock/);
  });

  it('both suppress duplicates before appending', () => {
    for (const v of ['_skill_kb_file', '_sx_kb_file']) {
      const i = SRC.indexOf(`${v}=$(_kb_file_for_story`);
      expect(SRC.slice(i, i + 500), `${v} appends duplicates`).toMatch(/grep -qF/);
    }
  });
});
