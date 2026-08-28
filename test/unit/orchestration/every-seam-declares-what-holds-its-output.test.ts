import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// EVERY SEAM, AND WHAT HOLDS ITS OUTPUT.
//
// A seam whose output nothing validates is a seam whose bad answer flows onward looking
// authoritative. That is not hypothetical: the roster-specialiser answered "I need to create a
// valid JSON file. Let me fix the formatting:" on a paid run, and only its artefact check
// stopped that prose becoming the identity every downstream agent reads.
//
// This file does not test the validators — the per-kind suites do. It tests that the MAP is
// complete and honest, so no seam can be added without someone deciding what holds its output.
const REPO = process.cwd()
const MAP = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/seam-output-contracts.json'), 'utf8'))
const PROFILES = JSON.parse(readFileSync(join(REPO, 'orchestrations/agents/invocation-profiles.json'), 'utf8'))
const SCHEMA = require(join(REPO, 'orchestrations/scripts/lib/agent-output-schema.js'))

const REAL = Object.keys(PROFILES.profiles).sort()
const MAPPED = Object.keys(MAP.seams).sort()

// The gap ratchet. This may only SHRINK: every entry is a place a bad answer flows unchecked.
const GAP_BASELINE = 11

describe('every seam declares what holds its output', () => {
  it('the registry is non-empty — otherwise every assertion here is vacuous', () => {
    expect(REAL.length).toBeGreaterThan(0)
  })

  it('every declared seam appears in the map', () => {
    const missing = REAL.filter(s => !MAPPED.includes(s))
    expect(missing, 'seams with no declared output contract — add them to '
      + 'config/seam-output-contracts.json and decide what holds their output').toEqual([])
  })

  it('the map names no seam that does not exist', () => {
    const stale = MAPPED.filter(s => !REAL.includes(s))
    expect(stale, 'the map names seams that are no longer declared — remove them').toEqual([])
  })

  it('every entry declares a known kind', () => {
    const kinds = Object.keys(MAP.$kinds)
    const bad = MAPPED.filter(s => !kinds.includes(MAP.seams[s].kind))
    expect(bad, `kind must be one of ${kinds.join(', ')}`).toEqual([])
  })

  it('every schema-bound seam names a tag the registry actually has', () => {
    const tags = Object.keys(SCHEMA.TAG_TO_TOOL || {})
    const bad = MAPPED
      .filter(s => MAP.seams[s].kind === 'schema')
      .filter(s => !tags.includes(MAP.seams[s].tag))
    expect(bad, 'these name a schema tag that agent-output-schema.js does not declare — the link '
      + 'would silently validate nothing').toEqual([])
  })

  it('THE GAP RATCHET: the number of seams with no contract only shrinks', () => {
    const gaps = MAPPED.filter(s => MAP.seams[s].kind === 'none')
    expect(gaps.length,
      `seams with NO output contract went up (was ${GAP_BASELINE}, now ${gaps.length}): `
      + `${gaps.join(', ')}. Every one is a place a bad answer flows on unchecked — give it a `
      + 'contract rather than raising this number.').toBeLessThanOrEqual(GAP_BASELINE)
  })
})
