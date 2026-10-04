/**
 * AN UPDATE REPLACES ENGINE VALUES THE OPERATOR NEVER EDITED — AND STILL KEEPS EVERY OPERATOR EDIT.
 *
 * 2026-10-04: the AMSD-2974 install's orchestrations/config/agent-contract.json was byte-identical to
 * the ENGINE's version from before 269d2155. Nobody had edited it; the installer's merge kept every
 * existing key's old value ("the operator's value wins"), so the 10-01 fix that took the absolute
 * project root out of every SI, and today's SDK-rule fix, never reached it.
 *
 * Operator-approved: a value is the operator's only if the engine never shipped it. Each existing
 * value is compared with every version of that key in the engine's own history of the file; one the
 * engine shipped is replaced by today's (or dropped, if the engine has since removed the key), any
 * other is kept and reported.
 *
 * EXECUTED: the real snapshot/restore functions, a real git repository standing in for the engine's
 * history of the catalogue.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations-installer/lib/preserve-operator-config.sh');
const REL = 'orchestrations/config/agent-contract.json';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const V1 = { boundary: 'outside PROJECT_ROOT ({projectRoot})', sdk: 'use bash orchestrations/scripts/x.sh', retired: 'an engine rule since removed', shared: 's' };
const V2 = { boundary: 'outside your working directory', sdk: 'read the package\'s own source', shared: 's', added: 'a new engine rule' };

function engineRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'engine-history-')); dirs.push(d);
  const g = (a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
  writeFileSync(join(d, REL), JSON.stringify(V1, null, 2)); g(['add', '-A']); g(['commit', '-qm', 'v1']);
  writeFileSync(join(d, REL), JSON.stringify(V2, null, 2)); g(['add', '-A']); g(['commit', '-qm', 'v2']);
  return d;
}

function update(installed: object, history?: string) {
  const d = mkdtempSync(join(tmpdir(), 'opcfg-engine-')); dirs.push(d);
  const dest = join(d, 'dest'); const tmp = join(d, 'snap');
  mkdirSync(join(dest, 'orchestrations/config'), { recursive: true }); mkdirSync(tmp);
  const paths = join(d, 'paths.json'); writeFileSync(paths, JSON.stringify({ paths: [REL] }));
  writeFileSync(join(dest, REL), JSON.stringify(installed, null, 2));
  const r = spawnSync('bash', ['-c', [
    `source ${JSON.stringify(LIB)}`,
    `snapshot_operator_config ${JSON.stringify(dest)} ${JSON.stringify(paths)} ${JSON.stringify(tmp)}`,
    `cat > ${JSON.stringify(join(dest, REL))} <<'EOT'\n${JSON.stringify(V2, null, 2)}\nEOT`,
    `restore_operator_config ${JSON.stringify(dest)} ${JSON.stringify(tmp)}${history ? ` ${JSON.stringify(history)}` : ''}`,
  ].join('\n')], { encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`, cat: JSON.parse(readFileSync(join(dest, REL), 'utf8')) };
}

describe('an update replaces engine values the operator never edited', () => {
  it('a value the engine shipped earlier is replaced by today\'s', () => {
    const { cat } = update(V1, engineRepo());
    expect(cat.boundary).toBe(V2.boundary);
    expect(cat.sdk).toBe(V2.sdk);
  });

  it('a key the engine has since removed, still holding a value the engine shipped, is dropped', () => {
    expect(update(V1, engineRepo()).cat).not.toHaveProperty('retired');
  });

  it('an operator edit — a value the engine never shipped — is kept, and said', () => {
    const { cat, out } = update({ ...V1, boundary: 'THE OPERATOR\'S OWN WORDING', mine: 'x' }, engineRepo());
    expect(cat.boundary).toBe('THE OPERATOR\'S OWN WORDING');
    expect(cat.mine).toBe('x');
    expect(cat.sdk).toBe(V2.sdk);
    expect(out).toMatch(/boundary/);
  });

  it('a key the new version adds arrives', () => {
    expect(update(V1, engineRepo()).cat.added).toBe(V2.added);
  });

  it('with no engine history to consult, the operator\'s value wins as before', () => {
    expect(update(V1).cat.boundary).toBe(V1.boundary);
  });
});
