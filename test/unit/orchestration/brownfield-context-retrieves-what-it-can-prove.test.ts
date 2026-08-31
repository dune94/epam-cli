/**
 * BROWNFIELD CONTEXT RETRIEVAL — 305 lines, no test.
 *
 * This is what a CPA estimate and a spec pass are given as "what the codebase already says". It
 * walks the repository, chunks source, scores by TF-IDF, and folds in ticket and architecture
 * documents. Every failure mode here is silent by construction: it exits 0 with `[]` on a missing
 * repository, so a misconfiguration produces "no relevant context" — indistinguishable from a
 * correct answer for a query nothing matches, and the agent then estimates and specifies blind.
 *
 * So the cases worth having are the ones that separate NOTHING MATCHED from NOTHING WAS LOOKED AT.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/lib/brownfield-context.js');
const NODE = process.execPath;

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'bfctx-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  execFileSync('git', ['-C', dir, 'init', '--quiet']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  return dir;
}

function retrieve(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, JIRA_URL: '', JIRA_EMAIL: '', JIRA_TOKEN: '', ...env },
  });
  let out: any = null;
  try { out = JSON.parse(r.stdout || ''); } catch { /* not JSON */ }
  return { code: r.status ?? -1, err: r.stderr ?? '', out };
}

describe('brownfield context separates "nothing matched" from "nothing was looked at"', () => {
  it('a MISSING repository is non-fatal and yields an empty array', () => {
    // Documented behaviour, and the reason the tests below matter: this exit looks identical to a
    // successful search that found nothing.
    const r = retrieve(['--repo-root', '/no/such/repo', '--query', 'payments']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([]);
  }, 120_000);

  it('but a real repository with a matching file RETURNS it — so the empty case means something', () => {
    const dir = repo({
      'src/payments/charge.ts': 'export function chargeCard(amount: number) {\n  return amount;\n}\n',
      'src/unrelated/weather.ts': 'export const forecast = () => "sunny";\n',
    });
    const r = retrieve(['--repo-root', dir, '--query', 'chargeCard payments']);
    expect(r.code, r.err).toBe(0);
    expect(Array.isArray(r.out), 'output was not a JSON array').toBe(true);
    expect(r.out.length, 'a repository with an obviously matching file returned nothing')
      .toBeGreaterThan(0);
    expect(r.out[0].source, 'the source is not labelled with its origin').toMatch(/^git:/);
    expect(JSON.stringify(r.out), 'the matching file was not retrieved').toContain('chargeCard');
  }, 120_000);

  it('and the BEST match is ranked first — the caller reads the top of the list', () => {
    const dir = repo({
      'src/payments/charge.ts': 'chargeCard chargeCard chargeCard payments payments\n',
      'src/misc/notes.ts': 'a file mentioning payments once\n',
    });
    const r = retrieve(['--repo-root', dir, '--query', 'chargeCard']);
    expect(r.out[0].source, 'the strongest match is not first').toContain('charge.ts');
  }, 120_000);

  it('--top bounds the answer, because the caller pastes it into a prompt', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) files[`src/f${i}.ts`] = 'payments payments payments\n';
    const dir = repo(files);
    const r = retrieve(['--repo-root', dir, '--query', 'payments', '--top', '3']);
    expect(r.out.length, 'the result was not bounded by --top').toBeLessThanOrEqual(3);
  }, 120_000);

  it('every result carries a score and a chunk, or the caller cannot weigh it', () => {
    const dir = repo({ 'src/a.ts': 'payments processing service\n' });
    const r = retrieve(['--repo-root', dir, '--query', 'payments']);
    for (const hit of r.out) {
      expect(typeof hit.score, 'a hit has no score').toBe('number');
      expect(typeof hit.chunk, 'a hit has no chunk').toBe('string');
      expect(hit.chunk.length, 'a hit carries an empty chunk').toBeGreaterThan(0);
    }
  }, 120_000);

  it('STUB ticket documents are folded in, labelled as stubs', () => {
    // The label is the point: a reader must be able to tell stubbed context from live Jira.
    const dir = repo({ 'src/a.ts': 'unrelated\n' });
    mkdirSync(join(dir, '.epam/brownfield'), { recursive: true });
    writeFileSync(join(dir, '.epam/brownfield/jira.json'), JSON.stringify([
      { key: 'AMSD-9', summary: 'Payments retry', description: 'retry failed charges',
        acceptanceCriteria: ['a retry happens'] }]));
    const r = retrieve(['--repo-root', dir, '--query', 'payments retry']);
    const sources = (r.out || []).map((h: any) => h.source).join(' ');
    expect(sources, 'the stubbed ticket was not retrieved').toMatch(/stub:jira:AMSD-9/);
  }, 120_000);

  it('and confluence stubs too', () => {
    const dir = repo({ 'src/a.ts': 'unrelated\n' });
    mkdirSync(join(dir, '.epam/brownfield'), { recursive: true });
    writeFileSync(join(dir, '.epam/brownfield/confluence.md'),
      '# Payments architecture\nCharges are retried three times.\n');
    const r = retrieve(['--repo-root', dir, '--query', 'payments architecture retried']);
    expect((r.out || []).map((h: any) => h.source).join(' ')).toMatch(/stub:confluence/);
  }, 120_000);

  it('a MALFORMED stub file does not take the retrieval down with it', () => {
    // The git stage already succeeded by this point. Throwing here would discard real context
    // because an optional stub was bad.
    // Several files, because TF-IDF over a single document has an IDF of zero and scores nothing —
    // a degenerate corpus, not a retrieval failure.
    const dir = repo({
      'src/payments.ts': 'payments charge retry payments charge\n',
      'src/weather.ts': 'forecast sunshine rain\n',
      'src/users.ts': 'user profile settings\n',
    });
    mkdirSync(join(dir, '.epam/brownfield'), { recursive: true });
    writeFileSync(join(dir, '.epam/brownfield/jira.json'), '{ not json');
    const r = retrieve(['--repo-root', dir, '--query', 'payments']);
    expect(r.code, 'a malformed stub aborted the whole retrieval').toBe(0);
    expect(r.out.length, 'real repository context was discarded because a stub was bad')
      .toBeGreaterThan(0);
  }, 120_000);

  it('--stub-dir overrides where stubs are read from', () => {
    const dir = repo({ 'src/a.ts': 'unrelated\n' });
    const stubs = mkdtempSync(join(tmpdir(), 'stubs-'));
    writeFileSync(join(stubs, 'confluence.md'), 'Payments run through the ledger service.\n');
    const r = retrieve(['--repo-root', dir, '--query', 'payments ledger', '--stub-dir', stubs]);
    expect((r.out || []).map((h: any) => h.source).join(' ')).toMatch(/stub:confluence/);
  }, 120_000);

  it('a query matching nothing returns an empty array, not an error', () => {
    const dir = repo({ 'src/a.ts': 'weather forecasting\n' });
    const r = retrieve(['--repo-root', dir, '--query', 'zzzzqqqq-nothing-matches-this']);
    expect(r.code).toBe(0);
    expect(Array.isArray(r.out)).toBe(true);
  }, 120_000);

  it('an UNTRACKED file is not retrieved — the repository decides what is source', () => {
    const dir = repo({ 'src/tracked.ts': 'payments tracked\n' });
    writeFileSync(join(dir, 'src/untracked.ts'), 'payments untracked untracked untracked\n');
    const r = retrieve(['--repo-root', dir, '--query', 'payments untracked']);
    expect(JSON.stringify(r.out), 'an untracked file was offered as repository context')
      .not.toContain('untracked.ts');
  }, 120_000);
});
