/**
 * AN INSTALL RECORDS WITH THE KEYS OF ITS OWN LANGFUSE.
 *
 * `--replay on` refused every fresh install — "missing: LANGFUSE_SECRET_KEY LANGFUSE_PUBLIC_KEY" —
 * unless a human had first copied keys into .env. But the install's own Langfuse is brought up by
 * the same installer from docker-compose.observability.yml, which declares the project keys
 * (LANGFUSE_INIT_PROJECT_PUBLIC_KEY / _SECRET_KEY). A copy from one installer-written file into
 * another is a manual step with no decision in it. Found 2026-09-13 opening the £0 greenfield
 * rehearsal on a fresh install.
 *
 * lib/langfuse-keys.sh resolves: environment, then .env, then the compose declaration — and writes
 * compose keys into .env so every later reader finds them. Executed against fixture installs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations-installer/lib/langfuse-keys.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function install(opts: { dotenv?: string; compose?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'lfkeys-')); dirs.push(d);
  if (opts.dotenv !== undefined) writeFileSync(join(d, '.env'), opts.dotenv);
  const compose = join(d, 'docker-compose.observability.yml');
  if (opts.compose !== undefined) writeFileSync(compose, opts.compose);
  return { root: d, compose };
}
function resolve(root: string, compose: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; langfuse_keys_for_install ${JSON.stringify(root)} ${JSON.stringify(compose)}`], {
    encoding: 'utf8', env: { ...process.env, LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '', ...env },
  });
  const [sk, pk, src] = (r.stdout || '').split('\t');
  return { sk, pk, src };
}
const COMPOSE = `services:\n  langfuse-server:\n    environment:\n      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: pk-lf-fixture\n      LANGFUSE_INIT_PROJECT_SECRET_KEY: sk-lf-fixture\n`;

describe('an install records with the keys of its own Langfuse', () => {
  it('THE DEFECT: a fresh install with empty keys in .env takes them from its compose declaration, and writes them into .env', () => {
    const i = install({ dotenv: 'LANGFUSE_SECRET_KEY=\nLANGFUSE_PUBLIC_KEY=\nOTHER=x\n', compose: COMPOSE });
    const r = resolve(i.root, i.compose);
    expect(r).toEqual({ sk: 'sk-lf-fixture', pk: 'pk-lf-fixture', src: 'compose' });
    const dotenv = readFileSync(join(i.root, '.env'), 'utf8');
    expect(dotenv).toMatch(/^LANGFUSE_SECRET_KEY=sk-lf-fixture$/m);
    expect(dotenv).toMatch(/^LANGFUSE_PUBLIC_KEY=pk-lf-fixture$/m);
    expect(dotenv).toMatch(/^OTHER=x$/m);
    expect(dotenv.match(/^LANGFUSE_SECRET_KEY=/mg)).toHaveLength(1);
  });

  it('keys an operator put in .env win over the compose declaration, and .env is untouched', () => {
    const i = install({ dotenv: 'LANGFUSE_SECRET_KEY=sk-mine\nLANGFUSE_PUBLIC_KEY=pk-mine\n', compose: COMPOSE });
    const before = readFileSync(join(i.root, '.env'), 'utf8');
    expect(resolve(i.root, i.compose)).toEqual({ sk: 'sk-mine', pk: 'pk-mine', src: 'dotenv' });
    expect(readFileSync(join(i.root, '.env'), 'utf8')).toBe(before);
  });

  it('the environment wins over both', () => {
    const i = install({ dotenv: 'LANGFUSE_SECRET_KEY=sk-mine\nLANGFUSE_PUBLIC_KEY=pk-mine\n', compose: COMPOSE });
    expect(resolve(i.root, i.compose, { LANGFUSE_SECRET_KEY: 'sk-env', LANGFUSE_PUBLIC_KEY: 'pk-env' }).src).toBe('env');
  });

  it('a compose file that declares no keys leaves the install refused, as before — nothing is invented', () => {
    const i = install({ dotenv: 'LANGFUSE_SECRET_KEY=\nLANGFUSE_PUBLIC_KEY=\n', compose: 'services: {}\n' });
    expect(resolve(i.root, i.compose)).toEqual({ sk: '', pk: '', src: 'none' });
  });

  it('the repository\'s own compose file declares keys this resolver can read', () => {
    const i = install({ dotenv: 'LANGFUSE_SECRET_KEY=\nLANGFUSE_PUBLIC_KEY=\n' });
    const r = resolve(i.root, join(ROOT, 'docker-compose.observability.yml'));
    expect(r.src).toBe('compose');
    expect(r.pk).toMatch(/^pk-/); expect(r.sk).toMatch(/^sk-/);
  });
});
