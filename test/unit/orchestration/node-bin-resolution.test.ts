/**
 * WHICH NODE TO RUN IS DISCOVERABLE, NOT A PATH SOMEONE TYPED.
 *
 * Ten sites carried `/home/<user>/.nvm/versions/node/v20.20.0/bin/node` — valid on one
 * machine, for one nvm install, until that version is upgraded. The requirement is already
 * declared in package.json (`engines.node: ">=20.0.0"`), and the interpreter is findable.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/node-bin.sh');
const REPO = join(__dirname, '../../../');

function resolve(env: Record<string, string>, repoRoot = REPO) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; resolve_node_bin ${JSON.stringify(repoRoot)}`], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return { out: (r.stdout || '').trim(), err: r.stderr || '', status: r.status };
}

describe('the node interpreter is resolved, never written down', () => {
  it('resolves to a real, runnable node', () => {
    const r = resolve({});
    expect(r.out, `no interpreter resolved:\n${r.err}`).toBeTruthy();
    const v = spawnSync(r.out, ['-p', 'process.versions.node'], { encoding: 'utf8' });
    expect(v.status, `resolved path is not runnable: ${r.out}`).toBe(0);
  });

  it('satisfies the requirement package.json declares', () => {
    const min = Number(
      /(\d+)/.exec(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).engines?.node ?? '')?.[1] ?? 0,
    );
    const r = resolve({});
    const major = Number(
      spawnSync(r.out, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim(),
    );
    expect(major).toBeGreaterThanOrEqual(min);
  });

  it('EPAM_NODE_BIN wins — configuration is always honoured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodebin-'));
    const fake = join(dir, 'my-node');
    writeFileSync(fake, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(fake, 0o755);
    expect(resolve({ EPAM_NODE_BIN: fake }).out).toBe(fake);
  });

  it('finds an nvm-managed node when PATH node is too old, without naming a user or version', () => {
    // A fake NVM_DIR with two versions; the newest satisfying one must win.
    const dir = mkdtempSync(join(tmpdir(), 'nvm-'));
    for (const v of ['v18.1.0', 'v22.4.0']) {
      const bin = join(dir, 'versions/node', v, 'bin');
      mkdirSync(bin, { recursive: true });
      const node = join(bin, 'node');
      // Behave like `node -p 'process.versions.node.split(".")[0]'` — the MAJOR only.
      writeFileSync(node, `#!/usr/bin/env bash\necho "${v.slice(1).split('.')[0]}"\n`);
      chmodSync(node, 0o755);
    }
    // A PATH with coreutils but no node — emptying PATH entirely would break `ls`/`sort`
    // and test nothing but my own harness.
    const noNode = mkdtempSync(join(tmpdir(), 'nonode-'));
    const r = resolve({ NVM_DIR: dir, PATH: `${noNode}:/usr/bin:/bin` });
    expect(r.out, `nothing resolved:\n${r.err}`).toContain('v22.4.0');
  });

  it('warns rather than silently returning something too old', () => {
    // A repo declaring an impossible requirement: nothing can satisfy it, so the resolver
    // must SAY so and still return a usable interpreter rather than an empty string.
    const fakeRepo = mkdtempSync(join(tmpdir(), 'repo-'));
    writeFileSync(join(fakeRepo, 'package.json'), JSON.stringify({ engines: { node: '>=999.0.0' } }));
    const r = resolve({ NVM_DIR: '/nonexistent-nvm' }, fakeRepo);
    expect(r.err, `expected a warning naming the override. stderr:\n${r.err}`).toMatch(/EPAM_NODE_BIN/);
    expect(r.out, 'must still return a usable interpreter, not nothing').toBeTruthy();
  });
});

describe('no pipeline file pins an interpreter path', () => {
  it('the audit reports zero absolute machine paths', () => {
    const audit = join(__dirname, '../../../orchestrations/scripts/hardcoding-audit.sh');
    const r = spawnSync('bash', [audit, '--verify', '1'], { encoding: 'utf8', timeout: 60000 });
    const hits = (r.stdout || '').split('\n').filter((l) => /^(orchestrations|src)\/.*:\d+:/.test(l.trim()));
    expect(hits, `absolute machine paths remain:\n${hits.join('\n')}`).toEqual([]);
  });
});
