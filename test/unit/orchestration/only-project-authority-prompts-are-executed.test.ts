/**
 * ONLY PROJECT-AUTHORITY PROMPTS RUN. THE TEMPLATE IS NEVER EXECUTED. NO FALLBACKS.
 *
 * Operator mandate, 2026-08-11, verbatim: "WE WILL NEVER EVER run the template version of
 * the prompts - NEVER. NEVER - no fallbacks. Only project authority prompts - the
 * self-health mechanism is the only process permitted to mutate project level prompts.
 * You will keep each prompt in a separate file (json) and never hide prompts in code
 * ever again."
 *
 * Before this, the failure-analyst prompt was a 44-line heredoc inside claude.sh: generic,
 * with no project-level variant, so the self-heal mechanism had NOTHING TO MUTATE and the
 * prompt could not be corrected without editing the engine.
 *
 * The dangerous failure mode here is not a crash — it is a SILENT DEGRADE. A loader that
 * "helpfully" falls back to the generic template when the project prompt is missing runs
 * an unowned prompt for an entire campaign while every log line looks normal. So the
 * absence of a fallback is itself the thing under test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/prompt-library.js');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/failure-analyst.json');
const PROJECT_DIR = join(ROOT, 'orchestrations/projects/metrolinx');

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const lib = require(LIB);

const VALUES = {
  __ANALYST_PROFILE__: 'PROFILE',
  __STORY_ID__: 'AMSD-2041',
  __STORY_ROLE__: 'implementation-engineer',
  __STORY_ACS__: 'AC1: live preview renders draft content',
  __SKILL_ADDENDUM__: '(none)',
  __DEPENDENCY_CONTRACTS__: '(none)',
  __VERIFICATION_FAILURE__: 'SyntaxError: Unexpected token export',
  // Added 2026-08-12 with the analyst's attempt-evidence. Rendering FAILS CLOSED on a missing
  // value, which is why this test caught the new placeholder immediately — the analyst would
  // have aborted rather than silently losing the evidence.
  __ATTEMPT_CHANGES__: 'The previous attempt changed NO files — nothing was written.',
};

describe('the prompt exists as FILES, not as code', () => {
  it('the immutable generic template exists', () => {
    expect(existsSync(TEMPLATE), 'no template — prompts must live in files').toBe(true);
  });

  it('the project-authority prompt exists', () => {
    expect(existsSync(join(PROJECT_DIR, 'prompts/failure-analyst.json'))).toBe(true);
  });

  it('the analyst prompt is NO LONGER a heredoc in the engine', () => {
    // Asserting on source text is normally worthless, but the claim here IS about the
    // source: the prompt must not be embedded. The behavioural half is covered below by
    // actually rendering it from the file.
    const sh = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(sh).not.toContain('ANALYST_PROMPT_END');
    expect(sh, 'the engine must resolve the prompt through the library').toContain('prompt-library.js');
  });
});

describe('THE PROJECT PROMPT IS THE ONLY THING EXECUTED', () => {
  it('it loads and carries a body', () => {
    const doc = lib.loadProjectPrompt('failure-analyst', PROJECT_DIR);
    expect(doc.body.length).toBeGreaterThan(1000);
    expect(doc.authority).toBe('project');
  });

  it('a MISSING project prompt is a hard failure — never a template fallback', () => {
    const empty = mkdtempSync(join(tmpdir(), 'noprompts-'));
    try {
      expect(() => lib.loadProjectPrompt('failure-analyst', empty)).toThrow(/missing/i);
      // The template exists and is readable; the point is that it is STILL not used.
      expect(existsSync(TEMPLATE)).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('an absent project config dir is a hard failure, not a default', () => {
    expect(() => lib.loadProjectPrompt('failure-analyst', '')).toThrow(/EPAM_PROJECT_CONFIG_DIR/);
  });

  it('a prompt claiming non-project authority is refused', () => {
    const d = mkdtempSync(join(tmpdir(), 'badauth-'));
    try {
      mkdirSync(join(d, 'prompts'), { recursive: true });
      writeFileSync(join(d, 'prompts/x.json'),
        JSON.stringify({ id: 'x', authority: 'template', body: 'hi', placeholders: [] }));
      expect(() => lib.loadProjectPrompt('x', d)).toThrow(/non-project/i);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('RENDERING IS TOTAL — no placeholder ever reaches a model', () => {
  it('renders with every value supplied', () => {
    const out = lib.buildPrompt('failure-analyst', PROJECT_DIR, VALUES);
    expect(out).toContain('AMSD-2041');
    expect(lib.placeholdersIn(out), 'a placeholder survived into the rendered prompt').toEqual([]);
  });

  it('a MISSING value is a hard failure — a prompt without its evidence is worse than none', () => {
    const { __VERIFICATION_FAILURE__, ...partial } = VALUES;
    expect(() => lib.buildPrompt('failure-analyst', PROJECT_DIR, partial))
      .toThrow(/missing values for.*__VERIFICATION_FAILURE__/);
  });

  it('an EMPTY value is legitimate and must be passed explicitly', () => {
    // Empty is a value. Absent is not. Collapsing the two is how evidence goes missing.
    const out = lib.buildPrompt('failure-analyst', PROJECT_DIR, { ...VALUES, __SKILL_ADDENDUM__: '' });
    expect(lib.placeholdersIn(out)).toEqual([]);
  });

  it('values containing $& and $1 are inserted LITERALLY', () => {
    // Diffs, regexes and test logs routinely contain these. A string replacer would treat
    // them as replacement patterns and silently corrupt the evidence.
    const nasty = "cost $5, 50% off — $& $1 $` $' literal";
    const out = lib.buildPrompt('failure-analyst', PROJECT_DIR, { ...VALUES, __VERIFICATION_FAILURE__: nasty });
    expect(out).toContain(nasty);
  });

  it('a body using an undeclared placeholder is refused', () => {
    expect(() => lib.render({ id: 't', body: 'a __GHOST__ b', placeholders: [] }, { __GHOST__: 'x' }))
      .toThrow(/undeclared/);
  });

  it('a declaration listing a placeholder the body never uses is refused', () => {
    expect(() => lib.render({ id: 't', body: 'no slots', placeholders: ['__UNUSED__'] }, {}))
      .toThrow(/never uses/);
  });
});

describe('PROVENANCE — the project prompt records the template it was minted from', () => {
  it('the recorded hash matches the template body, so drift is detectable', () => {
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const p = JSON.parse(readFileSync(join(PROJECT_DIR, 'prompts/failure-analyst.json'), 'utf8'));
    const sha = createHash('sha256').update(t.body).digest('hex');
    expect(p.derivedFromSha256,
      'the template changed after this project prompt was minted — re-mint it or the ' +
      'project is running an older prompt than the template claims').toBe(sha);
  });

  it('every placeholder the template declares is declared by the project prompt', () => {
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const p = JSON.parse(readFileSync(join(PROJECT_DIR, 'prompts/failure-analyst.json'), 'utf8'));
    expect([...p.placeholders].sort()).toEqual([...t.placeholders].sort());
  });
});

describe('THE NOTE FORMAT IS STATED — the analyst is told what a well-formed note is', () => {
  /**
   * The live run's root cause was not only the cut: the prompt never said what a note
   * should look like. No length guidance, no completeness requirement, no rule for
   * carrying a literal — and its single example was prose, which the model imitated.
   */
  const body = () => JSON.parse(readFileSync(join(PROJECT_DIR, 'prompts/failure-analyst.json'), 'utf8')).body;

  it('it requires an imperative opener', () => {
    expect(body()).toMatch(/IMPERATIVE VERB/);
  });

  it('it requires the rule to be stated completely', () => {
    expect(body()).toMatch(/STATE THE RULE COMPLETELY/);
  });

  it('it requires literals to be carried verbatim and unabbreviated', () => {
    expect(body()).toMatch(/VERBATIM AND UNABBREVIATED/);
  });

  it('it tells the model to keep the literal and shorten the prose, never the reverse', () => {
    expect(body()).toMatch(/KEEP THE LITERAL AND SHORTEN THE EXPLANATION/);
  });

  it('the TEMPLATE carries no project-specific facts', () => {
    // A stack fact in a generic template is the same hardcoding violation, one level up:
    // true for this client, wrong for the next.
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8')).body;
    for (const leak of ['contentstack', 'metrolinx', 'gotransit', 'upexpress', 'swiper', '@azure']) {
      expect(t.toLowerCase(), `template names '${leak}' — a project fact in a generic prompt`)
        .not.toContain(leak);
    }
  });
});
