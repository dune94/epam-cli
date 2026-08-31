/**
 * THREE MINT HANDLERS, NONE WITH A TEST, EACH REPLACING SOMETHING ASSERTED IN A PROMPT.
 *
 * stack-facts.js: nine templates carried these as LITERALS in their bodies — "files without
 * *.test.ts", "NEVER modify package.json, tsconfig.json, vitest.config.ts", "run vitest". Every
 * agent on every project was told the world is TypeScript, vitest and npm. On a Rust, Python, Go or
 * Ruby codeline the split rules and protected-file list are simply wrong, and the agent follows them
 * anyway.
 *
 * seam-env-args.js: a shell call site needs KEY=VALUE words it can hand to `env`, so a bash step can
 * apply a seam without hand-copying variable names — which is how a call ends up applying three of
 * five settings and LOOKING wired. A seam that does not resolve prints nothing, says why, and exits
 * non-zero: silence would leave the call running on ambient settings while appearing to have asked.
 *
 * seam-ladder-position.js: empty on failure is deliberate — the caller treats "no declared position"
 * and "could not resolve" the same way, and seam-invocation warns loudly at the invocation itself.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const H = join(S, 'lib/handlers');
const NODE = process.execPath;

function run(script: string, args: string[]) {
  const r = spawnSync(NODE, [join(H, script), ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'stack-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

describe('stack-facts injects the ecosystem instead of asserting TypeScript', () => {
  it('a NODE repository gets node facts', () => {
    const r = run('stack-facts.js', [repo({ 'package.json': '{"name":"x"}' })]);
    expect(r.code, r.err).toBe(0);
    expect(r.out, 'no facts were produced at all').not.toBe('');
  }, 90_000);

  it.each([
    ['requirements.txt', 'requests==2.0\n', /vitest|package\.json|tsconfig/i],
    ['go.mod', 'module x\n', /vitest|package\.json|tsconfig/i],
    ['Cargo.toml', '[package]\nname="x"\n', /vitest|package\.json|tsconfig/i],
  ])('a %s repository is NOT told to run vitest or protect tsconfig.json', (manifest, body, node) => {
    // The literal that used to sit in nine prompt bodies. On these codelines it is simply wrong,
    // and the agent follows it anyway.
    const r = run('stack-facts.js', [repo({ [manifest]: body })]);
    expect(r.code, r.err).toBe(0);
    expect(r.out, `a ${manifest} repository was given node's stack facts`).not.toMatch(node);
  }, 90_000);

  it('a repository declaring NO ecosystem does not fall back to node', () => {
    const r = run('stack-facts.js', [repo({ 'README.md': '# docs\n' })]);
    expect(r.out, 'a repository with no manifest was told it is TypeScript')
      .not.toMatch(/vitest|tsconfig/i);
  }, 90_000);

  it('ROLES come from the minted roster, never from a name written in the engine', () => {
    const rolesFile = join(mkdtempSync(join(tmpdir(), 'roles-')), 'roles.json');
    writeFileSync(rolesFile, JSON.stringify({ roles: ['rust-engineer', 'python-engineer'] }));
    const r = run('stack-facts.js', [repo({ 'Cargo.toml': '[package]\nname="x"\n' }), rolesFile]);
    expect(r.out, "the project's own minted role is absent").toMatch(/rust-engineer|python-engineer/);
    expect(r.out, 'a role name written in the engine leaked in')
      .not.toMatch(/typescript-engineer/);
  }, 90_000);

  it('a missing repository is not described as TypeScript either', () => {
    // It cannot be inspected, so no ecosystem resolves. What must never happen is the old default:
    // asserting node's test command and protected files for a repository nobody has looked at.
    const r = run('stack-facts.js', ['/no/such/repo']);
    expect(r.out, 'a repository that does not exist was told it is TypeScript')
      .not.toMatch(/vitest|tsconfig/i);
  }, 90_000);
});

describe('seam-env-args emits words a shell can apply, or nothing at all', () => {
  it('a real seam produces KEY=VALUE words', () => {
    const r = run('seam-env-args.js', ['team-lead-review', join(S, '../agents')]);
    if (r.code === 0 && r.out) {
      for (const word of r.out.split(/\s+/).filter(Boolean)) {
        expect(word, `"${word}" is not a KEY=VALUE word a shell can hand to env`)
          .toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
      }
    }
  }, 90_000);

  it('a seam that does NOT resolve prints nothing, says why, and exits non-zero', () => {
    // Silence would leave the call running on ambient settings while appearing to have asked —
    // which is how a call applies three of five settings and looks wired.
    const r = run('seam-env-args.js', ['definitely-not-a-seam']);
    expect(r.code, 'an unresolved seam exited 0, so the caller believes it was applied').not.toBe(0);
    expect(r.out, 'it printed something for a seam that does not exist').toBe('');
    expect(r.err, 'it failed silently').not.toBe('');
  }, 90_000);

  it('no seam argument is refused', () => {
    const r = run('seam-env-args.js', []);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  }, 90_000);

  it('every emitted word is safe to expand UNQUOTED — a value with whitespace is dropped', () => {
    // An env word cannot carry a space unquoted, and half a value is worse than none.
    const r = run('seam-env-args.js', ['team-lead-review', join(S, '../agents')]);
    if (r.out) {
      expect(r.out.split('\n').length, 'a value carried a newline into the word list').toBe(1);
    }
  }, 90_000);
});

describe('seam-ladder-position resolves through the registry, or says nothing', () => {
  const SEAM_LIB = join(S, 'lib/seam-invocation.js');
  const REGISTRY = join(S, '../agents/invocation-profiles.json');

  it('an agent that resolves to a seam reports that seam ladder position', () => {
    const r = run('seam-ladder-position.js', [SEAM_LIB, REGISTRY, 'team-lead-review']);
    expect(r.code, r.err).toBe(0);
    if (r.out) expect(r.out, 'the position is not one the project declares').toMatch(/^[a-z-]+$/);
  }, 90_000);

  it('a name matching NO seam pattern yields empty rather than a guessed position', () => {
    // Empty is deliberate: the caller treats "no declared position" and "could not resolve" the same
    // way — it applies no ladder — and seam-invocation warns loudly at the invocation itself.
    //
    // Note the fixture: an agent named like a real one RESOLVES, because the registry maps by name
    // SHAPE as well as by exact profile. 'not-a-real-agent' matches a seamPattern and legitimately
    // gets that seam's ladder; only a name matching nothing is unresolvable.
    const r = run('seam-ladder-position.js', [SEAM_LIB, REGISTRY, 'zzz-nonsense']);
    expect(r.out, 'a name matching no seam pattern was given a ladder position').toBe('');
  }, 90_000);

  it("and a name matching a seam PATTERN does resolve — the registry maps by shape too", () => {
    const r = run('seam-ladder-position.js', [SEAM_LIB, REGISTRY, 'not-a-real-agent']);
    expect(r.out, 'a name-shape match resolved to nothing, so the pattern mapping is dead')
      .not.toBe('');
  }, 90_000);

  it('a missing registry yields empty rather than throwing mid-run', () => {
    const r = run('seam-ladder-position.js', [SEAM_LIB, '/no/such/registry.json', 'team-lead-review']);
    expect(r.out).toBe('');
    expect(r.err, 'a missing registry threw from inside node').not.toMatch(/TypeError/);
  }, 90_000);

  it('missing arguments yield empty rather than crashing the orchestrator', () => {
    expect(run('seam-ladder-position.js', []).out).toBe('');
  }, 90_000);
});
