/**
 * Brownfield fix-site hardening — closes three gaps found reviewing the flow
 * after the AMSD-1820 wrong-fix work (2026-07-23):
 *
 *  #1 The detective's prescribed fix is now injected as AUTHORITATIVE, but an LLM
 *     can hallucinate the helper it names. verifyDetectiveHelper() deterministically
 *     checks the named symbol exists in the repo; a missing helper flags the fix as
 *     UNVERIFIED (a hypothesis) in the implementation prompt instead of fact.
 *  #2 The detective's causal fix-site file must be write-permitted. claude.sh unions
 *     fixSiteAnalysis[].file into EPAM_ALLOWED_WRITE_PATHS so the scope-guard cannot
 *     block the agent from writing the file it was told to fix.
 *  #3 The defect/novel classification is anchored to the Jira ticket type — a "Bug"
 *     forces storyKind=defect regardless of model judgment. issueType is carried
 *     from Jira ingest → PRD story.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const { verifyDetectiveHelper } = spec;
const claudeSrc = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const jiraClientSrc = readFileSync(join(ROOT, 'orchestrations/scripts/lib/jira-client.js'), 'utf8');
const synthSrc = readFileSync(join(ROOT, 'orchestrations/scripts/synthesize-prd-from-jira.js'), 'utf8');
const specSrc = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');


// THE PROMPT MOVED OUT OF THE ENGINE (2026-08-12) into
// orchestrations/prompts/templates/code-graph-detective.json. Asserting prompt text against the
// SOURCE of spec-mode-runner.js proves nothing now — and never proved much: a source grep
// passes on a comment or a dead branch. This renders what the model is actually sent.
const DETECTIVE_PROMPT = (() => {
  const path = require('node:path');
  const lib = path.join(__dirname, '../../../orchestrations/scripts/lib/prompt-library.js');
  return require(lib).buildPrompt(
    'code-graph-detective',
    path.join(__dirname, '../../../orchestrations/projects/metrolinx'),
    {
      __DETECTIVE_PROFILE__: '', __REPO_PATH__: '/REPO', __TOOL_PATH__: '/TOOL',
      __STORY_TITLE__: 'T', __STORY_DESCRIPTION__: '', __STORY_ACS__: '- AC',
      __KIND_AND_CORRECTIVE_CONTEXT__: '', __PRESEED_BLOCK__: '', __PRESCRIPTION_RULES__: '',
    },
  );
})();

describe('#1 verifyDetectiveHelper — hallucination guard', () => {
  const repo = ROOT; // this repo has real exported symbols under src/

  it('returns true for a helper symbol that really exists in the repo', () => {
    expect(verifyDetectiveHelper('calculateCost', repo)).toBe(true);
  });

  it('returns false for a symbol that exists nowhere (likely hallucinated)', () => {
    expect(verifyDetectiveHelper('xyzzyNotARealSymbol_9987', repo)).toBe(false);
  });

  it('returns null when no helper is named (not every fix needs one)', () => {
    expect(verifyDetectiveHelper('', repo)).toBeNull();
    expect(verifyDetectiveHelper(null as unknown as string, repo)).toBeNull();
  });

  it('strips call syntax and still checks the bare symbol', () => {
    // parseKey() -> parseKey ; not a real symbol here -> false, not a crash
    expect(verifyDetectiveHelper('parseKey()', repo)).toBe(false);
  });

  it('never throws on junk input / missing repo path', () => {
    expect(verifyDetectiveHelper('valid', '')).toBeNull();
    expect(verifyDetectiveHelper('!!!', repo)).toBeNull();
  });
});

describe('#1 injection — an UNVERIFIED helper is flagged as a hypothesis in the prompt', () => {
  // RE-POINTED 2026-08-13: the rendering moved from a jq program inside claude.sh to its
  // producer, lib/producers/fix-plan.js, so that the writer and the reviewer stop being told
  // different things about the same finding. The assertions are unchanged.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { renderFixPlan } = require(join(ROOT, 'orchestrations/scripts/lib/producers/fix-plan.js'));
  const run = (o: any) => renderFixPlan(o.fixSiteAnalysis).trim();

  it('appends the UNVERIFIED warning naming the missing helper when fixVerified=false', () => {
    const out = run({ fixSiteAnalysis: [{ file: 'src/a.ts', function: 'm', reason: 'match fails', fix: 'reuse fooBar', helper: 'fooBar', fixVerified: false }] });
    expect(out).toContain('UNVERIFIED');
    expect(out).toContain('`fooBar`');
    expect(out).toMatch(/do not invent it/);
  });

  it('does NOT warn when the helper is verified (fixVerified=true)', () => {
    const out = run({ fixSiteAnalysis: [{ file: 'src/a.ts', function: 'm', reason: 'match fails', fix: 'reuse realFn', helper: 'realFn', fixVerified: true }] });
    expect(out).not.toContain('UNVERIFIED');
  });

  it('does NOT warn when no helper was named (fixVerified=null)', () => {
    const out = run({ fixSiteAnalysis: [{ file: 'src/a.ts', function: 'm', reason: 'x', fix: 'inline change', helper: '', fixVerified: null }] });
    expect(out).not.toContain('UNVERIFIED');
  });
});

describe('#1 detective output schema requests a machine-checkable helper', () => {
  it('asks for a bare helper symbol and forbids inventing one', () => {
    expect(specSrc).toMatch(/"helper":"<bare existing symbol name to reuse, or empty>"/);
    expect(DETECTIVE_PROMPT).toMatch(/Do NOT invent a helper name/);
  });
  it('parses helper + computes fixVerified per finding', () => {
    expect(specSrc).toMatch(/fixVerified: verifyDetectiveHelper\(helper, repoPath\)/);
  });
});

describe('#2 write-scope includes the detective fix-site file', () => {
  it('claude.sh unions fixSiteAnalysis[].file into the allowed write paths', () => {
    expect(claudeSrc).toContain('_fixsite_paths');
    expect(claudeSrc).toMatch(/\.fixSiteAnalysis\[\]\?\.file/);
    // appended onto the same var WriteFile.ts reads
    expect(claudeSrc).toMatch(/_allowed_write_paths="\$\{_allowed_write_paths:\+\$\{_allowed_write_paths\}:\}\$\{_fixsite_paths\}"/);
  });

  it('real jq: extracts the fix-site file for the story', () => {
    const prd = { stories: [{ id: 'AMSD-1820', technicalNotes: { files: ['src/declared.ts'] }, fixSiteAnalysis: [{ file: 'src/services/apply-report-discounts.service.ts' }] }] };
    const out = execFileSync('jq', ['-r', '--arg', 'id', 'AMSD-1820',
      '.stories[] | select(.id == $id) | .fixSiteAnalysis[]?.file // empty'],
      { input: JSON.stringify(prd), encoding: 'utf8' }).trim();
    expect(out).toBe('src/services/apply-report-discounts.service.ts');
  });
});

describe('#3 classification anchored to Jira issue type', () => {
  it('jira-client normalizes issueType from the ticket', () => {
    expect(jiraClientSrc).toMatch(/issueType:\s*\(f\.issuetype && f\.issuetype\.name\) \|\| null/);
  });
  it('synthesize-prd carries issueType onto the PRD story', () => {
    expect(synthSrc).toMatch(/issueType:\s*c\.issueType \|\| null/);
  });
  it('spec pass forces storyKind=defect for a Bug ticket, overriding model judgment', () => {
    expect(specSrc).toMatch(/_jiraType === 'bug' && payload\.storyKind !== 'defect'/);
    expect(specSrc).toMatch(/payload\.storyKind = 'defect'/);
  });
});
