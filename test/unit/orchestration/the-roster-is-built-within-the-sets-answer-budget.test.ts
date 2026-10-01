/**
 * THE ROSTER IS BUILT WITHIN THE SET'S ANSWER BUDGET.
 *
 * Live 2026-10-01, AMSD-2974 on codemie-web (run 20261001T170038Z): the roster specialiser was asked
 * for the whole roster delta in one answer; CodeMie cuts every answer at its output limit and reports
 * success, so all three attempts came back as cut-off JSON — "the agent wrote no roster" — and the
 * mint refused the run.
 *
 * A set that declares a per-turn answer budget (its runner's `limits`) gets the roster one agent per
 * turn: one turn names the agents, one turn per agent writes its entry, and the engine merges them.
 * A set that declares none is asked once, exactly as before.
 *
 * EXECUTED: the real roster seam (lib/roster-seams.js) with a stand-in model that answers from what
 * it is asked and is cut where the platform cuts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const AGENTS = join(ROOT, 'orchestrations/agents');
const CONFIG = join(ROOT, 'orchestrations/config');
const SETS = JSON.parse(readFileSync(join(CONFIG, 'provider-sets.json'), 'utf8')).sets as Record<string, { settingsFile: string }>;
const limitsOf = (set: string) => Object.values<any>(JSON.parse(readFileSync(join(CONFIG, SETS[set].settingsFile), 'utf8')).runners || {})
  .map((r) => r.limits).find(Boolean);
const BUDGETED = Object.keys(SETS).find((s) => limitsOf(s)) as string;
const UNBUDGETED = Object.keys(SETS).find((s) => !limitsOf(s)) as string;
const L = BUDGETED ? limitsOf(BUDGETED) : null;
const BUDGET = L ? Math.floor(L.visibleTokensObservedMin * L.charsPerTokenObserved) : 0;

const MINTED = ['toast-engineer', 'shared-detective', 'site-a-investigator', 'site-b-investigator', 'site-c-investigator'];
/** One agent's entry, the size a real persona is (the live ones ran to thousands of characters). */
const entry = (n: string) => ({ persona: `# ${n}\n${'Knows this codeline in detail. '.repeat(70)}`, ancestor: 'story-writer', rationale: `why ${n}` });

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function specialise(set: string) {
  const work = mkdtempSync(join(tmpdir(), 'roster-budget-')); dirs.push(work);
  const prev = { ...process.env };
  process.env.EPAM_PROJECT_CONFIG_DIR = mintProjectPrompts();
  process.env.EPAM_PROVIDER_SET = set;
  const calls: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const roster = require(join(LIB, 'project-roster.js'));
    const logDir = join(work, 'logs'); mkdirSync(logDir, { recursive: true });
    const canonicalCopyPath = roster.copyCanonicalForRun(join(AGENTS, 'profiles.canonical.json'), logDir);
    // A model that answers what it is asked, from what it is shown, and is cut where the platform cuts.
    const runClaude = async (_x: unknown, prompt: string) => {
      calls.push(prompt);
      const one = MINTED.find((n) => prompt.includes(`ONE AGENT ONLY — ${n}`));
      let reply: string;
      if (/NAMES ONLY/.test(prompt)) reply = JSON.stringify({ agents: MINTED });
      else if (one) reply = JSON.stringify({ agents: { [one]: entry(one) } });
      else reply = JSON.stringify({ agents: Object.fromEntries(MINTED.map((n) => [n, entry(n)])) });
      return BUDGET && set === BUDGETED ? reply.slice(0, BUDGET) : reply;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rosterSeams } = require(join(LIB, 'roster-seams.js'));
    const codeline = join(work, 'codelines', 'site-a'); mkdirSync(codeline, { recursive: true });
    const { produce } = rosterSeams({
      spec: { runClaude, surveyLeadsBlock: () => '' }, promptExec: {}, projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR,
      LOG_DIR: logDir, AGENTS_DIR: AGENTS, REPO_PATH: codeline, codelines: [{ name: 'site-a', path: codeline }],
      stories: [{ id: 'X-1', title: 't' }], prd: {}, mintedDetail: MINTED.map((n) => ({ name: n, kind: 'investigator' })), survey: null,
    });
    const outPath = join(work, 'delta.json');
    await produce({ canonicalCopyPath, outPath, attempt: 1 });
    const delta = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
    return { calls, delta };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
}

describe('the roster is built within the set\'s answer budget', () => {
  it('the shape is real: a set declares a budget, and the whole roster does not fit in it', () => {
    expect(BUDGETED, 'no provider set declares an answer budget').toBeTruthy();
    const whole = JSON.stringify({ agents: Object.fromEntries(MINTED.map((n) => [n, entry(n)])) });
    expect(whole.length, 'the fixture roster fits one turn — this proves nothing').toBeGreaterThan(BUDGET);
    expect(JSON.stringify({ agents: { x: entry('x') } }).length, 'one entry does not fit one turn').toBeLessThan(BUDGET);
  });

  it('on the budgeted set, every agent the specialiser names reaches the roster — whole', async () => {
    const r = await specialise(BUDGETED);
    expect(r.delta, 'the specialiser wrote no roster — its answer was cut at the budget').toBeTruthy();
    expect(Object.keys(r.delta.agents).sort()).toEqual([...MINTED].sort());
    for (const n of MINTED) expect(r.delta.agents[n]).toEqual(entry(n));
  });

  it('on the budgeted set, no turn is asked for more than one agent\'s entry', async () => {
    const r = await specialise(BUDGETED);
    expect(r.calls.length).toBe(MINTED.length + 1);
    expect(r.calls.filter((p) => /NAMES ONLY/.test(p)).length).toBe(1);
  });

  it('a set with no declared budget is asked once, as before', async () => {
    expect(UNBUDGETED).toBeTruthy();
    const r = await specialise(UNBUDGETED);
    expect(r.calls.length).toBe(1);
    expect(Object.keys(r.delta.agents).sort()).toEqual([...MINTED].sort());
  });
});
