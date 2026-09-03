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
import { mkdtempSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

  it('facts the agent supplies are written, sourced or not', () => {
    // The facts file is what agents working inside a repository read INSTEAD of re-deriving what
    // the estate already knows. Every earlier case returned codelines with no facts at all, so the
    // rendering — including the "(unsourced)" marker for a fact the agent gave no origin for —
    // executed nowhere.
    const proj = mkdtempSync(join(tmpdir(), 'discovery-facts-'));
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: { ...FAST, EPAM_PROJECT_CONFIG_DIR: proj },
      onWork: (w) => { work = w; },
      reply: () => JSON.stringify({
        codelines: [{
          path: estatePath(work, 'alpha.shop.com'), name: 'model-said-this',
          reason: 'checkout lives here', evidence: 'checkout email confirm',
          facts: [
            { text: 'the checkout form validates email case-insensitively', source: 'src/checkout.js' },
            { text: 'a fact the agent gave no origin for' },
            { text: '   ' },
          ],
        }],
      }),
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    const facts = JSON.parse(readFileSync(join(proj, 'codeline-facts.json'), 'utf8'));
    const entry = facts.alphashop;
    expect(entry, `no entry for the codeline: ${Object.keys(facts).join(', ')}`).toBeTruthy();
    // The blank one is dropped; the unsourced one is KEPT and marked, because discarding it would
    // lose a fact while pretending none was given.
    expect(entry.facts).toHaveLength(2);
    expect(entry.facts[1].source).toMatch(/unsourced/);
  }, 120_000);

  it('a malformed codeline in the reply does not corrupt the facts file', () => {
    // The other side of two branches the happy path never takes: an entry with no name (skipped
    // rather than written under "undefined") and one with no path (written with an empty path
    // rather than the string "undefined"). A model returning either is a real case, and the facts
    // file is read by every agent working in that repository.
    const proj = mkdtempSync(join(tmpdir(), 'discovery-malformed-'));
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: { ...FAST, EPAM_PROJECT_CONFIG_DIR: proj },
      onWork: (w) => { work = w; },
      reply: () => JSON.stringify({
        codelines: [
          {
            path: estatePath(work, 'alpha.shop.com'), name: 'model-said-this',
            reason: 'checkout lives here', evidence: 'checkout email confirm',
            facts: [{ text: 'the checkout form exists', source: 'src/checkout.js' }],
          },
          // Grounded (a real repository in the estate) but unnamed — an ungrounded entry is
          // rejected earlier, so this is the only way the nameless path is reachable at all.
          { path: estatePath(work, 'beta.shop.com'), name: '', reason: 'nameless', evidence: 'timetable' },
        ],
      }),
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    const facts = JSON.parse(readFileSync(join(proj, 'codeline-facts.json'), 'utf8'));
    const keys = Object.keys(facts).filter((k) => !k.startsWith('_'));
    expect(keys, 'a nameless codeline was written into the facts file')
      .not.toContain('undefined');
    expect(keys, 'the well-formed codeline did not survive the malformed one')
      .toContain('alphashop');
  }, 120_000);

  it('a codeline with no facts is recorded as having none, not skipped', () => {
    // withoutFacts: the difference between "we asked and got nothing" and "we never asked".
    const proj = mkdtempSync(join(tmpdir(), 'discovery-nofacts-'));
    const r = run({ env: { EPAM_PROJECT_CONFIG_DIR: proj } });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    expect(r.stderr, 'a codeline with no facts was written without a word about it')
      .toMatch(/no facts for codeline/i);
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

  it('a selection with no evidence is dropped, and said to be', () => {
    // Grounding is not only "the path exists" — a codeline chosen with no evidence is a guess. The
    // agent must be told which selections were discarded and why, or the next attempt repeats them.
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: FAST, onWork: (w) => { work = w; },
      reply: () => JSON.stringify({
        codelines: [
          {
            path: estatePath(work, 'alpha.shop.com'), name: 'a',
            reason: 'checkout lives here', evidence: 'checkout email confirm',
          },
          { path: estatePath(work, 'beta.shop.com'), name: 'b', reason: 'a hunch', evidence: '' },
        ],
        // The field is `unsure`, not `unresolved` — read from the code rather than guessed at.
        unsure: [{ part: 'the confirm-email field', why: 'no repository mentions it' }],
      }),
    });
    expect(r.stderr, 'a codeline chosen with no evidence was dropped silently')
      .toMatch(/NO evidence/i);
    expect(r.stderr, 'the dropped selection\'s stated reason was not reported')
      .toMatch(/its stated reason was/i);
    expect(r.stderr, 'the unresolved part of the ticket was not reported')
      .toMatch(/unresolved part of the ticket/i);
  }, 120_000);

  it('when EVERY selection lacks evidence they are kept, loudly, rather than aborting', () => {
    // The judgement call the engine makes rather than failing the run outright — and it has to be
    // audible, because the lanes that follow are running on unevidenced choices.
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: FAST, onWork: (w) => { work = w; },
      reply: () => JSON.stringify({
        codelines: [
          { path: estatePath(work, 'alpha.shop.com'), name: 'a', reason: 'a hunch', evidence: '' },
        ],
      }),
    });
    expect(r.stderr, 'every codeline lacked evidence and nothing said so')
      .toMatch(/every codeline lacked evidence/i);
  }, 120_000);

  it('a dry run shows the prompt and selects nothing', () => {
    // Used to inspect what discovery WOULD send without spending anything. It must be obvious that
    // no selection was made, or a dry run reads like a real one that found nothing.
    const r = run({ args: ['--dry-run'] });
    expect(r.stderr, 'a dry run did not announce itself').toMatch(/DRY-RUN/);
    expect(r.out, 'a dry run wrote a selection').toBeNull();
  }, 120_000);

  it('an unreadable codeline root fails loudly, naming the path', () => {
    // JIRA_CODELINE_ROOT pointing somewhere that does not exist is an operator mistake, and the
    // message has to name the path or the operator checks the wrong thing.
    const r = run({ rootOverride: '/nowhere/does/not/exist' });
    expect(r.code, 'an unreadable codeline root was not an error').not.toBe(0);
    expect(r.stderr, 'the failure does not name the root it could not read')
      .toMatch(/nowhere\/does\/not\/exist/);
  }, 120_000);

  it('debug mode shows the call it makes', () => {
    // The debug path builds its command differently — without the stderr redirect — so it is a
    // second construction that has to stay correct alongside the first.
    let work = '';
    const r = runDiscovery({
      covDir: COV, onWork: (w) => { work = w; },
      env: { ...FAST, DEBUG_CODELINE_DISCOVERY: '1' },
      reply: () => picks(work),
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    expect(r.out.codelines[0].name).toBe('alphashop');
  }, 120_000);

  it('a facts file it cannot write is reported, and does not lose the codelines', () => {
    // The codelines are valid whether or not the facts landed. What must never happen is the run
    // proceeding while BELIEVING facts were provisioned.
    const proj = mkdtempSync(join(tmpdir(), 'discovery-rofacts-'));
    mkdirSync(join(proj, 'codeline-facts.json'), { recursive: true });   // a directory in its place
    const r = run({ env: { EPAM_PROJECT_CONFIG_DIR: proj } });
    expect(r.stderr, 'a failed facts write was silent')
      .toMatch(/could not write codeline facts/i);
    expect(r.out?.codelines?.[0]?.name, 'the codelines were lost with the facts').toBe('alphashop');
  }, 120_000);

  it('selecting nothing is rejected with a reason the agent can act on', () => {
    // "A run cannot start with no scope at all." The rejection has to explain what to do next,
    // because the retry re-asks the same model — a bare refusal earns the same empty answer.
    const r = run({ reply: '{"codelines": []}' });
    expect(r.code, 'an empty selection was accepted as a discovery').not.toBe(0);
    expect(r.stderr, 'the rejection does not tell the agent it selected nothing')
      .toMatch(/selected no codeline/i);
    expect(r.stderr, 'the rejection gives no route out — it must name the tools and the "unsure" '
      + 'escape, or the retry repeats the same empty answer').toMatch(/unsure/i);
  }, 120_000);

  it('lanes are ordered producers first when one repository depends on another', () => {
    // orderCodelines sequences the lanes from real inter-repo dependencies, so a library is built
    // before the app consuming it. The reordering is only visible when the agent returns them in
    // the WRONG order, which is the case worth asserting.
    let work = '';
    const r = runDiscovery({
      covDir: COV, env: FAST, onWork: (w) => { work = w; },
      estate: {
        'lib.shop.com': { 'package.json': JSON.stringify({ name: '@shop/lib', version: '1.0.0' }) },
        'app.shop.com': {
          'package.json': JSON.stringify({
            name: '@shop/app', version: '1.0.0', dependencies: { '@shop/lib': '^1.0.0' },
          }),
        },
      },
      reply: () => JSON.stringify({
        codelines: [
          { path: estatePath(work, 'app.shop.com'), name: 'app', reason: 'r', evidence: 'package.json' },
          { path: estatePath(work, 'lib.shop.com'), name: 'lib', reason: 'r', evidence: 'package.json' },
        ],
      }),
    });
    expect(r.code, r.stderr.slice(-300)).toBe(0);
    expect(r.stderr, 'the consumer was listed first and nothing reordered the lanes')
      .toMatch(/Run order \(producers first\)/);
  }, 120_000);

  it('a reply cut off mid-JSON is not parsed as far as it got', () => {
    // A truncated answer opens a brace and never closes it. Taking the fragment would select
    // whatever survived the cut — the model did not choose that set, the network did.
    const r = run({ reply: '{"codelines": [{"path": "/x", "name": "a"' });
    expect(r.code, 'a truncated reply produced a discovery').not.toBe(0);
    expect(r.out, 'a truncated reply was written as a selection').toBeNull();
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
