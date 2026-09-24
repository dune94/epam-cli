/**
 * THE ESCALATION MACHINERY, LIFTED WHOLE — one list, for every test that drives it.
 *
 * Four harnesses each lifted their own subset of model-ladder.sh's escalation functions. Every time
 * the machinery gained a helper (the branch name, then the snapshot and the owned-path filter), the
 * harnesses that did not list it called a function that did not exist — and the calls degraded
 * silently: no worktree, the fix in the main tree, and the tests still passed (2026-09-24, twice).
 * A harness takes THIS, so a new helper is added once.
 */
import { join } from 'node:path';
import { shellFunction } from './engine-source';

const LIB = join(__dirname, '../../orchestrations/scripts/lib');
const LADDER = join(LIB, 'model-ladder.sh');

/** Every function resolve_escalation reaches, in model-ladder.sh, plus the engine paths it reads. */
export function escalationMachinery(): string {
  return [
    `. ${JSON.stringify(join(LIB, 'engine-paths.sh'))}`,
    // the brief's values are built by the engine's own jq_vals — without it the brief renders empty
    `. ${JSON.stringify(join(LIB, 'jq-vals.sh'))}`,
    ...[
      '_escalation_vendor_names', '_escalation_owned_paths', '_escalation_base_snapshot',
      '_escalation_branch', '_escalation_worktree', '_escalation_adopt_work', '_escalation_adopt_owned_status',
      'resolve_escalation',
    ].map((n) => shellFunction(LADDER, n)),
  ].join('\n');
}
