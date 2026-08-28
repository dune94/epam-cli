import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A NUMBER THAT DECIDES POLICY IS DECLARED.
//
// Three constants decided how the pipeline behaves and lived in code:
//   - the AC count above which a story MUST be split
//   - how much evidence the detective is pre-seeded with
//   - how much of the codebase a retrieval call may read
//
// Naming a constant is not the same as declaring it. `const SPLIT_MANDATE_AC_THRESHOLD = 12`
// reads like configuration and is not: changing it is a code edit, a rebuild and a review, and
// nothing in the deployment can differ. These are operating decisions about a codeline, and a
// project with larger stories has a different right answer.
const REPO = process.cwd()
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js')
const CFG = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/spec-mode-defaults.json'), 'utf8'))
const spec = require(RUNNER)
const CODE = readFileSync(RUNNER, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('a number that decides policy is declared', () => {
  it('spec-mode-defaults declares the policy block', () => {
    expect(CFG.policy, 'no policy block declared').toBeTruthy()
    for (const k of ['splitMandateAcThreshold', 'detectivePreseedMaxChars']) {
      expect(Number.isFinite(CFG.policy[k]), `policy.${k} must be declared`).toBe(true)
      expect(CFG.policy[k], `policy.${k} must be positive`).toBeGreaterThan(0)
    }
  })

  it('the retrieval read caps are declared', () => {
    for (const k of ['maxFiles', 'maxChars']) {
      expect(Number.isFinite(CFG.retrieval[k]), `retrieval.${k} must be declared`).toBe(true)
      expect(CFG.retrieval[k]).toBeGreaterThan(0)
    }
  })

  it('THE INVARIANT: the engine holds no literal for these', () => {
    expect(CODE, 'the split threshold is still a literal').not.toMatch(/SPLIT_MANDATE_AC_THRESHOLD\s*=\s*\d/)
    expect(CODE, 'the preseed cap is still a literal').not.toMatch(/DETECTIVE_PRESEED_MAX_CHARS\s*=\s*\d/)
    expect(CODE, 'the retrieval read caps are still literals').not.toMatch(/maxFiles:\s*\d+,\s*maxChars:\s*\d+/)
  })

  it('EXECUTED: the declared threshold is the one that decides a split', () => {
    const t = CFG.policy.splitMandateAcThreshold
    const story = (n: number) => ({ id: 'S', title: 't', acceptanceCriteria: Array.from({ length: n }, (_, i) => `AC${i}`) })
    expect(spec.splitIsMandated(story(t + 1)).required, `${t + 1} ACs must mandate a split`).toBe(true)
    expect(spec.splitIsMandated(story(t)).required, `${t} ACs must NOT mandate a split`).toBe(false)
  })

  it('the exported threshold matches the declaration — one source, not two', () => {
    expect(spec.SPLIT_MANDATE_AC_THRESHOLD).toBe(CFG.policy.splitMandateAcThreshold)
  })
})
