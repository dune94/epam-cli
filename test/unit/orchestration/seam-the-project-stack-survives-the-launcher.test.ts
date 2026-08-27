/**
 * SEAM: LAUNCHER → ORCHESTRATOR. THE STACK THE OPERATOR CHOSE MUST REACH THE RUN.
 *
 * A launcher resolves the project config dir; run-agent-orchestration.sh then loads the repo .env
 * in preserve mode. Preserve means the FIRST value wins — so if the launcher never read the
 * project's own env, .env's stale defaults win and the run executes on a stack nobody selected.
 *
 * tier3-mock-run.sh did exactly that. mock3 run 2, launched with EPAM_PROVIDER_SET=claude, reached
 * estate-survey on provider 'qwen' (from .env line 20), failed three attempts on a ladder it should
 * never have been on, and aborted. Every log line looked configured.
 *
 * It is also the shape of the 2026-08-25 unapproved spend: a run told to use MockServer called the
 * real API, because .env won. preserve-by-default fixed the ORDER; it cannot help when the
 * project's files are never read at all.
 *
 * Both halves are asserted: every project-based launcher READS the project env, and the resulting
 * precedence actually puts the project's stack ahead of .env.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const SCRIPTS = join(ROOT, 'orchestrations/scripts')
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Launchers that resolve a PROJECT — those are the ones whose env must reach the run. */
function projectLaunchers(): string[] {
  return readdirSync(SCRIPTS)
    .filter((f) => /^(tier3-.*|orchestrate)\.sh$/.test(f))
    .filter((f) => {
      const src = readFileSync(join(SCRIPTS, f), 'utf8')
      return /EPAM_PROJECT_CONFIG_DIR=|project_config_dir|PROJECT_DIR=/.test(src)
    })
}

describe('seam: the project stack survives the launcher', () => {
  it('there are project launchers to check — otherwise this asserts nothing', () => {
    expect(projectLaunchers().length).toBeGreaterThan(2)
  })

  it('THE DEFECT: every project launcher reads the project env', () => {
    const blind = projectLaunchers().filter((f) => {
      const src = readFileSync(join(SCRIPTS, f), 'utf8')
      // Either it loads the project env itself, or it delegates to something that does.
      return !/load_project_env/.test(src) && !/orchestrate\.sh/.test(src)
    })
    expect(blind,
      `these resolve a project config dir and never read what is inside it, so .env's stale `
      + 'defaults decide the stack: ' + blind.join(', ')).toEqual([])
  })

  it('THE PRECEDENCE: the project overlay beats the repo .env', () => {
    // Driven through the REAL loader, with a real .env-shaped file that disagrees.
    const proj = mkdtempSync(join(tmpdir(), 'seam-stack-')); dirs.push(proj)
    mkdirSync(join(proj, 'prompts'), { recursive: true })
    writeFileSync(join(proj, 'config.env'), 'PROJECT_NAME=probe\n')
    writeFileSync(join(proj, 'config.claude.env'), 'EPAM_ORCHESTRATION_PROVIDER=claude\n')
    writeFileSync(join(proj, 'llm-settings.json'), '{}')
    const fakeEnv = join(proj, 'repo.env')
    writeFileSync(fakeEnv, 'EPAM_ORCHESTRATION_PROVIDER=qwen\n')

    const out = spawnSync('bash', ['-c',
      `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; . ${JSON.stringify(join(SCRIPTS, 'lib/env-file.sh'))}; `
      + 'export EPAM_PROVIDER_SET=claude; '
      + `export NODE_BIN=${JSON.stringify(NODE_BIN)}; `
      + `load_project_env ${JSON.stringify(proj)} preserve >/dev/null 2>&1; `
      + `load_env_file_safe ${JSON.stringify(fakeEnv)} preserve; `
      + 'printf "%s" "${EPAM_ORCHESTRATION_PROVIDER:-UNSET}"'], { encoding: 'utf8' })

    expect(out.stdout,
      'the repo .env overrode the stack the operator selected — this is the run-2 defect and the '
      + 'shape of the 2026-08-25 unapproved spend').toBe('claude')
  })

  it('and the reverse order would NOT save it — preserve means first-wins', () => {
    // States why reading the project env is required rather than merely tidy: if .env is loaded
    // first, its value survives preserve and the project's overlay is ignored.
    const proj = mkdtempSync(join(tmpdir(), 'seam-order-')); dirs.push(proj)
    writeFileSync(join(proj, 'a.env'), 'X=from-dot-env\n')
    writeFileSync(join(proj, 'b.env'), 'X=from-project\n')
    const out = spawnSync('bash', ['-c',
      `. ${JSON.stringify(join(SCRIPTS, 'lib/env-file.sh'))}; `
      + `load_env_file_safe ${JSON.stringify(join(proj, 'a.env'))} preserve; `
      + `load_env_file_safe ${JSON.stringify(join(proj, 'b.env'))} preserve; `
      + 'printf "%s" "$X"'], { encoding: 'utf8' })
    expect(out.stdout, 'preserve is not first-wins — the reasoning behind this seam is wrong').toBe('from-dot-env')
  })
})
