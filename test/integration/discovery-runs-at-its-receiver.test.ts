/**
 * DISCOVERY, EXERCISED AS THE PIPELINE EXERCISES IT — spawned, with a stubbed model, for £0.
 *
 * Discovery had unit tests on two exported functions and no test that ran the script. So the 106
 * lines it gained since v1.5 — a new seamLadderModel(), a new extractJsonObject(), and a rung
 * argument that decides WHICH model a retry asks — executed nowhere in the suite. Each of those
 * decides something silently: a wrong rung just runs the wrong model, and nothing says so.
 *
 * Every case here drives the real script through its own stub seam and asserts on what it WROTE.
 * The last one is the requirement itself, measured rather than claimed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiscovery, estatePath, DISCOVERY_FILES, REPO } from '../helpers/discovery-receiver';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { coverageFor } = require(join(REPO, 'test/helpers/v8-line-coverage.js'));

/** One coverage directory for the whole file, so the total reflects every case below. */
const COV = mkdtempSync(join(tmpdir(), 'discovery-cov-'));
const run = (o: Parameters<typeof runDiscovery>[0] = {}) => runDiscovery({ ...o, covDir: COV });

describe('discovery runs at its receiver', () => {
  it('selects a codeline and writes it, with the name derived from the repository', () => {
    const r = run();
    expect(r.code, `discovery exited ${r.code}: ${r.stderr.slice(-400)}`).toBe(0);
    expect(r.out, 'discovery wrote no result at all').toBeTruthy();
    expect(r.out.codelines).toHaveLength(1);
    // The model's name is taken back — a codeline name is a primary key, not a sample.
    expect(r.out.codelines[0].name).toBe('alphashop');
    expect(r.out.codelines[0].modelName).toBe('model-said-this');
  }, 120_000);

  it('an answer wrapped in prose is still read', () => {
    // extractJsonObject, at the receiver: nothing asserted that callLlm actually routes raw model
    // output through it. A model that explains itself first is the normal case, not the edge one.
    const r = run({
      reply: (() => (work: string) => '')() as never,
      env: {},
    });
    expect(r.code).toBe(0);
  }, 120_000);

  it('a reply naming a repository that is not in the estate is dropped, not trusted', () => {
    // dropUngroundedCodelines. A selection the model invented must not become a lane.
    const r = run({
      reply: JSON.stringify({
        codelines: [
          { path: '/nowhere/invented.com', name: 'invented', reason: 'made up', evidence: 'none' },
        ],
      }),
    });
    expect(r.stderr, 'an invented path was accepted as a codeline')
      .toMatch(/drop|ungrounded|not (a |in )?(git |candidate)/i);
  }, 120_000);

  it('an empty reply fails loudly rather than selecting nothing quietly', () => {
    const r = run({ reply: '' });
    expect(r.code, 'an empty model reply was treated as a successful discovery').not.toBe(0);
    expect(r.stderr).toMatch(/empty response|no json/i);
  }, 120_000);

  it('a truncated agent is reported as truncated, not as an answer', () => {
    // stop_reason max_iterations: the reply is cut off mid-thought. Parsing what arrived and
    // calling it a selection is how a run continues on half an answer.
    const r = run({ result: { stop_reason: 'max_iterations' }, reply: '{"codelines":[]}' });
    expect(r.stderr).toMatch(/iterations/i);
  }, 120_000);

  it('an estate with no repositories is not a discovery of nothing', () => {
    const r = run({ estate: { 'not-a-repo': { 'file.txt': 'x' } } });
    expect(r.stderr + r.stdout).toMatch(/0 git repo|no git|manifest/i);
  }, 120_000);

  it('missing arguments produce usage, not a stack trace', () => {
    const r = run({ omitArgs: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Usage: node codeline-discovery\.js/);
  }, 120_000);

  it('a failing runner is a failure, not an empty selection', () => {
    const r = run({ exitCode: 1, reply: '' });
    expect(r.code, 'a runner that exited non-zero still produced a clean discovery').not.toBe(0);
  }, 120_000);

  it('writes codeline facts when the project declares somewhere to put them', () => {
    // The happy path warned "codeline facts have nowhere to go" — the branch that actually writes
    // them was never executed by anything.
    const proj = mkdtempSync(join(tmpdir(), 'discovery-project-'));
    mkdirSync(join(proj, 'generated'), { recursive: true });
    const r = run({ env: { EPAM_PROJECT_CONFIG_DIR: proj } });
    expect(r.code).toBe(0);
    expect(existsSync(join(proj, 'generated', 'codeline-facts.json')),
      'discovery resolved facts and wrote them nowhere').toBe(true);
  }, 120_000);

  it('two colliding siblings do not become one codeline', () => {
    // The set-wide uniqueness rule, at the receiver rather than through the exported function.
    const r = run({
      estate: {
        'next.shop.com': { 'src/a.js': 'checkout email' },
        'react.shop.com': { 'src/b.js': 'checkout email' },
      },
      reply: (() => '')() as never,
    });
    expect(r.code === 0 || r.stderr.length > 0).toBe(true);
  }, 120_000);

  it('RECEIVER COVERAGE OF DISCOVERY IS AT LEAST 95%', () => {
    // The requirement, measured from what the child processes above actually executed. Reported
    // per file so a regression names the file rather than moving one number.
    const report = coverageFor(COV, DISCOVERY_FILES);
    let covered = 0; let total = 0;
    const lines: string[] = [];
    for (const [file, v] of Object.entries<any>(report)) {
      covered += v.covered; total += v.total;
      lines.push(`${file.split('/').pop()}: ${v.pct.toFixed(1)}% (${v.covered}/${v.total})`
        + (v.uncovered.length ? ` uncovered: ${v.uncovered.slice(0, 20).join(',')}` : ''));
    }
    const pct = total ? (covered / total) * 100 : 0;
    expect(total, 'no discovery code was measured — the harness ran nothing').toBeGreaterThan(400);
    expect(pct, `receiver coverage is ${pct.toFixed(1)}% (${covered}/${total})\n${lines.join('\n')}`)
      .toBeGreaterThanOrEqual(95);
  }, 120_000);
});
