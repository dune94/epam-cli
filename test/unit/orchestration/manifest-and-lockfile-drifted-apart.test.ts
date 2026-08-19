// THE DEPENDENCY WAS ADDED TO THE MANIFEST AND TO NOTHING ELSE.
//
// Live metrolinx AMSD-2041, approved commit af1d6b99 (2026-08-19). package.json gained
// "@contentstack/live-preview-utils": "^3.4.0" and package-lock.json — tracked, not ignored, and
// clean in the worktree — was never touched. The package is absent from the lockfile entirely.
//
// tsc, ESLint and the build all passed, and the reviewer APPROVED, because
// node_modules/@contentstack/live-preview-utils was installed on 2026-08-14 by an EARLIER run and
// survived the codeline reset. `npm install` appears zero times in the run log. So every piece of
// verification the pipeline owns was run against a tree no commit describes; `npm ci` on this
// branch fails outright.
//
// The manifest-vs-lockfile question is a file comparison, not a judgement, so it belongs in the
// deterministic class alongside repo-lint (2b4f67e) and the dependency scan (90fbf7f), and must
// reach the writer through the same three-part contract.
//
// IT MUST NOT BLOCK ON DRIFT THE STORY DID NOT CAUSE. That is the lesson of 665f1a5: a repository
// carrying pre-existing desync is debt, not this change's defect, and hard-stopping on it burns
// the story budget in a loop no writer output can exit.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

type Repo = { manifest: string; manifestBody: string; lock?: string; lockBody?: string };

function makeRepo(r: Repo): string {
  const repo = mkdtempSync(join(tmpdir(), 'lock-sync-'));
  made.push(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 't']);
  writeFileSync(join(repo, r.manifest), r.manifestBody);
  if (r.lock) writeFileSync(join(repo, r.lock), r.lockBody || '');
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  return repo;
}

