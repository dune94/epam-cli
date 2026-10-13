/**
 * A SPEC-GATE FAILURE REACHES THE REMEDIATOR.
 *
 * AMSD-2974 run 9, resumes 10 and 11 (2026-10-13): the 7.x back-port's spec validator found a criterion UNMET; the gate
 * failed and its self-heal said "[gate-finding-analyst] No grounded finding for spec-validator — skipping remediation".
 * The analyst's prompt expects BLOCKER findings (file/line/rule/message/suggestedFix) and answered
 * {"gate": "spec-validator", "story_id": null, "error": "no grounded finding"}; the git fallback looks for "file" fields; a
 * spec-validator log is a criteria report naming its story by storyId. So a spec failure never reached
 * story-ac-remediator, the gates returned 1 instead of 2 ("remediated, retry"), and the lane HALTED — twice.
 *
 * EXECUTED: the remediation loop's own attribution lines (lib/gates-testing.sh, from "Check analyst returned a
 * grounded finding" to "Finding mapped to story"), with the real _gate_attribute_from_log, story-id.py and
 * spec-unmet-finding.py, fed the analyst's ACTUAL answer from resume 11. Asserted: the story id and finding the loop
 * then hands to story-ac-remediator — or that it skips. NEGATIVES: nothing unmet → skipped; another gate → untouched.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const FX = join(__dirname, '../../fixtures/spec-validator');
const GT = readFileSync(join(S, 'lib/gates-testing.sh'), 'utf8');
const FN = shellFunction(join(S, 'lib/gates-testing.sh'), '_gate_attribute_from_log');
/** The loop's attribution, from its first check to the line that names the story it will remediate. */
const ATTRIBUTION = (() => {
  const a = GT.indexOf('                # Check analyst returned a grounded finding');
  const b = GT.indexOf('                info "  [gate-finding-analyst] Finding mapped to story: ${_story_id}"');
  if (a < 0 || b < 0) throw new Error('the remediation loop\'s attribution was not found — the harness is stale');
  return GT.slice(a, b);
})();
const ANALYST_ANSWER_RESUME_11 = 'No line in the log matches the expected BLOCKER finding structure.\n```json\n{"gate": "spec-validator", "story_id": null, "error": "no grounded finding"}\n```';

function attribute(label: string, log: string) {
  const d = mkdtempSync(join(tmpdir(), 'gate-rem-'));
  const script = [
    'set -uo pipefail', `SCRIPT_DIR=${JSON.stringify(S)}`, `PROJECT_ROOT=${JSON.stringify(d)}`,
    'info(){ :; }; warning(){ printf "WARN %s\\n" "$*"; }',
    FN,
    `_glabel=${JSON.stringify(label)}; _glog=${JSON.stringify(log)}; _rem_log=${JSON.stringify(join(d, 'rem.log'))}`,
    'gate_loop() { local _finding_json="$ANALYST_ANSWER"; for _once in 1; do', ATTRIBUTION, 'printf "STORY=%s\\n" "$_story_id"; printf "FINDING=%s\\n" "$_finding_json"; done; }',
    'gate_loop', 'printf "END\\n"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH || '', ANALYST_ANSWER: ANALYST_ANSWER_RESUME_11 } });
  const out = `${r.stdout}${r.stderr}`;
  return { out, story: (out.match(/^STORY=(.*)$/m) || [])[1], finding: (out.match(/^FINDING=(.*)$/m) || [])[1], skipped: /No grounded finding/.test(out) };
}

describe('a spec-gate failure reaches the remediator', () => {
  it('the analyst grounds nothing, the validator\'s log names the story and its UNMET criterion → the loop remediates that story', () => {
    const r = attribute('spec-validator', join(FX, 'one-unmet.txt'));
    expect(r.skipped, r.out).toBe(false);
    expect(r.story).toBe('S-1');
    const f = JSON.parse(r.finding!);
    expect(f.unmet_criteria.map((c: { criterion: string }) => c.criterion)).toEqual(['criterion 3']);
    expect(f.unmet_criteria[0].gaps).toBe('gaps 3');
  });

  it('NEGATIVE: nothing unmet → the loop skips, as before', () => {
    const r = attribute('spec-validator', join(FX, 'none-unmet.txt'));
    expect(r.skipped, r.out).toBe(true);
    expect(r.out).toContain('END');
  });

  it('NEGATIVE: another gate\'s log is not read as a criteria report', () => {
    const d = mkdtempSync(join(tmpdir(), 'gate-log-'));
    const log = join(d, 'sast.log');
    writeFileSync(log, '{"blockers":[{"file":"src/nowhere.ts","line":3,"rule":"x","message":"m"}]}');
    expect(attribute('sast-sentinel', log).skipped).toBe(true);
  });
});
