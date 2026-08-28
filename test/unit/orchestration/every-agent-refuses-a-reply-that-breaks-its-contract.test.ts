import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

// EVERY SCHEMA-BOUND SEAM, HELD TO ITS OWN CONTRACT — not a sample.
//
// The roster stage had tests for its prompt, its refusal text, its budget and its wiring, and
// none that handed it an answer a model actually gave. Wiring tests cannot see a contract
// failure: they prove the call happened, not that a bad answer was rejected.
//
// The table is DERIVED from the shipped registry, never typed here. A seam added tomorrow is
// covered tomorrow; a hand-written list would silently stop covering what it did not mention.
const REPO = process.cwd()
const SCHEMA = require(join(REPO, 'orchestrations/scripts/lib/agent-output-schema.js'))
const TAGS: string[] = Object.keys(SCHEMA.TAG_TO_TOOL || {})

// The shapes a model really produces when it fails a contract. Prose is the observed one:
// the roster-specialiser answered "I need to create a valid JSON file. Let me fix the
// formatting:" on a paid run. The rest are the neighbouring ways a payload goes wrong.
const BAD_PAYLOADS: Array<[string, unknown]> = [
  ['prose instead of the artefact', 'I need to create a valid JSON file. Let me fix the formatting:'],
  ['null', null],
  ['a bare number', 42],
  ['an empty object', {}],
  ['an object of the wrong shape', { unrelated: 'field', nothing: 'expected' }],
]

describe('every schema-bound agent refuses a reply that breaks its contract', () => {
  it('the registry declares at least one tag — otherwise this suite is vacuous', () => {
    expect(TAGS.length, 'no tags found in agent-output-schema.js').toBeGreaterThan(0)
  })

  describe.each(TAGS)('%s', (tag) => {
    it.each(BAD_PAYLOADS)('refuses %s', (_label, payload) => {
      const v = SCHEMA.validateTaggedOutput(tag, payload)
      expect(v, `validateTaggedOutput returned nothing for ${tag}`).toBeTruthy()
      expect(v.ok, `${tag} ACCEPTED a payload that breaks its contract`).toBe(false)
      // A refusal that cannot be read is a refusal nobody can act on.
      expect(String(v.reason || ''), `${tag} refused without saying why`).not.toBe('')
    })
  })
})
