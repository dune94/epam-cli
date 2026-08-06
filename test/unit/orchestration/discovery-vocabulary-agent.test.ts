/**
 * THE TERM FILTER HOLDS NO WORDS.
 *
 * scoreRepos filtered the ticket's terms through a list written into the generic pipeline:
 *
 *   .filter(w => !['with','that','this','from','have','will','when','then','also', ...].includes(w))
 *
 * Four lines below it a comment announced that stopwords had been removed — true of a
 * different list in the same function, and false of this one. That is what an eroding rule
 * looks like: the fix, the explanation of the fix, and the surviving instance, all in one
 * screen.
 *
 * It is hardcoding of the ordinary kind. It is English, so a ticket written in any other
 * language is filtered by nothing. It is fixed, so a project whose product is named by one of
 * those words loses its strongest term silently. And it decides WHICH CLIENT REPOSITORY GETS
 * MODIFIED.
 *
 * WHY MEASUREMENT COULD NOT REPLACE IT — the reason this needed an agent rather than a
 * better formula. IDF over the candidate repositories demotes a term every repository
 * mentions. Filler appears in NO repository's text, so its document frequency is zero and IDF
 * scores it as maximally discriminating: measurement PROMOTES exactly the words the list was
 * there to remove. Rarity and meaninglessness are indistinguishable by counting. That is
 * proven below rather than asserted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const FILE = join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js');
const SRC = readFileSync(FILE, 'utf8');

/** Executable code only — an example inside a comment is not a filter. */
function codeLines(): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of SRC.split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(raw);
  }
  return out;
}

