/**
 * DISCOVERY, EXERCISED AS THE PIPELINE EXERCISES IT — spawned, with a stubbed model, for £0.
 *
 * Discovery had unit tests on two exported functions and nothing that ran the script. So the 106
 * lines it gained since v1.5 — a new seamLadderModel(), a new extractJsonObject(), and a rung
 * argument deciding WHICH model a retry asks for — executed nowhere in the suite. Each decides
 * something silently: a wrong rung simply runs the wrong model, and nothing says so.
 *
 * codeline-discovery.js is a CLI guarded by `if (require.main !== module)`, so requiring it runs
 * none of that. The script already declares the seam this needs — CODELINE_DISCOVERY_AI_RUN_SH_-
 * OVERRIDE, "lets a test point callLlm() at a fake ai-run.sh stub with a controlled response,
 * without ever touching the real one". Every case below drives the real script through it, against
 * a real git estate, and asserts on what the script WROTE.
 *
 * The last case is the requirement itself, measured from the child's own V8 coverage rather than
 * claimed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiscovery, estatePath, DISCOVERY_FILES, REPO } from '../helpers/discovery-receiver';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { coverageFor } = require(join(REPO, 'test/helpers/v8-line-coverage.js'));

/** One coverage directory for the file, so the total reflects every case in it. */
const COV = mkdtempSync(join(tmpdir(), 'discovery-cov-'));

/** Retries are the point of some cases, so they must be cheap rather than absent. */
const FAST = { EPAM_CONTENT_RETRY_ATTEMPTS: '2', EPAM_PLAN_TIMEOUT_SECS: '10' };

const run = (o: Parameters<typeof runDiscovery>[0] = {}) =>
  runDiscovery({ ...o, covDir: COV, env: { ...FAST, ...(o.env ?? {}) } });

/** A well-formed selection of one repository in the estate this run created. */
const picks = (work: string, repo = 'alpha.shop.com', name = 'model-said-this') => JSON.stringify({
  codelines: [{
    path: estatePath(work, repo), name,
    reason: 'checkout lives here', evidence: 'checkout email confirm',
  }],
});

