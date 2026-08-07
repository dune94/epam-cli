/**
 * AN AGENT THAT MAY NOT WRITE MUST NOT REACH THE WRITER SEAM.
 *
 * Capability comes from the seam: anything running at implement_story holds write_file and
 * bash. That is correct for an agent whose job is to author code — so the boundary that
 * matters is WHICH agent gets there.
 *
 * Until now that was guarded in exactly one place: assignment offering only registered
 * implementers. perimeter_role_may_write existed, was tested, and was called by nothing in
 * production. Single-layer protection was thin when the roster was hand-curated; it is thinner
 * now that the roster is GENERATED and includes read-only investigators. A hand-edited PRD at
 * the roster pause, a resume carrying a stale assignment, or any future path that bypasses
 * candidateRoles would put an investigator at the writer seam with full writer tools — and
 * nothing would object, because the chmod perimeter decides by branch and worktree, never by
 * who.
 *
 * This asserts the guard by EXECUTING it, with the real function extracted from claude.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const PERIM = join(__dirname, '../../../orchestrations/scripts/lib/codeline-write-perimeter.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real guard block, lifted verbatim from implement_story. */
function guardBlock(): string {
  const start = CLAUDE.indexOf('    # WHO MAY AUTHOR CODE');
  // Anchor on the LINE, not the substring: '    fi' also matches inside the nested
  // '        fi', which cut the block mid-if and produced unparseable bash.
  const end = CLAUDE.indexOf('\n    fi', CLAUDE.indexOf('Refusing to run the writer'));
  expect(start, 'the writer-seam guard is gone from claude.sh').toBeGreaterThan(-1);
  expect(end, 'the guard block is not closed as expected').toBeGreaterThan(start);
  return CLAUDE.slice(start, end + '\n    fi'.length);
}

function runGuard(role: string, opts: { implementers: string[]; investigators: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'writerseam-')); dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', agentRole: role }] }));
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(
    Object.fromEntries([...opts.implementers, ...opts.investigators].map(n => [n, 'brief']))));
  writeFileSync(join(dir, 'project-roles.json'), JSON.stringify({ roles: opts.implementers }));
  writeFileSync(join(dir, 'project-investigators.json'), JSON.stringify({ investigators: opts.investigators }));

  const script =
    `set +e\n` +
    `error() { echo "ERR: $*"; }\n` +
    `export AGENT_PROFILES_FILE=${JSON.stringify(join(dir, 'profiles.json'))}\n` +
    `MAIN_PRD_FILE=${JSON.stringify(prd)}\n` +
    `source ${JSON.stringify(PERIM)} >/dev/null 2>&1\n` +
    `implement_story() {\n  local story_id=$1\n` + guardBlock() + `\n  echo "WRITER_RAN"\n}\n` +
    `implement_story S-1; echo "RC=$?"\n`;
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return (res.stdout || '') + (res.stderr || '');
}

const IMPL = ['an-engineer'];
const INV = ['a-codeline-detective'];

describe('the harness is real', () => {
  it('a registered implementer reaches the writer', () => {
    const out = runGuard('an-engineer', { implementers: IMPL, investigators: INV });
    expect(out, `guard blocked a legitimate implementer:\n${out}`).toMatch(/WRITER_RAN/);
    expect(out).toMatch(/RC=0/);
  });
});

describe('the writer seam refuses agents that may not write', () => {
  it('THE GAP: an investigator is refused', () => {
    const out = runGuard('a-codeline-detective', { implementers: IMPL, investigators: INV });
    expect(
      out,
      'a read-only investigator reached the writer seam, where it holds write_file and bash',
    ).not.toMatch(/WRITER_RAN/);
    expect(out).toMatch(/RC=1/);
  });

  it('it says WHY, naming the role', () => {
    const out = runGuard('a-codeline-detective', { implementers: IMPL, investigators: INV });
    expect(out).toMatch(/a-codeline-detective/);
    expect(out).toMatch(/not permitted to author code/i);
  });

  it('a role in no registry at all is refused', () => {
    const out = runGuard('never-registered', { implementers: IMPL, investigators: INV });
    expect(out).not.toMatch(/WRITER_RAN/);
  });

  it('an authoring seam name still passes — the pipeline stages are unaffected', () => {
    const out = runGuard('writer', { implementers: IMPL, investigators: INV });
    expect(out).toMatch(/WRITER_RAN/);
  });
});

describe('it does not break the unassigned case', () => {
  it('an empty role does not trip the guard here — the phase guard owns that', () => {
    const out = runGuard('', { implementers: IMPL, investigators: INV });
    expect(out).toMatch(/WRITER_RAN/);
  });
});