describe('no word list survives in the generic pipeline', () => {
  it('THE LIST IS GONE: no array of bare word literals is used as a filter', () => {
    // Any array of three or more quoted alphabetic literals in executable code. Deliberately
    // shaped to catch the NEXT one too, whatever words it holds and whatever it is called —
    // a check that names the old words would pass the moment someone picks different ones.
    const offenders = codeLines()
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /\[\s*(?:'[a-z]{2,}'|"[a-z]{2,}")\s*(?:,\s*(?:'[a-z]{2,}'|"[a-z]{2,}")\s*){2,}\]/.test(l))
      .map(({ l, n }) => `line ${n}: ${l.trim()}`);
    expect(
      offenders,
      'a fixed word list in the generic pipeline: wrong for the next project, wrong in any ' +
        'other language, and it decides which client repository gets modified',
    ).toEqual([]);
  });

  it('the terms come from an agent that is given the ticket AND the candidates', () => {
    expect(SRC).toMatch(/function deriveDiscoveryVocabulary/);
    const fn = SRC.slice(SRC.indexOf('function deriveDiscoveryVocabulary'));
    const body = fn.slice(0, fn.indexOf('\nfunction scoreRepos'));
    // Context as INPUT — without the candidates it cannot judge "carries no signal HERE".
    expect(body, 'the agent never sees the ticket').toMatch(/description/);
    expect(body, 'the agent never sees the candidates it is discriminating between').toMatch(/CANDIDATE REPOSITORIES/);
    expect(body).toMatch(/components/i);
  });

  it('the answer is schema-bound, not prose', () => {
    const fn = SRC.slice(SRC.indexOf('function deriveDiscoveryVocabulary'));
    expect(fn).toMatch(/normaliseVocabulary/);
    expect(fn).toMatch(/isVocabularyUsable/);
    expect(fn, 'a prose answer would reach the filter unchecked').toMatch(/DISCOVERY_VOCABULARY/);
  });

  it('the prompt carries no example terms of its own', () => {
    const fn = SRC.slice(SRC.indexOf('function deriveDiscoveryVocabulary'));
    const prompt = fn.slice(fn.indexOf('const prompt ='), fn.indexOf('const raw ='));
    // Placeholders describe the SHAPE. A worked example would be a word list in a costume,
    // and would anchor the model on it every run.
    const quoted = [...prompt.matchAll(/"term"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const q of quoted) {
      expect(q.startsWith('<') && q.endsWith('>'), `the prompt seeds a real term: "${q}"`).toBe(true);
    }
  });

  it('a derivation failure aborts instead of falling back to a built-in list', () => {
    const i = SRC.indexOf('function deriveVocabularyOrAbort');
    expect(i, 'the abort path is gone entirely').toBeGreaterThan(-1);
    const fn = SRC.slice(i, SRC.indexOf('\nfunction ', i + 10));
    expect(fn).toMatch(/process\.exit\(1\)/);
    expect(fn, 'a silent fallback is how the list comes back').not.toMatch(/=\s*\[\s*['"]/);
    // And main must actually go through it rather than calling the deriver directly.
    expect(SRC.slice(SRC.indexOf('── Main'))).toMatch(/deriveVocabularyOrAbort\(issues, manifest\)/);
  });

  it('the agent exists in every profiles file the pipeline restores from', () => {
    for (const f of ['profiles.json', 'profiles.json.original', 'profiles.canonical.json']) {
      const p = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents', f), 'utf8'));
      expect(p['discovery-vocabulary-agent'], `${f} has no persona for the agent`).toBeTruthy();
      expect(p['discovery-vocabulary-agent']).toMatch(/never blacklist|never filler|whitelist/i);
    }
  });
});

describe('why an agent — measurement provably cannot do this', () => {
  /** IDF over the candidate corpus, the obvious alternative. */
  function idf(term: string, repoTexts: string[]): number {
    const df = repoTexts.filter((t) => t.includes(term)).length;
    return Math.log(repoTexts.length / (1 + df));
  }

  it('IDF ranks filler ABOVE a real product term, so it cannot replace the agent', () => {
    // Two repositories that both mention the product, as real candidates do.
    const repos = [
      'checkout service handles payment capture for the storefront',
      'storefront web application for the same product line',
    ];
    // A filler word appears in NEITHER repository's text; the product term appears in both.
    const fillerScore = idf('when', repos);
    const realScore = idf('storefront', repos);
    expect(
      fillerScore,
      'if IDF demoted filler, the hardcoded list would have been replaceable by a formula ' +
        'and no agent would be needed — it does the opposite',
    ).toBeGreaterThan(realScore);
  });
});

describe('the pure applier does the filtering, and holds nothing', () => {
  const { applyVocabulary } = require('../../../orchestrations/scripts/lib/guard-vocabulary.js');

  it('a blacklisted term is dropped', () => {
    const flagged = applyVocabulary(['alpha', 'beta'], { blacklist: [{ term: 'beta', reason: 'r' }], whitelist: [] });
    expect(flagged.map((f: any) => f.item)).toEqual(['beta']);
  });

  it('whitelist wins, so a protected identifier survives', () => {
    const flagged = applyVocabulary(['beta'], {
      blacklist: [{ term: 'beta', reason: 'r' }],
      whitelist: [{ term: 'beta', reason: 'names a component' }],
    });
    expect(flagged).toEqual([]);
  });

  it('matching is whole-term, so a blacklisted word cannot eat a longer one', () => {
    const flagged = applyVocabulary(['payment', 'pay'], { blacklist: [{ term: 'pay', reason: 'r' }], whitelist: [] });
    expect(flagged.map((f: any) => f.item)).toEqual(['pay']);
  });

  it('no vocabulary means no filtering — never a built-in default', () => {
    expect(applyVocabulary(['with', 'that', 'this'], null)).toEqual([]);
  });
});

/**
 * EXECUTION — the word list is really produced, is not null, and really filters.
 *
 * The assertions above read source. These run the real script against real temp git repos
 * with a stubbed ai-run.sh, and read what landed on disk. No live run, no live model.
 *
 * The stub does not carry a word list of its own: it is told which term to blacklist and
 * returns it ONLY IF it finds that term in the prompt it was given. So a passing run also
 * proves the agent's prompt actually carried the ticket text — if the prompt were empty or
 * clipped, the stub returns an empty blacklist and discovery aborts.
 */
describe('EXECUTION: the vocabulary is produced and applied, proven on disk', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
  const { spawnSync, execFileSync } = require('node:child_process');
  const { tmpdir } = require('node:os');

  const DISCOVERY = join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js');
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  /** A term that is unmistakably filler here, and one that names software. Both from the ticket. */
  const FILLER = 'regarding';
  const SIGNAL = 'zx9qentitlement';

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'vocab-exec-')); dirs.push(root);
    for (const name of ['alpha-service', 'beta-service']) {
      const repo = join(root, name);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, description: `${name} component` }));
      writeFileSync(join(repo, 'src', 'index.ts'), `export const ${name.replace('-', '_')} = 1;\n`);
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
      execFileSync('git', ['-C', repo, 'add', '-A']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    }
    const issues = join(root, 'issues.json');
    writeFileSync(issues, JSON.stringify([{
      key: 'T-1', title: `Update the ${SIGNAL} handler`,
      description: `${FILLER} the change, the ${SIGNAL} handler must be updated in the alpha-service component.`,
      components: ['alpha'],
    }]));
    return { root, issues, out: join(root, 'out.json') };
  }

  /**
   * A stub ai-run.sh answering BOTH calls this script now makes. It derives its blacklist
   * from the prompt rather than carrying one.
   */
  function stub(opts: { vocabAnswer?: 'found' | 'empty' | 'prose' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-stub-')); dirs.push(dir);
    const p = join(dir, 'ai-run.sh');
    const mode = opts.vocabAnswer || 'found';
    writeFileSync(p, `#!/usr/bin/env bash
prompt="$(cat)"
if [[ "$prompt" == *"DISCOVERY_VOCABULARY"* ]]; then
  case "${mode}" in
    prose) echo "I think these words are unimportant." ;;
    empty) echo '<DISCOVERY_VOCABULARY>{"blacklist":[],"whitelist":[]}</DISCOVERY_VOCABULARY>' ;;
    *)
      # Only blacklist the term if it is genuinely present in the prompt we were handed.
      if grep -qw "${FILLER}" <<< "$prompt"; then
        echo '<DISCOVERY_VOCABULARY>{"blacklist":[{"term":"${FILLER}","reason":"stub: describes the request, not the software"}],"whitelist":[{"term":"${SIGNAL}","reason":"stub: names a handler"}]}</DISCOVERY_VOCABULARY>'
      else
        echo '<DISCOVERY_VOCABULARY>{"blacklist":[],"whitelist":[]}</DISCOVERY_VOCABULARY>'
      fi ;;
  esac
else
  echo '{"codelines":[{"name":"alpha-service","path":"REPLACED","reason":"stub"}]}'
fi
`);
    execFileSync('chmod', ['+x', p]);
    return p;
  }

  function run(f: ReturnType<typeof fixture>, stubPath: string) {
    return spawnSync(process.execPath, [DISCOVERY, '--issues', f.issues, '--root', f.root, '--out', f.out], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stubPath, CODEGRAPH_ENABLED: '0' },
    });
  }

  it('a word list is PRODUCED — non-null, non-empty — and written to disk', () => {
    const f = fixture();
    const r = run(f, stub());
    const vocabFile = join(f.root, 'discovery-vocabulary.json');
    expect(existsSync(vocabFile), `no vocabulary was persisted. stderr:\n${r.stderr}`).toBe(true);
    const v = JSON.parse(readFileSync(vocabFile, 'utf8'));
    expect(v.derived, 'the run proceeded with derived:false — a null vocabulary').toBe(true);
    expect(v.vocabulary).not.toBeNull();
    expect(v.vocabulary.blacklist.length, 'an empty list is the same as no list').toBeGreaterThan(0);
    expect(v.vocabulary.blacklist[0].reason, 'a term with no reason is an assertion, not evidence').toBeTruthy();
  });

  it('the list is APPLIED: the blacklisted term is dropped, the protected term survives', () => {
    const f = fixture();
    run(f, stub());
    const v = JSON.parse(readFileSync(join(f.root, 'discovery-vocabulary.json'), 'utf8'));
    expect(v.termsUsed.length, 'no terms at all — every assertion below would pass vacuously').toBeGreaterThan(2);
    expect(v.termsDropped.map((t: any) => t.term)).toContain(FILLER);
    expect(v.termsUsed, 'the blacklisted term still reached scoring').not.toContain(FILLER);
    expect(v.termsUsed, 'the term naming the software was filtered out').toContain(SIGNAL);
  });

  it('the agent really saw the ticket — the stub answers only on terms it found in the prompt', () => {
    const f = fixture();
    run(f, stub());
    const v = JSON.parse(readFileSync(join(f.root, 'discovery-vocabulary.json'), 'utf8'));
    // The stub returns a blacklist ONLY when the term is present in the prompt it received.
    // A non-empty list is therefore proof the prompt carried the description.
    expect(v.vocabulary.blacklist.map((b: any) => b.term)).toContain(FILLER);
  });

  it('an empty blacklist ABORTS — it is never treated as "nothing to filter"', () => {
    const f = fixture();
    const r = run(f, stub({ vocabAnswer: 'empty' }));
    expect(r.status, `expected an abort. stdout:\n${r.stdout}`).toBe(1);
    expect(r.stderr).toMatch(/discovery-vocabulary-agent failed/);
    expect(r.stderr, 'the abort must say why there is no fallback').toMatch(/no built-in word list/);
  });

  it('a prose answer ABORTS rather than filtering on nothing', () => {
    const f = fixture();
    const r = run(f, stub({ vocabAnswer: 'prose' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no tagged JSON|discovery-vocabulary-agent failed/);
  });

  it('the model-free mode keeps every term rather than inventing a list', () => {
    const f = fixture();
    const r = spawnSync(process.execPath, [DISCOVERY, '--issues', f.issues, '--root', f.root, '--out', f.out], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, CODELINE_DISCOVERY_DRY_RUN: '1', CODEGRAPH_ENABLED: '0' },
    });
    const v = JSON.parse(readFileSync(join(f.root, 'discovery-vocabulary.json'), 'utf8'));
    expect(r.status, `dry-run should not abort. stderr:\n${r.stderr}`).toBe(0);
    expect(v.derived).toBe(false);
    expect(v.termsDropped, 'terms were dropped with no vocabulary — by what?').toEqual([]);
    expect(v.termsUsed).toContain(FILLER);
  });
});
