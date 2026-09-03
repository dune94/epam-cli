import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE RETRIEVAL VOCABULARY IS DECLARED, NOT WRITTEN INTO A REGEX.
//
// Two functions built code-search queries by stripping English stopwords with an inline regex
// — `\b(the|a|an|is|not|for|in|of|...)\b` — and prefixing a fixed phrase, "applies handles
// processes resolves". Both were duplicated, and the two copies had already drifted: one said
// "processes resolves", the other "processes calculates resolves".
//
// Two things are wrong with it. A language's stopwords are an input, not an engine fact — a
// non-English ticket keeps every filler word while losing nothing meaningful. And a duplicated
// vocabulary means fixing retrieval in one place and not the other, silently.
const REPO = process.cwd()
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js')
const CFG = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/spec-mode-defaults.json'), 'utf8'))
const SRC = readFileSync(RUNNER, 'utf8')
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the retrieval vocabulary is declared', () => {
  it('spec-mode-defaults declares the retrieval block', () => {
    expect(CFG.retrieval, 'no retrieval block declared').toBeTruthy()
    expect(Array.isArray(CFG.retrieval.stopwords), 'stopwords must be a declared list').toBe(true)
    expect(CFG.retrieval.stopwords.length, 'an empty stopword list strips nothing').toBeGreaterThan(0)
    expect(String(CFG.retrieval.queryPrefix || ''), 'no query prefix declared').not.toBe('')
  })

  it('THE INVARIANT: no stopword regex is written into the engine', () => {
    expect(CODE, 'stopwords are still inlined as a regex — they are an input, not engine logic')
      .not.toMatch(/\\b\((?:the\|a\|an|the\|a)\b/)
    expect(CODE).not.toMatch(/\|is\|not\|for\|in\|of\|/)
  })

  it('THE INVARIANT: the query phrase is not written into the engine', () => {
    expect(CODE, 'the query prefix is still a literal in code')
      .not.toMatch(/applies handles processes/)
  })

  it('the truncation limits are declared, not magic numbers at the call site', () => {
    const r = CFG.retrieval
    for (const k of ['termChars', 'queryChars', 'symptomQueryChars', 'acsInSymptomQuery']) {
      expect(Number.isFinite(r[k]), `retrieval.${k} must be declared`).toBe(true)
      expect(r[k], `retrieval.${k} must be positive`).toBeGreaterThan(0)
    }
  })

  it('ONE vocabulary, not two that drift: the engine reads it in every place it builds a query', () => {
    // both query builders must go through the same declared source
    const uses = (CODE.match(/retrievalVocabulary\(|retrieval\.stopwords|buildRetrievalQuery\(/g) || []).length
    expect(uses, 'fewer than two call sites read the declaration — one still has its own copy')
      .toBeGreaterThanOrEqual(2)
  })

  // EXECUTED, not re-implemented. A harness that strips its own stopwords proves the harness.
  describe('executed against the real functions', () => {
    const spec = require(RUNNER)

    it('declared stopwords are actually removed', () => {
      const out = spec.retrievalTerms('The calculation of the fare is not applied for the discount')
      for (const w of CFG.retrieval.stopwords) {
        expect(out.split(/\s+/).map((t: string) => t.toLowerCase()),
          `stopword "${w}" survived`).not.toContain(w)
      }
      // and the domain terms survive
      expect(out.toLowerCase()).toContain('calculation')
      expect(out.toLowerCase()).toContain('fare')
      expect(out.toLowerCase()).toContain('discount')
    })

    it('the query carries the declared prefix and the domain terms', () => {
      const q = spec.buildRetrievalQuery('The fare discount is not applied')
      expect(q).toContain(CFG.retrieval.queryPrefix)
      expect(q.toLowerCase()).toContain('fare')
    })

    it('NEVER MID-TERM: a cap lands on a word boundary, never inside a word', () => {
      const long = 'alpha '.repeat(60) + 'omegaword'
      const capped = spec.capAtWord(long, 200)
      expect(capped.length).toBeLessThanOrEqual(200)
      // the old `.slice(0, 200)` cut here mid-word; the boundary version must not
      expect(long.startsWith(capped)).toBe(true)
      expect(long[capped.length] === ' ' || capped.length === long.length,
        'the cap landed inside a word — half a word matches nothing').toBe(true)
    })

    it('a missing declaration strips nothing rather than inventing a vocabulary', () => {
      const prev = process.env.EPAM_SPEC_MODE_DEFAULTS
      process.env.EPAM_SPEC_MODE_DEFAULTS = '/nonexistent/spec-mode-defaults.json'
      try {
        expect(spec.retrievalTerms('The fare is not applied')).toContain('The')
      } finally {
        if (prev === undefined) delete process.env.EPAM_SPEC_MODE_DEFAULTS
        else process.env.EPAM_SPEC_MODE_DEFAULTS = prev
      }
    })
  })
})