/** Execute the REAL run_lockfile_sync_check and report the three delivery conditions. */
function runGate(repo: string, introduced: string) {
  const script = `
set +e
error() { echo "ERROR $*" >&2; }
warning() { echo "WARN $*" >&2; }
info() { echo "INFO $*" >&2; }
log() { echo "LOG $*" >&2; }
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"
NODE_CMD="${NODE}"
DETERMINISTIC_CHECK_FAILURE=0
VERIFICATION_FAILURE=""
STORY_REJECTION_KEY=""
export EPAM_STORY_INTRODUCED_DEPS=${JSON.stringify(introduced)}

_fn=$(awk '/^run_lockfile_sync_check\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")
if [ -z "$_fn" ]; then echo "RC=99"; echo "NOFUNC"; exit 0; fi
eval "$_fn"

run_lockfile_sync_check "${repo}"
_rc=$?
echo "RC=\${_rc}"
echo "FLAG=\${DETERMINISTIC_CHECK_FAILURE}"
echo "KEY=\${STORY_REJECTION_KEY}"
echo "TEXT<<EOT"; echo "\${VERIFICATION_FAILURE}"; echo "EOT"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = (r.stdout || '') + '\n';
  const grab = (k: string) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [, ''])[1];
  const text = (out.match(/^TEXT<<EOT\n([\s\S]*?)\nEOT$/m) || [, ''])[1];
  return { rc: grab('RC'), flag: grab('FLAG'), key: grab('KEY'), text, stderr: r.stderr || '' };
}

const NODE_MANIFEST = (extra = false) => JSON.stringify({
  name: 'fixture',
  dependencies: { react: '^18.0.0', ...(extra ? { '@scope/added-now': '^3.4.0' } : {}) },
}, null, 2);

/** A v2 npm lockfile that resolves react and nothing else. */
const NODE_LOCK = JSON.stringify({
  name: 'fixture', lockfileVersion: 2,
  packages: { '': { dependencies: { react: '^18.0.0' } }, 'node_modules/react': { version: '18.0.0' } },
  dependencies: { react: { version: '18.0.0' } },
}, null, 2);

describe('a dependency this story added, absent from the lockfile', () => {
  const repo = () => makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(true),
                                lock: 'package-lock.json', lockBody: NODE_LOCK });

  it('is not a silent pass — the gate returns non-zero', () => {
    expect(runGate(repo(), '@scope/added-now').rc).toBe('1');
  });

  it('sets DETERMINISTIC_CHECK_FAILURE so the text is routed into the retry prompt', () => {
    expect(runGate(repo(), '@scope/added-now').flag).toBe('1');
  });

  it('names the package in VERIFICATION_FAILURE', () => {
    const g = runGate(repo(), '@scope/added-now');
    expect(g.text).toContain('@scope/added-now');
    expect(g.text).toContain('package-lock.json');
  });

  it('sets a STORY_REJECTION_KEY the ladder can count repeats on', () => {
    expect(runGate(repo(), '@scope/added-now').key).toContain('@scope/added-now');
  });

  it('tells the writer to install rather than to hand-edit the lockfile', () => {
    expect(runGate(repo(), '@scope/added-now').text.toLowerCase()).toMatch(/install/);
  });
});

describe('drift the story did not cause', () => {
  it('is advisory — a manifest dep missing from the lock, not introduced here, does not block', () => {
    const repo = makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(true),
                            lock: 'package-lock.json', lockBody: NODE_LOCK });
    const g = runGate(repo, ''); // this story introduced nothing
    expect(g.rc, 'pre-existing lockfile debt hard-stopped the story').toBe('0');
    expect(g.flag).toBe('0');
  });

  it('is still reported, so it is contained rather than hidden', () => {
    const repo = makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(true),
                            lock: 'package-lock.json', lockBody: NODE_LOCK });
    expect(runGate(repo, '').stderr).toContain('@scope/added-now');
  });
});

describe('the cases with nothing to prove', () => {
  it('an in-sync manifest passes', () => {
    const repo = makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(false),
                            lock: 'package-lock.json', lockBody: NODE_LOCK });
    expect(runGate(repo, 'react').rc).toBe('0');
  });

  it('a repository carrying NO lockfile cannot be judged and must not be failed', () => {
    const repo = makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(true) });
    const g = runGate(repo, '@scope/added-now');
    expect(g.rc).toBe('0');
    expect(g.stderr.toLowerCase(), 'absence of a lockfile was reported as a pass')
      .toMatch(/no lockfile|cannot/);
  });
});

describe('a lockfile format this engine does not parse', () => {
  // yarn and pnpm lockfiles are not JSON. Guessing at them would mean reporting every dependency
  // as unresolved and hard-stopping a codeline the engine simply cannot read — so the ecosystem
  // answers null, and null must travel all the way out as "cannot prove".
  it('is unprovable, never a list of missing packages', () => {
    const repo = makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(true),
                            lock: 'yarn.lock', lockBody: '# yarn lockfile v1\n\nreact@^18.0.0:\n  version "18.0.0"\n' });
    const g = runGate(repo, '@scope/added-now');
    expect(g.rc, 'a lockfile the engine cannot read hard-stopped the story').toBe('0');
    expect(g.flag).toBe('0');
    expect(g.stderr.toLowerCase()).toMatch(/cannot/);
  });

  it('says so out loud rather than passing quietly', () => {
    const repo = makeRepo({ manifest: 'package.json', manifestBody: NODE_MANIFEST(true),
                            lock: 'yarn.lock', lockBody: '# yarn lockfile v1\n' });
    expect(runGate(repo, '@scope/added-now').stderr).toContain('yarn.lock');
  });
});

describe('it is not a Node gate', () => {
  it('judges a Rust codeline through the same table', () => {
    const repo = makeRepo({
      manifest: 'Cargo.toml',
      manifestBody: '[package]\nname = "fixture"\n\n[dependencies]\nserde = "1.0"\nregex = "1.10"\n',
      lock: 'Cargo.lock',
      lockBody: '[[package]]\nname = "serde"\nversion = "1.0.0"\n',
    });
    const g = runGate(repo, 'regex');
    expect(g.rc, 'a Cargo.lock missing a crate the story added was not caught').toBe('1');
    expect(g.text).toContain('regex');
    expect(g.text).toContain('Cargo.lock');
  });
});

describe('replayed against the real metrolinx branch', () => {
  const REPO = '/home/bradleyjerome/projects/metrolinx/next.metrolinx.com';
  const have = existsSync(join(REPO, '.git'));

  it.runIf(have)('the real approved commit is caught by this gate', () => {
    const work = mkdtempSync(join(tmpdir(), 'lock-real-'));
    made.push(work);
    // The REAL manifest and lockfile from the approved commit, extracted from git.
    for (const [f, src] of [['package.json', 'amsd-2041-approved-af1d6b99:package.json'],
                            ['package-lock.json', 'amsd-2041-approved-af1d6b99:package-lock.json']]) {
      const r = spawnSync('git', ['-C', REPO, 'show', src], { encoding: 'utf8', maxBuffer: 1 << 28 });
      writeFileSync(join(work, f), r.stdout);
    }
    spawnSync('git', ['init', '-q', work]);
    const g = runGate(work, '@contentstack/live-preview-utils');
    expect(g.rc, 'the real desync that shipped would still ship').toBe('1');
    expect(g.text).toContain('@contentstack/live-preview-utils');
  });
});