describe('discovery runs at its receiver', () => {
  it('selects a codeline and writes it, with the name derived from the repository', () => {
    const r = run();
    expect(r.code, `discovery exited ${r.code}: ${r.stderr.slice(-400)}`).toBe(0);
    expect(r.out, 'discovery wrote no result at all').toBeTruthy();
    expect(r.out.codelines).toHaveLength(1);
    // The model's name is taken back: a codeline name is a primary key, not a sample.
    expect(r.out.codelines[0].name).toBe('alphashop');
    expect(r.out.codelines[0].modelName).toBe('model-said-this');
  }, 120_000);

  it('an answer wrapped in prose is still read', () => {
    // extractJsonObject AT THE RECEIVER. Nothing asserted that callLlm routes raw output through
    // it; a model that explains itself first is the normal case, not the edge one.
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: FAST,
      reply: (_a) => 'Let me think about this.\n\n' + picks(work) + '\n\nHope that helps.',
      onWork: (w) => { work = w; },
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    expect(r.out.codelines[0].name).toBe('alphashop');
  }, 120_000);

  it('a reply naming a repository that is not in the estate is dropped, not trusted', () => {
    // dropUngroundedCodelines. A selection the model invented must never become a lane.
    const r = run({
      reply: JSON.stringify({
        codelines: [{ path: '/nowhere/invented.com', name: 'invented', reason: 'x', evidence: 'y' }],
      }),
    });
    // Assert the OUTCOME, not the sentence: an invented selection must not survive into the
    // result, and the run must not claim success. Matching on wording made this fail while the
    // pipeline was behaving correctly — it says "that path does not exist".
    expect(r.code, 'an invented path produced a successful discovery').not.toBe(0);
    expect(r.out, 'an invented path was written as a codeline').toBeNull();
    expect(r.stderr, 'the rejection does not name the path it rejected')
      .toContain('/nowhere/invented.com');
  }, 180_000);

  it('an empty reply fails loudly rather than selecting nothing quietly', () => {
    const r = run({ reply: '' });
    expect(r.code, 'an empty model reply was treated as a successful discovery').not.toBe(0);
    expect(r.stderr).toMatch(/empty response|no json/i);
  }, 180_000);

  it('a truncated agent is reported as truncated, not as an answer', () => {
    // stop_reason max_iterations: the reply is cut off mid-thought, so parsing what arrived and
    // calling it a selection continues the run on half an answer.
    const r = run({ result: { stop_reason: 'max_iterations' }, reply: '{"codelines":[]}' });
    expect(r.stderr).toMatch(/iterations/i);
  }, 180_000);

  it('an estate with no repositories is not a discovery of nothing', () => {
    const r = run({ estate: { 'not-a-repo': { 'file.txt': 'x' } }, nonRepos: ['not-a-repo'] });
    expect(r.stderr + r.stdout, 'discovery did not report an empty estate')
      .toMatch(/Found 0 git repo/i);
    expect(r.out, 'discovery selected a codeline from an estate with no repositories').toBeNull();
  }, 180_000);

  it('missing arguments produce usage, not a stack trace', () => {
    const r = run({ omitArgs: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Usage: node codeline-discovery\.js/);
  }, 120_000);

  it('a retry asks again, and a later attempt can succeed', () => {
    // The rung argument only matters if a retry actually happens. First attempt unparseable,
    // second well-formed: the run must end on the second, not on the first.
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: FAST,
      reply: (attempt) => (attempt === 1 ? 'no json here at all' : picks(work)),
      onWork: (w) => { work = w; },
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    expect(r.out.codelines[0].name).toBe('alphashop');
  }, 180_000);

  it('writes codeline facts when the project declares somewhere to put them', () => {
    // The happy path warns "codeline facts have nowhere to go" — the branch that writes them was
    // executed by nothing.
    const proj = mkdtempSync(join(tmpdir(), 'discovery-project-'));
    mkdirSync(join(proj, 'generated'), { recursive: true });
    mkdirSync(join(proj, 'prompts'), { recursive: true });
    const r = run({ env: { EPAM_PROJECT_CONFIG_DIR: proj } });
    expect(r.stderr, 'the facts branch was never reached').toMatch(/Codeline facts written/);
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    expect(existsSync(join(proj, 'codeline-facts.json')),
      'discovery resolved facts and wrote them nowhere').toBe(true);
  }, 120_000);

  it('two colliding siblings do not collapse into one codeline', () => {
    // The set-wide uniqueness rule, at the receiver rather than through the exported function.
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: FAST,
      estate: {
        'next.shop.com': { 'src/a.js': 'checkout email confirm' },
        'react.shop.com': { 'src/b.js': 'checkout email confirm' },
      },
      reply: () => JSON.stringify({
        codelines: [
          { path: estatePath(work, 'next.shop.com'), name: 'a', reason: 'r', evidence: 'checkout' },
          { path: estatePath(work, 'react.shop.com'), name: 'b', reason: 'r', evidence: 'checkout' },
        ],
      }),
      onWork: (w) => { work = w; },
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    const names = r.out.codelines.map((c: any) => c.name);
    expect(new Set(names).size, `two repositories share one key: ${names.join(', ')}`).toBe(2);
  }, 120_000);

  it('RECEIVER COVERAGE OF DISCOVERY IS AT LEAST 95%', () => {
    // The requirement, measured from what the child processes above actually executed, reported per
    // file so a regression names the file instead of moving one number.
    const report = coverageFor(COV, DISCOVERY_FILES);
    let covered = 0; let total = 0;
    const lines: string[] = [];
    for (const [file, v] of Object.entries<any>(report)) {
      covered += v.covered; total += v.total;
      lines.push(`${file.split('/').pop()}: ${v.pct.toFixed(1)}% (${v.covered}/${v.total})`
        + (v.uncovered.length ? ` uncovered: ${v.uncovered.slice(0, 25).join(',')}` : ''));
    }
    const pct = total ? (covered / total) * 100 : 0;
    expect(total, 'no discovery code was measured — the harness ran nothing').toBeGreaterThan(400);
    expect(pct, `receiver coverage is ${pct.toFixed(1)}% (${covered}/${total})\n${lines.join('\n')}`)
      .toBeGreaterThanOrEqual(95);
  }, 120_000);
});
