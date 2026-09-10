/**
 * THREE EXIT TRAPS, ONE SURVIVOR — AND THE SURVIVOR WAS NOT THE ONE THAT MATTERED.
 *
 * bash keeps exactly ONE EXIT trap. `trap X EXIT` does not add a handler, it REPLACES the handler.
 * run-agent-orchestration.sh registers three, in file order:
 *
 *     line   31  trap '_release_write_perimeter' EXIT
 *     line 4162  trap cleanup EXIT                          <- worktree cleanup + cassette export
 *     line 4923  trap 'kill "$_HEARTBEAT_PID" ...' EXIT     <- discards cleanup entirely
 *
 * So on every run that reaches the heartbeat, `cleanup` never executes: no worktree cleanup, no
 * cassette export, and NO OUTPUT AT ALL — the silence is what made it invisible.
 *
 * Found live on 2026-09-10, openrouter run 20260910T222155Z. The run paused before the writer,
 * reported "Pipeline complete", and archived no cassette. cleanup() produced not one line, though
 * export_run_cassette announces every outcome by design.
 *
 * This defeated the fix committed that same morning (1f653762), whose own comment claimed
 * "`trap ... EXIT` fires on every exit path bash controls, including ones added later, so this
 * cannot be forgotten by whoever writes the next `exit`". The next `trap ... EXIT` in the same file
 * had already deleted it. The tests passed because the harness registered ONE trap; the script
 * registers three.
 *
 * The fix is not "move the export again". It is that registering an exit handler must ADD, never
 * REPLACE — proven here by driving the real script's own registration lines.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

/**
 * Every exit-handler registration the real script makes, in file order — whether it registers with
 * a bare `trap ... EXIT` (the defect) or through add_exit_handler (the fix). Driving BOTH forms is
 * what lets this test fail before the fix and pass after it, against the real file either way.
 */
function exitTrapLines(): { line: number; text: string }[] {
  return readFileSync(ORCH, 'utf8').split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => /^trap\s+.*\bEXIT\b/.test(text) || /^add_exit_handler\s+\S/.test(text));
}

describe('an exit handler is added, never replaced', () => {
  it('the script really does register more than one EXIT trap', () => {
    const traps = exitTrapLines();
    expect(traps.length, `only ${traps.length} EXIT trap(s) — this test is stale`).toBeGreaterThan(1);
    // The one that carries the cassette export must be among them.
    expect(traps.some((t) => /cleanup/.test(t.text)),
      'no EXIT trap registers cleanup — the export has moved again').toBe(true);
  });

  /**
   * THE DEFECT, EXECUTED. Drives the real registration lines in the real order against stub
   * handlers, then exits. Every registered handler must run. Today only the last one does.
   */
  it('every registered handler runs at exit — not just the last one', () => {
    const d = mkdtempSync(join(tmpdir(), 'exittrap-'));
    const marker = join(d, 'fired');
    const script = join(d, 'h.sh');

    const traps = exitTrapLines().map((t) => t.text);
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
MARK="${marker}"
source "${join(ROOT, 'orchestrations/scripts/lib/exit-handlers.sh')}"
_release_write_perimeter(){ echo perimeter >> "$MARK"; }
cleanup(){ echo cleanup >> "$MARK"; }
_HEARTBEAT_PID=""
_epam_kill_heartbeat(){ echo heartbeat >> "$MARK"; }
kill(){ echo heartbeat >> "$MARK"; }

${traps.join('\n')}

exit 0
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
    const fired = existsSync(marker)
      ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [];
    rmSync(d, { recursive: true, force: true });

    expect(fired, `only these handlers ran: [${fired.join(', ')}] — stderr: ${r.stderr.slice(0, 200)}. ` +
      'bash keeps ONE EXIT trap, so each `trap ... EXIT` discards the previous handler and the ' +
      'cassette export never runs.').toContain('cleanup');
  });

  it('and the perimeter release survives too — it was registered first', () => {
    const d = mkdtempSync(join(tmpdir(), 'exittrap2-'));
    const marker = join(d, 'fired');
    const script = join(d, 'h.sh');
    const traps = exitTrapLines().map((t) => t.text);
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
MARK="${marker}"
source "${join(ROOT, 'orchestrations/scripts/lib/exit-handlers.sh')}"
_release_write_perimeter(){ echo perimeter >> "$MARK"; }
cleanup(){ echo cleanup >> "$MARK"; }
_HEARTBEAT_PID=""
_epam_kill_heartbeat(){ echo heartbeat >> "$MARK"; }
kill(){ echo heartbeat >> "$MARK"; }
${traps.join('\n')}
exit 0
`);
    spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
    const fired = existsSync(marker)
      ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [];
    rmSync(d, { recursive: true, force: true });
    expect(fired, `handlers that ran: [${fired.join(', ')}]`).toContain('perimeter');
  });
});
