import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * npm-package/sync-install-sh.sh is the ONE place install.sh is copied into the npm package.
 * SINGLE POINT OF MAINTENANCE: orchestrations-installer/install.sh is the source of truth; this
 * test proves the copy is byte-identical (md5) and executable, never a hand-edited fork that can
 * drift the moment either file changes without the other.
 */
const REPO = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO, 'npm-package/sync-install-sh.sh');
const SRC = path.join(REPO, 'orchestrations-installer/install.sh');
const DEST = path.join(REPO, 'npm-package/amsd-pipeline/install.sh');

const md5 = (p: string) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

afterEach(() => {
  if (fs.existsSync(DEST)) fs.rmSync(DEST);
});

describe('npm-package/sync-install-sh.sh', () => {
  it('copies install.sh byte-identical (md5 match) into the npm package', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(fs.existsSync(DEST), 'sync did not produce the expected file').toBe(true);
    expect(md5(DEST)).toBe(md5(SRC));
  });

  it('the copy is executable, same as the source', () => {
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    const mode = fs.statSync(DEST).mode;
    expect(mode & 0o111, 'the synced install.sh is not executable').toBeGreaterThan(0);
  });

  it('the destination has NO sibling lib/ directory — the exact condition that makes install.sh self-clone', () => {
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    const pkgDir = path.dirname(DEST);
    expect(fs.existsSync(path.join(pkgDir, 'lib')), 'a lib/ dir here would skip the self-clone path entirely').toBe(false);
  });
});
