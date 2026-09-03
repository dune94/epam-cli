/**
 * THE ORCHESTRATOR'S CODE, ASSEMBLED THE WAY BASH ASSEMBLES IT.
 *
 * run-agent-orchestration.sh was 11,213 lines with 2,625 top-level statements and no main(), so
 * sourcing it to reach one function ran the whole pipeline and nothing in it could be tested. The
 * remedy is to lift functions into lib/ — run_orch_prompt, then the gate verdict logic — and each
 * time that happens, every test that scans the orchestrator's TEXT goes red while the shipped
 * behaviour is unchanged.
 *
 * Naively concatenating the libs at the END is not good enough, and one test proved it: an
 * assertion requiring RETRY text to appear before `new_acs` passed before the extraction and
 * failed after, because the RETRY text had moved into a file appended below. Order is part of what
 * these tests check.
 *
 * So each lib is spliced in AT ITS SOURCE LINE, which is where bash puts it. The result reads like
 * the file did before anything moved, and an ordering assertion means what it always meant.
 *
 * EXTRACTED_LIBS is deliberately explicit rather than "every file in lib/": most libs were always
 * libraries and have nothing to do with the orchestrator's own logic. Only the ones lifted OUT of
 * it belong in this view, and a new extraction adds one line.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
export const ORCHESTRATOR = join(SCRIPTS, 'run-agent-orchestration.sh');

/** Libraries carved out of run-agent-orchestration.sh, in the order they were extracted. */
export const EXTRACTED_LIBS = [
  join(SCRIPTS, 'lib/orch-prompt.sh'),    // run_orch_prompt
  join(SCRIPTS, 'lib/gate-verdicts.sh'),  // runtime_boundary_verdict, _run_qa_gate_with_retry
  join(SCRIPTS, 'lib/halt-recovery.sh'),  // _halt_recovery_state
];

/**
 * The orchestrator's shipped code with every extracted lib spliced in where it is sourced —
 * the text bash effectively executes.
 */
export function orchestratorSource(): string {
  let src = readFileSync(ORCHESTRATOR, 'utf8');

  for (const lib of EXTRACTED_LIBS) {
    const name = basename(lib);
    const body = readFileSync(lib, 'utf8');
    // The line the orchestrator uses to pull this lib in, however it is spelled.
    const sourceLine = src
      .split('\n')
      .find((l) => /^\s*\.\s+/.test(l) && l.includes(name));
    if (sourceLine) src = src.replace(sourceLine, body);
    else src = `${src}\n${body}`;   // not sourced yet: still part of the shipped code
  }
  return src;
}
