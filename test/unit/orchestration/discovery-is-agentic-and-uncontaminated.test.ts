/**
 * CODELINE DISCOVERY IS THE AGENT'S DECISION, MADE ON ALL THE EVIDENCE.
 *
 * Which client repository gets modified was decided by ~250 lines of arithmetic in engine code:
 * a shortlist of 8, a filter dropping every ticket word under 4 characters, +3 per lexical hit,
 * a ×10 tier scaling, a structural weight of 500, a 7-term cap, and a paid LLM call to derive a
 * per-ticket stopword list to feed it. Every one of those numbers is a guess about a project
 * nobody had seen, sitting in a generic pipeline.
 *
 * The 4-character filter is the one that shows what the whole apparatus costs: it discards `UP`,
 * `MX` and `GO` — the identifiers that name the product — and keeps the generic prose. For a
 * ticket titled "[UP] Live Preview of Content in CMS" the shortlist was chosen with no way to
 * tell next.upexpress.com from next.metrolinx.com, and `components: ["UP"]`, the field the
 * prompt builder itself calls "maintained for exactly this purpose", never reached the ranking
 * at all.
 *
 * Measured on the live estate: the full manifest is ~6,700 tokens against the shortlist's
 * ~1,900. The apparatus spends an extra agent call to save ~4,800 tokens, and pays for that with
 * the answer.
 *
 * So: no ranking, no filtering, no truncation in code. Gather facts, hand the agent everything,
 * let it decide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE_PATH = join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js');
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

/** The ticket shapes that broke it, kept verbatim rather than paraphrased. */
const ISSUES = [{
  jiraKey: 'AMSD-2847',
  title: '[UP] Live Preview of Content in CMS',
  components: ['UP'],
  labels: ['Must'],
  description: 'AS a Content Author, I WANT to preview draft entries in CMS for the MX Homepage '
    + 'and Discover Article pages SO THAT I can see how content will be shown on the website.',
}];

const MANIFEST = Array.from({ length: 31 }, (_, i) => ({
  name: `repo-${i}`,
  path: `/estate/repo-${i}`,
  stack: 'node',
  packageName: `@estate/repo-${i}`,
  description: `the ${i}th repository`,
  readmeExcerpt: `readme for repo ${i}`,
}));
// Two siblings that only the product identifier can separate — the live case exactly.
MANIFEST[9] = {
  name: 'next.upexpress.com',
  path: '/estate/next.upexpress.com',
  stack: 'node',
  packageName: '@metrolinx/next.upexpress.com',
  description: 'UP Express public website',
  readmeExcerpt: 'Next.js site backed by Contentstack.',
};
MANIFEST[10] = {
  name: 'next.metrolinx.com',
  path: '/estate/next.metrolinx.com',
  stack: 'node',
  packageName: '@metrolinx/next.metrolinx.com',
  description: 'Metrolinx public website',
  readmeExcerpt: 'Next.js site backed by Contentstack.',
};

describe('every candidate reaches the agent', () => {
  it('the prompt names ALL repositories, not a shortlist', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { buildDiscoveryPrompt } = require(MODULE_PATH);
    const prompt = buildDiscoveryPrompt(ISSUES, MANIFEST);

    // Non-empty and actually rendered, or every assertion below is vacuous.
    expect(prompt.length).toBeGreaterThan(500);

    const missing = MANIFEST.filter((r) => !prompt.includes(r.name)).map((r) => r.name);
    expect(missing, `repositories the agent never saw: ${missing.join(', ')}`).toEqual([]);
  });

  it('both siblings are present, so the agent can actually choose between them', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { buildDiscoveryPrompt } = require(MODULE_PATH);
    const prompt = buildDiscoveryPrompt(ISSUES, MANIFEST);
    expect(prompt).toContain('next.upexpress.com');
    expect(prompt).toContain('next.metrolinx.com');
  });
});

describe('the whole ticket reaches the agent', () => {
  it('carries the title, the components, the labels and the whole description', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { buildDiscoveryPrompt } = require(MODULE_PATH);
    const prompt = buildDiscoveryPrompt(ISSUES, MANIFEST);

    expect(prompt).toContain('[UP] Live Preview of Content in CMS');
    // The field the prompt builder calls "maintained for exactly this purpose".
    expect(prompt).toContain('UP');
    expect(prompt).toContain('Must');
    // The WHOLE description — including the sentence that contradicts the title, because the
    // agent needs to see the contradiction to reason about it.
    expect(prompt).toContain('MX Homepage and Discover Article pages');
  });
});

