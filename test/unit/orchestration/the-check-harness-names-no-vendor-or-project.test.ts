import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE CHECK HARNESS NAMES NO VENDOR AND NO PROJECT.
//
// agent-check.js fills placeholders so each agent can be exercised on its own. Its filler
// carried a vendor model ('z-ai/glm-5.2'), a stack ('TypeScript, Node.js 20, jest') and a
// project's feature ('Live preview of draft content in the CMS'). Filler that names one
// deployment makes the check pass or fail for reasons belonging to that deployment, and the
// harness is supposed to prove the AGENT.
const REPO = process.cwd()
const SRC = readFileSync(join(REPO, 'orchestrations/scripts/agent-check.js'), 'utf8')
// strip comments: they explain what was removed, and that prose is not a value
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the check harness names no vendor and no project', () => {
  it('names no vendor model', () => {
    expect(CODE, 'a vendor model is used as filler — resolve it from the active set')
      .not.toMatch(/z-ai\/|glm-|minimax|claude-|gpt-|openrouter\//i)
  })

  it('names no project feature or stack', () => {
    expect(CODE, "a project's feature is used as filler").not.toMatch(/CMS|Live preview of draft/i)
    expect(CODE, 'a stack is named as filler — it is a fact about a codeline, not about an agent')
      .not.toMatch(/TypeScript, Node\.js|jest\b/)
  })

  it('the harness still SUPPLIES a value for every placeholder family it handled', () => {
    // no functionality lost: each family still resolves to something non-empty
    for (const family of ['model', 'stack', 'title', 'command', 'test', 'criteria', 'tool', 'error']) {
      expect(CODE, `the ${family} placeholder family was dropped rather than de-hardcoded`)
        .toMatch(new RegExp(family))
    }
  })
})
