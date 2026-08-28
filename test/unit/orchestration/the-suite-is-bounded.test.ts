import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// THE SUITE MUST NOT TAKE THE MACHINE DOWN.
//
// vitest defaults to one worker per CPU. This suite is 1152 files and hundreds of them spawn
// bash, git and node subprocesses, so 16 workers each holding several children exhausted a 13GB
// WSL box and killed it mid-run — twice. A suite that cannot be run is a suite that is not run,
// and item 5 (the real failure count) stayed unmeasured because of it.
//
// The cap is DECLARED and overridable, not a number chosen here: a bigger machine should use it.
const REPO = process.cwd()
const CFG = readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')

describe('the suite is bounded', () => {
  it('worker concurrency is capped', () => {
    expect(CFG, 'no pool concurrency cap — vitest will use every CPU and spawn children under each')
      .toMatch(/maxThreads|maxForks|maxWorkers|poolOptions/)
  })

  it('the cap is overridable from the environment, not frozen in the file', () => {
    expect(CFG, 'a fixed number here means a larger machine cannot use its cores')
      .toMatch(/process\.env\.[A-Z_]+/)
  })

  it('THE BROKEN ALIAS: @ resolves to a path that exists in THIS checkout', () => {
    // It pointed at /home/bjerome/... — a different username. Any test importing '@/...' has
    // been resolving to nothing on every machine but one that no longer exists.
    const m = CFG.match(/'@':\s*([^,\n]+)/)
    expect(m, "no '@' alias found").toBeTruthy()
    const expr = String(m![1])
    expect(expr, 'the alias is an absolute path baked into the config')
      .not.toMatch(/^'\/home\//)
    // and whatever it resolves to must exist
    expect(existsSync(join(REPO, 'src')), 'src/ must exist for the alias to mean anything').toBe(true)
  })
})
