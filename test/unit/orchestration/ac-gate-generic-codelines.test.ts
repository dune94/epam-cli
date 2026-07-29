/**
 * ac-gate.js: generic codeline support.
 *
 * Verifies that the AC gate builds prompts, resolves codelines, and emits
 * per-codeline AC fields from env/data — not from hardcoded "be"/"fe" strings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT    = join(__dirname, '../../../');
const AC_GATE_SRC  = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/lib/ac-gate.js'), 'utf8');
const SYNTH_SRC    = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/synthesize-prd-from-jira.js'), 'utf8');

// ── Source-level invariants ───────────────────────────────────────────────────

describe('ac-gate.js: no hardcoded "be"/"fe" codeline names in executable code', () => {
  // Strip comments so we only check executable lines
  const executableLines = AC_GATE_SRC
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  it('does not hardcode "beAcs" as a string literal in output', () => {
    // beAcs must not appear as a fixed key — only as a template like `${cl}Acs`
    expect(executableLines).not.toMatch(/'beAcs'|"beAcs"/);
  });

  it('does not hardcode "feAcs" as a string literal in output', () => {
    expect(executableLines).not.toMatch(/'feAcs'|"feAcs"/);
  });

  it('does not hardcode "be" as the default codeline fallback', () => {
    // The old fallback was `|| 'be'` — must now use JIRA_DEFAULT_CODELINE
    expect(executableLines).not.toMatch(/\|\|\s*['"]be['"]/);
  });

  it('emits per-codeline ACs via ${cl}Acs dynamic key (generic spread)', () => {
    expect(executableLines).toContain('`${cl}Acs`');
  });

  it('resolves codelines from JIRA_CODELINES env var', () => {
    expect(executableLines).toContain('JIRA_CODELINES');
  });

  it('falls back to JIRA_DEFAULT_CODELINE (not a hardcoded name)', () => {
    expect(executableLines).toContain('JIRA_DEFAULT_CODELINE');
  });

  it('reads per-codeline descriptions from JIRA_CODELINE_DESC_<UPPER>', () => {
    expect(executableLines).toContain('JIRA_CODELINE_DESC_');
  });
});

describe('ac-gate.js: buildClassificationPrompt is data-driven', () => {
  it('prompt template uses knownCodelines parameter (not hardcoded list)', () => {
    // The function signature must accept knownCodelines as second arg
    expect(AC_GATE_SRC).toMatch(/function buildClassificationPrompt\s*\(\s*issue\s*,\s*knownCodelines\s*\)/);
  });

  it('SPLIT_VALUE is read from env (JIRA_SPLIT_CODELINE), not hardcoded as "both"', () => {
    const execLines = AC_GATE_SRC
      .split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    // The constant SPLIT_VALUE must exist and use the env var
    expect(execLines).toMatch(/SPLIT_VALUE\s*=\s*process\.env\.JIRA_SPLIT_CODELINE/);
  });
});

// ── synthesize-prd-from-jira.js: already generic ─────────────────────────────

describe('synthesize-prd-from-jira.js: per-codeline AC reading is generic', () => {
  it('reads per-codeline ACs via c[`${cl}Acs`] — no hardcoded beAcs/feAcs', () => {
    expect(SYNTH_SRC).toContain('`${cl}Acs`');
    expect(SYNTH_SRC).not.toMatch(/'beAcs'|"beAcs"/);
    expect(SYNTH_SRC).not.toMatch(/'feAcs'|"feAcs"/);
  });

  it('codeline discovery uses SPLIT_VALUE env var (not hardcoded "both")', () => {
    expect(SYNTH_SRC).toMatch(/SPLIT_VALUE\s*=\s*process\.env\.JIRA_SPLIT_CODELINE/);
  });

  it('worktree path resolution uses JIRA_WORKTREE_<UPPER> convention', () => {
    expect(SYNTH_SRC).toContain('JIRA_WORKTREE_');
    expect(SYNTH_SRC).toContain('.toUpperCase()');
  });
});

// ── resolveCodelines runtime behaviour ───────────────────────────────────────

describe('resolveCodelines: env-driven codeline resolution', () => {
  // Inline resolveCodelines from ac-gate.js for unit testing
  const SPLIT = 'both';

  function resolveCodelines(issues: Array<{ codeline?: string }>, jiraCodelines?: string, defaultCodeline?: string): string[] {
    if (jiraCodelines) {
      return jiraCodelines.split(',').map((c: string) => c.trim()).filter(Boolean);
    }
    const seen = new Set<string>();
    for (const issue of (issues || [])) {
      if (issue.codeline && issue.codeline !== SPLIT) seen.add(issue.codeline);
    }
    if (seen.size > 0) return [...seen];
    return defaultCodeline ? [defaultCodeline] : [];
  }

  it('uses JIRA_CODELINES when set (ignores issue labels)', () => {
    const issues = [{ codeline: 'be' }, { codeline: 'fe' }];
    expect(resolveCodelines(issues, 'backend,frontend,mobile')).toEqual(['backend', 'frontend', 'mobile']);
  });

  it('discovers codelines from issue labels when JIRA_CODELINES is unset', () => {
    const issues = [{ codeline: 'be' }, { codeline: 'fe' }, { codeline: 'both' }];
    expect(resolveCodelines(issues)).toEqual(['be', 'fe']); // excludes SPLIT_VALUE
  });

  it('works with arbitrary codeline names (not just be/fe)', () => {
    const issues = [{ codeline: 'backend' }, { codeline: 'mobile' }, { codeline: 'data' }];
    expect(resolveCodelines(issues)).toEqual(['backend', 'mobile', 'data']);
  });

  it('falls back to JIRA_DEFAULT_CODELINE for single-codeline projects', () => {
    expect(resolveCodelines([], undefined, 'backend')).toEqual(['backend']);
  });

  it('returns empty array when nothing is resolvable', () => {
    expect(resolveCodelines([])).toEqual([]);
  });
});

// ── No Jira write capability at all (2026-07-22) ────────────────────────────
// AC_GATE_SKIP_JIRA_COMMENTS previously gated a comment-posting block behind
// a runtime flag. After an unauthorized comment reached a live Jira ticket
// anyway, the write capability was removed entirely rather than re-gated —
// no addComment call, no comment-builder functions, no jira-client require,
// unconditionally. There is no flag left to test because there is nothing
// left to suppress.

describe('ac-gate.js: no Jira write capability exists at all', () => {
  it('does not require jira-client', () => {
    expect(AC_GATE_SRC).not.toContain("require('./jira-client')");
  });

  it('has no addComment call anywhere', () => {
    expect(AC_GATE_SRC).not.toMatch(/addComment/);
  });

  it('has no comment-builder functions', () => {
    expect(AC_GATE_SRC).not.toMatch(/buildSufficientComment|buildEnrichableComment|buildInsufficientComment/);
  });

  it('AC_GATE_SKIP_JIRA_COMMENTS is not referenced — nothing left to gate', () => {
    expect(AC_GATE_SRC).not.toContain('AC_GATE_SKIP_JIRA_COMMENTS');
  });
});

describe('ac-gate.js: AUTO_ELABORATE converts insufficient to enrichable', () => {
  it('reads AC_GATE_AUTO_ELABORATE from process.env', () => {
    expect(AC_GATE_SRC).toContain('AC_GATE_AUTO_ELABORATE');
  });

  it('calls elaborateAcs() when verdict is insufficient and AUTO_ELABORATE is set', () => {
    expect(AC_GATE_SRC).toContain('elaborateAcs(issue)');
    expect(AC_GATE_SRC).toMatch(/verdict.*insufficient.*AUTO_ELABORATE|AUTO_ELABORATE.*verdict.*insufficient/s);
  });

  it('overrides verdict to enrichable after elaboration', () => {
    expect(AC_GATE_SRC).toContain("verdict = 'enrichable'");
  });

  it('elaborateAcs builds a prompt from issue title + description (no hardcoded story)', () => {
    // Must reference issue.title and issue.description — not a hardcoded key/title
    expect(AC_GATE_SRC).toContain('issue.title');
    expect(AC_GATE_SRC).toContain('issue.description');
  });

  it('elaborateAcs returns enrichedAcs array from LLM JSON response', () => {
    expect(AC_GATE_SRC).toContain('enrichedAcs');
    expect(AC_GATE_SRC).toContain('parsed.enrichedAcs');
  });

  it('elaborateAcs does NOT fabricate a title-based criterion when the LLM fails', () => {
    // Changed 2026-07-29. The title-only fallback was not a degraded answer, it
    // was an invented one, and it produced the live cascade: no real criteria ->
    // verification criteria derived from the title -> CPA with nothing to size
    // from -> effort:"low", 5.4 minutes for a novel three-repo capability ->
    // the cheapest model -> nothing built. Elaboration failing means the
    // pipeline does not know what the story requires, and proceeding on an
    // invented criterion is worse than stopping.
    expect(AC_GATE_SRC, 'a failed elaboration still substitutes a title-based criterion')
      .toContain('NOT substituting a title-based criterion');
    expect(AC_GATE_SRC, 'the failure is swallowed instead of propagating to the halt path')
      .toMatch(/elaboration failed[\s\S]{0,400}throw e;/);
  });

  it('does NOT set hasInsufficient when AUTO_ELABORATE converts the verdict', () => {
    // The AUTO_ELABORATE block must set verdict='enrichable' before the
    // hasInsufficient check runs, so exit(2) is never reached.
    const src = AC_GATE_SRC;
    const autoElabIdx   = src.indexOf('AUTO_ELABORATE');
    const enrichableIdx = src.indexOf("verdict = 'enrichable'");
    const insuffIdx     = src.indexOf('hasInsufficient = true');
    expect(autoElabIdx).toBeGreaterThan(-1);
    expect(enrichableIdx).toBeGreaterThan(autoElabIdx);
    // The hasInsufficient assignment must appear AFTER the enrichable override —
    // meaning by the time it executes, verdict is no longer 'insufficient'.
    expect(insuffIdx).toBeGreaterThan(enrichableIdx);
  });
});

describe('metrolinx/config.env: AC gate flags set for brownfield project', () => {
  const metrolinxEnv = readFileSync(
    join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env'), 'utf8'
  );

  it('sets AC_GATE_AUTO_ELABORATE=1', () => {
    expect(metrolinxEnv).toMatch(/^AC_GATE_AUTO_ELABORATE=1$/m);
  });

  it('does NOT set AC_GATE_SKIP_JIRA_COMMENTS — there is no Jira write to skip', () => {
    expect(metrolinxEnv).not.toMatch(/^AC_GATE_SKIP_JIRA_COMMENTS=/m);
  });
});

describe('greenfield flow: AC gate Jira-write flags must NOT appear in greenfield config', () => {
  // AC_GATE_AUTO_ELABORATE is metrolinx-only. Setting it in the shared jira/.env
  // or travel-app config would silently auto-elaborate ACs for all projects.
  const jiraEnv = readFileSync(join(REPO_ROOT, 'orchestrations/jira/.env'), 'utf8');

  it('orchestrations/jira/.env does not set AC_GATE_AUTO_ELABORATE', () => {
    expect(jiraEnv).not.toMatch(/^AC_GATE_AUTO_ELABORATE=/m);
  });

  it('ac-gate.js defaults AUTO_ELABORATE to OFF (only active when env var === "1")', () => {
    expect(AC_GATE_SRC).toContain("AC_GATE_AUTO_ELABORATE === '1'");
  });
});

// ── jira/.env: declares JIRA_CODELINES ───────────────────────────────────────

describe('jira/.env: codeline config is documented', () => {
  const envSrc = readFileSync(join(REPO_ROOT, 'orchestrations/jira/.env'), 'utf8');

  it('declares JIRA_CODELINES', () => {
    expect(envSrc).toMatch(/^JIRA_CODELINES=/m);
  });

  it('declares at least one JIRA_CODELINE_DESC_*', () => {
    expect(envSrc).toMatch(/JIRA_CODELINE_DESC_/);
  });

  it('declares JIRA_WORKTREE_ entries matching JIRA_CODELINES values', () => {
    // JIRA_CODELINES=be,fe → expect JIRA_WORKTREE_BE and JIRA_WORKTREE_FE
    const match = envSrc.match(/^JIRA_CODELINES=(.+)$/m);
    expect(match).toBeTruthy();
    const codelines = (match![1] || '').split(',').map(c => c.trim()).filter(Boolean);
    for (const cl of codelines) {
      expect(envSrc, `JIRA_WORKTREE_${cl.toUpperCase()} must be declared`).toContain(`JIRA_WORKTREE_${cl.toUpperCase()}=`);
    }
  });
});
