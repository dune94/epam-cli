/**
 * AN UPDATE DELIVERS NEW CATALOGUE ENTRIES AND KEEPS THE OPERATOR'S.
 *
 * operator-config-paths.json preserves five engine-wide JSON catalogues across an update
 * (agent-messages, services, agent-contract, model-pricing, providers) so an operator's edit
 * survives — and its own $engineWide note records the cost: "a future update also stops
 * delivering THOSE additions automatically ... must merge them in by hand". 2026-09-20: the
 * install at 67e5599e shipped EscalateDefect's new message codes and the regintel install kept
 * its old catalogue, so the tool would answer with a bare code instead of the sentence.
 *
 * A hand merge is the one thing the install rule forbids. Restore now MERGES a preserved JSON
 * catalogue: every key the operator's copy holds keeps the operator's value; every key the new
 * ref adds arrives. Non-JSON operator files (config.env) are restored byte-for-byte as before.
 * Executed through the real preserve library.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations-installer/lib/preserve-operator-config.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function update(opts: { operator: any; newRef: any; operatorEnv?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'opcfg-merge-')); dirs.push(d);
  const dest = join(d, 'dest'); const tmp = join(d, 'snap'); mkdirSync(join(dest, 'orchestrations/config'), { recursive: true }); mkdirSync(tmp);
  const paths = join(d, 'paths.json');
  writeFileSync(paths, JSON.stringify({ paths: ['orchestrations/config/agent-messages.json', 'orchestrations/projects/*/config.env'] }));
  // Before the update: the operator's copies.
  writeFileSync(join(dest, 'orchestrations/config/agent-messages.json'), JSON.stringify(opts.operator, null, 2));
  if (opts.operatorEnv !== undefined) { mkdirSync(join(dest, 'orchestrations/projects/p'), { recursive: true }); writeFileSync(join(dest, 'orchestrations/projects/p/config.env'), opts.operatorEnv); }
  const r = spawnSync('bash', ['-c', [
    `source ${JSON.stringify(LIB)}`,
    `snapshot_operator_config ${JSON.stringify(dest)} ${JSON.stringify(paths)} ${JSON.stringify(tmp)}`,
    // The archive extraction: the new ref's copies overwrite dest.
    `cat > ${JSON.stringify(join(dest, 'orchestrations/config/agent-messages.json'))} <<'EOT'\n${JSON.stringify(opts.newRef, null, 2)}\nEOT`,
    opts.operatorEnv !== undefined ? `printf 'FROM_REF=1\\n' > ${JSON.stringify(join(dest, 'orchestrations/projects/p/config.env'))}` : ':',
    `restore_operator_config ${JSON.stringify(dest)} ${JSON.stringify(tmp)}`,
  ].join('\n')], { encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`, cat: JSON.parse(readFileSync(join(dest, 'orchestrations/config/agent-messages.json'), 'utf8')), env: opts.operatorEnv !== undefined ? readFileSync(join(dest, 'orchestrations/projects/p/config.env'), 'utf8') : '' };
}

describe('a preserved JSON catalogue is merged, not replaced', () => {
  const operator = { $comment: 'ops', write_refused_owned_by_other_story: 'THE OPERATOR WORDING', read_deduped: 'r' };
  const newRef = { $comment: 'ref', write_refused_owned_by_other_story: 'the new default wording', read_deduped: 'r', escalation_refused_own_file: 'Escalation refused: {path} is inside YOUR declared scope', escalation_filed: 'Escalation filed for {path}.' };
  it('the operator\'s value wins on a key both hold', () => {
    expect(update({ operator, newRef }).cat.write_refused_owned_by_other_story).toBe('THE OPERATOR WORDING');
    expect(update({ operator, newRef }).cat.$comment).toBe('ops');
  });
  it('a key the new ref adds arrives', () => {
    const c = update({ operator, newRef }).cat;
    expect(c.escalation_refused_own_file).toMatch(/Escalation refused/);
    expect(c.escalation_filed).toMatch(/Escalation filed/);
  });
  it('a key only the operator holds is kept', () => {
    expect(update({ operator: { ...operator, my_custom_code: 'x' }, newRef }).cat.my_custom_code).toBe('x');
  });
  it('a non-JSON operator file is restored byte-for-byte', () => {
    expect(update({ operator, newRef, operatorEnv: 'JIRA_CODELINE_ROOT=/my/test/copy\n' }).env).toBe('JIRA_CODELINE_ROOT=/my/test/copy\n');
  });
  it('an operator file that is not valid JSON is restored byte-for-byte rather than merged', () => {
    const d = mkdtempSync(join(tmpdir(), 'opcfg-bad-')); dirs.push(d);
    const dest = join(d, 'dest'); const tmp = join(d, 'snap'); mkdirSync(join(dest, 'orchestrations/config'), { recursive: true }); mkdirSync(tmp);
    const paths = join(d, 'paths.json'); writeFileSync(paths, JSON.stringify({ paths: ['orchestrations/config/agent-messages.json'] }));
    writeFileSync(join(dest, 'orchestrations/config/agent-messages.json'), '{not json');
    spawnSync('bash', ['-c', [`source ${JSON.stringify(LIB)}`, `snapshot_operator_config ${JSON.stringify(dest)} ${JSON.stringify(paths)} ${JSON.stringify(tmp)}`, `printf '{"a":1}' > ${JSON.stringify(join(dest, 'orchestrations/config/agent-messages.json'))}`, `restore_operator_config ${JSON.stringify(dest)} ${JSON.stringify(tmp)}`].join('\n')], { encoding: 'utf8' });
    expect(readFileSync(join(dest, 'orchestrations/config/agent-messages.json'), 'utf8')).toBe('{not json');
  });
});
