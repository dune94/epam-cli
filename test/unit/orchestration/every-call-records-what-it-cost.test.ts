import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// EVERY CALL RECORDS WHAT IT COST, AT THE ONE PLACE EVERY CALL PASSES THROUGH.
//
// Claude Code returns total_cost_usd, usage.input_tokens/output_tokens and num_turns in its JSON
// reply, and the handler already captures that JSON. Exactly ONE seam — team-lead-review — ever
// parsed it into a ledger record. The other 39 produced the numbers and nothing read them.
//
// That is why a 34-minute paid run on 2026-08-26 logged ZERO ledger entries, and why the spend
// for that incident still cannot be stated. Cost tracking is the stated first priority, and it
// was blind on the path that spends.
//
// Recorded by the handler, not by seams: a per-seam recorder is 40 places to forget.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib/cost-record.sh')

function record(replyJson: any, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'costrec-'))
  const ledger = join(dir, 'phase-cost.jsonl')
  const reply = join(dir, 'reply.json')
  writeFileSync(reply, JSON.stringify(replyJson))
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; record_call_cost ${JSON.stringify(reply)} "team-lead-review" "S-1" "claude-sonnet-5" "2026-08-26T00:00:00+00:00"`],
    { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PHASE_COST_FILE: ledger, CURRENT_PHASE: 'core', ...env } })
  const lines = existsSync(ledger)
    ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []
  rmSync(dir, { recursive: true, force: true })
  return { lines, stderr: r.stderr, status: r.status }
}

describe('every call records what it cost', () => {
  it('the recorder exists as a library, not inside one launcher', () => {
    expect(existsSync(LIB), 'lib/cost-record.sh must exist so the handler can call it').toBe(true)
  })

  it("EXECUTED: a Claude reply's cost, tokens and turns land in the ledger", () => {
    const { lines, stderr } = record({
      total_cost_usd: 0.0421, num_turns: 7,
      usage: { input_tokens: 12345, output_tokens: 678 },
    })
    expect(lines.length, `no record written. stderr: ${stderr}`).toBe(1)
    const rec = lines[0]
    expect(rec.task_cost_usd).toBe(0.0421)
    expect(rec.task_tokens_in).toBe(12345)
    expect(rec.task_tokens_out).toBe(678)
    expect(rec.task_turns).toBe(7)
    expect(rec.agent_type).toBe('team-lead-review')
    expect(rec.resolvedModel).toBe('claude-sonnet-5')
    expect(rec.phase_id).toBe('core')
  })

  it('the camelCase spelling is accepted too — vendors differ', () => {
    const { lines } = record({ cost_usd: 0.01, usage: { inputTokens: 5, outputTokens: 6 }, turns: 2 })
    expect(lines[0].task_tokens_in).toBe(5)
    expect(lines[0].task_tokens_out).toBe(6)
  })

  it('A MISSING COST IS NOT A ZERO COST — an unreadable reply records nothing', () => {
    // Writing 0 would put a free call in the ledger and make a run look cheaper than it was.
    // "We could not tell" and "it cost nothing" are different answers.
    const { lines } = record('this is prose, not a reply object' as any)
    expect(lines.length, 'an unparseable reply was recorded as a zero-cost call').toBe(0)
  })

  it('a reply with no cost field records nothing rather than a false zero', () => {
    const { lines } = record({ result: 'OK', is_error: false })
    expect(lines.length).toBe(0)
  })
})

// THE RECEIVER: the handler itself, not the library in isolation.
//
// A library that records correctly and is never called records nothing — which is precisely the
// state this work found: team-lead-review called it, 39 seams did not.
describe('the handler records the cost of a call it just made', () => {
  const HUB = join(REPO, 'orchestrations/scripts/llm-handler.sh')

  it('EXECUTED: a successful call lands one ledger record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubcost-'))
    const ledger = join(dir, 'phase-cost.jsonl')
    const stub = join(dir, 'claude')
    // a stub vendor CLI that answers in Claude Code's JSON shape
    // The handler runs a PLAN pass and an EXECUTE pass and merges their costs. The stub answers
    // differently for each, so the ledger figure proves the merge rather than hiding it behind
    // two identical numbers.
    writeFileSync(stub, [
      '#!/usr/bin/env bash',
      'cat > /dev/null',
      'if [ "${_EPAM_IN_PLAN_PASS:-0}" = "1" ]; then',
      `  echo '${JSON.stringify({ result: 'PLAN', is_error: false, total_cost_usd: 0.0100, num_turns: 1, usage: { input_tokens: 100, output_tokens: 10 } })}'`,
      'else',
      `  echo '${JSON.stringify({ result: 'OK', is_error: false, total_cost_usd: 0.0137, num_turns: 3, usage: { input_tokens: 900, output_tokens: 120 } })}'`,
      'fi',
    ].join('\n') + '\n')
    spawnSync('chmod', ['+x', stub])

    const r = spawnSync('bash', [HUB, '--provider', 'claude', '--model', 'claude-sonnet-5'], {
      encoding: 'utf8', input: 'hello', timeout: 40000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CLAUDE_CMD: stub,
        ORCH_JSON_RESULT: join(dir, 'result.json'),
        PHASE_COST_FILE: ledger,
        CURRENT_PHASE: 'core',
        EPAM_AGENT_NAME: 'spec-agent',
        EPAM_STORY_ID: 'S-9',
        ANTHROPIC_API_KEY: 'sk-mock-not-real',
      },
    })

    const lines = existsSync(ledger)
      ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : []
    rmSync(dir, { recursive: true, force: true })

    // ONE record for the whole call — a plan and its execute pass are one call to the ledger.
    expect(lines.length, `expected exactly one record. rc=${r.status} stderr: ${(r.stderr || '').slice(0, 400)}`).toBe(1)
    // ...carrying the MERGED cost. Recording only the execute pass would under-report every
    // planned seam by the cost of its plan.
    expect(lines[0].task_cost_usd).toBeCloseTo(0.0237, 6)
    expect(lines[0].agent_type, 'the record must name the seam that spent it').toBe('spec-agent')
    expect(lines[0].story_id).toBe('S-9')
  })

  // A HOT SWAP THAT LOSES COST TRACKING IS NOT A HOT SWAP.
  //
  // The codemie arm ran `--output-format text` and captured no JSON at all, so swapping stacks
  // silently swapped cost visibility off with it. The wrapper runs Claude Code underneath and
  // answers in the same shape, so there is no reason for the two arms to differ.
  it('EXECUTED: the codemie arm records cost the same as the claude arm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubcost-cm-'))
    const ledger = join(dir, 'phase-cost.jsonl')
    const stub = join(dir, 'codemie-claude')
    writeFileSync(stub, [
      '#!/usr/bin/env bash',
      'cat > /dev/null',
      'if [ "${_EPAM_IN_PLAN_PASS:-0}" = "1" ]; then',
      `  echo '${JSON.stringify({ result: 'PLAN', is_error: false, total_cost_usd: 0.02, num_turns: 1, usage: { input_tokens: 10, output_tokens: 2 } })}'`,
      'else',
      `  echo '${JSON.stringify({ result: 'OK', is_error: false, total_cost_usd: 0.05, num_turns: 4, usage: { input_tokens: 700, output_tokens: 90 } })}'`,
      'fi',
    ].join('\n') + '\n')
    spawnSync('chmod', ['+x', stub])

    const r = spawnSync('bash', [HUB, '--provider', 'codemie-claude', '--model', 'claude-sonnet-5'], {
      encoding: 'utf8', input: 'hello', timeout: 40000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ORCH_JSON_RESULT: join(dir, 'result.json'),
        PHASE_COST_FILE: ledger,
        CURRENT_PHASE: 'core',
        EPAM_AGENT_NAME: 'spec-agent',
        EPAM_STORY_ID: 'S-7',
      },
    })

    const lines = existsSync(ledger)
      ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : []
    rmSync(dir, { recursive: true, force: true })

    expect(lines.length, `codemie recorded nothing. rc=${r.status} stderr: ${(r.stderr || '').slice(0, 400)}`).toBe(1)
    expect(lines[0].task_cost_usd, 'plan + execute must be merged, as on the claude arm').toBeCloseTo(0.07, 6)
    expect(lines[0].agent_type).toBe('spec-agent')
  })
})