describe('nothing in the decision path is a number somebody picked', () => {
  /** The region that decides which repository is chosen. */
  const decisionPath = () => {
    const start = SOURCE.indexOf('// ── Repo manifest builder');
    const end = SOURCE.indexOf('function callLlm');
    expect(start, 'the decision path could not be located — this test is checking nothing')
      .toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  };

  it('holds no scoring weights, shortlist caps or term-length cutoffs', () => {
    const body = decisionPath()
      // Comments explain history; they are not what executes.
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');

    const contaminants: Array<[string, RegExp]> = [
      ['a shortlist cap', /topN/],
      ['a term-length cutoff', /length\s*>=\s*\d/],
      ['a lexical point value', /score\s*\+=\s*\d/],
      ['a tier weight', /STRUCT_WEIGHT|structuralScore\s*\*/],
      ['a term cap', /MAX_TERMS/],
      ['a ranked truncation', /\.slice\(0,\s*\d+\)/],
    ];
    const found = contaminants.filter(([, re]) => re.test(body)).map(([what]) => what);
    expect(found, `the decision path still contains: ${found.join('; ')}`).toEqual([]);
  });

  it('no longer spends an agent call deriving a stopword list', () => {
    // The vocabulary agent existed ONLY to feed the filter. With no filter there is nothing for
    // it to feed, and a run should not pay for it.
    expect(SOURCE).not.toMatch(/deriveDiscoveryVocabulary\s*\(/);
  });

  it('names no vendor as a default provider', () => {
    // A provider literal in generic engine code is the same class of defect: it decides who gets
    // paid for a call on a project that never chose them.
    //
    // COMMENTS ARE NOT CODE. The first version of this grepped the whole file and failed on the
    // comment recording the removal — a test that cannot tell an executable default from a note
    // about one would forbid ever explaining the fix.
    // AIMED AT THE PROVIDER ASSIGNMENT, not at every default in the file. The broader version
    // matched `opts.costAgent || 'codeline-discovery'` — a label for a cost row, not a vendor —
    // and a test that cannot tell those apart teaches people to ignore it.
    const provider = SOURCE.slice(SOURCE.indexOf('const PROVIDER'));
    const assignment = provider.slice(0, provider.indexOf(';') + 1);
    expect(assignment, 'the provider assignment could not be located').toContain('PROVIDER');
    expect(assignment).not.toMatch(/'[a-z][a-z0-9-]+'/);
  });
});

describe('the agent can search the estate it is choosing from', () => {
  // codegraph_query is a PLUGIN tool, provisioned per repository, and the grant resolves plugin
  // tools from EPAM_CODELINE_PATHS || PROJECT_ROOT. Discovery runs BEFORE any codeline is known —
  // that is its entire job — so both were empty and the grant came back as
  // read_file,list_files,search. The one agent whose whole task is to search the estate was the
  // one agent that could not, and the engine compensated by running CodeGraph itself and handing
  // over a score.
  //
  // Every seam check passed while this was true: the registry declares read-only, delivery works,
  // 39 of 39 seams receive their tools. The seam that runs before the thing its grant depends on
  // is invisible to a check that runs after.
  /**
   * A codeline that really provisions the codegraph plugin, the way a provisioned repo does:
   * .epam/settings.json listing the plugin module. Pointing at invented paths would prove only
   * that a non-existent directory grants nothing.
   */
  const provisionedCodeline = () => {
    const d = mkdtempSync(join(tmpdir(), 'codeline-'));
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam', 'settings.json'), JSON.stringify({
      tools: [join(__dirname, '../../../orchestrations/plugins/codegraph-plugin.js')],
    }));
    return d;
  };

  const seamEnv = (paths: string[]) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { seamInvocationEnv } = require(
      join(__dirname, '../../../orchestrations/scripts/lib/seam-invocation.js'));
    const env = { ...process.env, EPAM_CODELINE_PATHS: paths.join(',') };
    return seamInvocationEnv('codeline-discovery', undefined, { env }) || {};
  };

  it('receives codegraph_query when the estate is published as its scope', () => {
    const a = provisionedCodeline();
    const b = provisionedCodeline();
    const env = seamEnv([a, b]);
    expect(env.EPAM_ALLOWED_TOOLS, 'the grant did not resolve at all').toBeTruthy();
    expect(env.EPAM_ALLOWED_TOOLS).toContain('codegraph_query');
    // The list and the channel are separate switches; one without the other is an agent that
    // quietly has nothing.
    expect(env.AI_GATE_ALLOW_TOOLS).toBe('1');
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  it('and gets only the read-only floor when no estate is published — the defect', () => {
    // Pins the cause, so a future change that stops publishing the estate fails here rather than
    // in a paid run that picks the wrong repository.
    const env = seamEnv([]);
    expect(env.EPAM_ALLOWED_TOOLS || '').not.toContain('codegraph_query');
  });
});
