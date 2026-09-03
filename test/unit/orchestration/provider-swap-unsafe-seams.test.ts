// A PROVIDER SEAM THAT DOES NOT DERIVE FROM THE ACTIVE SET.
//
// change-log/SEAM-CONSISTENCY-ANALYSIS.md (2026-09-03) found 17 seams across orchestrations/scripts
// that resolve a provider with `${SOME_PROVIDER:-openrouter}` and friends, none of which trace back
// to EPAM_PROVIDER_SET. A swap made because a provider ran out of tokens does not reach them — they
// keep calling the exhausted vendor. $spendProbeWhy in provider-sets.json records this exact class
// being found and fixed ONCE, in ten places across six launchers, and never generalised into a
// check — which is how it came back in 17 other places with nothing to catch it.
//
// These tests EXECUTE the scanner against fixtures on disk and assert on what it emits — a test
// that read the scanner source for a regex would pass on a comment.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCANNER = join(ROOT, 'orchestrations/scripts/lib/handlers/scan-provider-swap-unsafe.js');
const NODE = process.execPath;

function run(root: string): { status: number; out: string } {
  const r = spawnSync(NODE, [SCANNER, root], { encoding: 'utf8' });
  return { status: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

/** A repo-shaped fixture: the declared vendor list plus a scripts dir to scan. */
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'swap-unsafe-'));
  mkdirSync(join(d, 'orchestrations/config'), { recursive: true });
  mkdirSync(join(d, 'orchestrations/scripts'), { recursive: true });
  writeFileSync(join(d, 'orchestrations/config/providers.json'), JSON.stringify({
    known: ['openrouter', 'openai', 'codex', 'cursor', 'opencode', 'minimax', 'codemie-claude',
            'copilot', 'claude'],
  }));
  return d;
}

const write = (d: string, name: string, body: string) =>
  writeFileSync(join(d, 'orchestrations/scripts', name), body);

const writeExemptions = (d: string, exemptions: unknown[]) =>
  writeFileSync(join(d, 'orchestrations/config/provider-swap-exemptions.json'),
    JSON.stringify({ exemptions }));

describe('provider-swap-unsafe scanner', () => {
  it('flags a provider variable defaulting to a vendor literal', () => {
    const d = fixture();
    write(d, 'x.sh', '_base_provider="${SPEC_MODE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-openrouter}}"\n');
    const r = run(d);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/x\.sh:1\tSPEC_MODE_PROVIDER\topenrouter/);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags a case statement branching on a provider default', () => {
    const d = fixture();
    write(d, 'y.sh', 'case "${STORY_PROVIDER:-codex}" in\n');
    const r = run(d);
    expect(r.out).toMatch(/y\.sh:1\tSTORY_PROVIDER\tcodex/);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags the assignment-target form, where the defaulted value is positional', () => {
    // update-monitor.sh:132's actual shape: the vendor default sits on a positional parameter,
    // and the name that matters is the ASSIGNMENT TARGET, not anything inside ${}.
    const d = fixture();
    write(d, 'z.sh', '    PROVIDER="${5:-claude}"\n');
    const r = run(d);
    expect(r.out).toMatch(/z\.sh:1\tPROVIDER\tclaude/);
    rmSync(d, { recursive: true, force: true });
  });

  it('does NOT flag a binary-name default — EPAM_CLI:-epam is naming an executable', () => {
    const d = fixture();
    write(d, 'bin.sh', 'export EPAM_CLI="${EPAM_CLI:-epam}"\nexport CLAUDE_CMD="${CLAUDE_CMD:-claude}"\n');
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('does NOT flag a var that both contains PROVIDER and names an executable', () => {
    // The two real defaults (EPAM_CLI, CLAUDE_CMD) do not contain "PROVIDER", so the test above
    // never actually exercises isBinaryName() — the /PROVIDER/i filter excludes them first. This
    // is the case that DOES reach isBinaryName(): a hypothetical PROVIDER_CLI / PROVIDER_CMD var,
    // which the suffix check must still exclude even though the substring check alone would not.
    // Found via mutation testing: deleting isBinaryName() entirely left all 11 other tests green.
    const d = fixture();
    write(d, 'both.sh',
      'export PROVIDER_CLI="${PROVIDER_CLI:-claude}"\nexport MODEL_PROVIDER_CMD="${MODEL_PROVIDER_CMD:-openrouter}"\n');
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('does NOT flag an empty fallback — the swap-safe shape', () => {
    // llm-handler.sh's actual shape: fails loudly rather than guessing a vendor. Correct as
    // written, and must never be flagged alongside the 17 real defects.
    const d = fixture();
    write(d, 'safe.sh', 'local _set="${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"\n');
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('does NOT flag a default that is not a known vendor', () => {
    const d = fixture();
    write(d, 'other.sh', 'TIMEOUT_PROVIDER="${TIMEOUT_PROVIDER:-1200}"\n');
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('does NOT flag a commented-out line naming the defect', () => {
    const d = fixture();
    write(d, 'commented.sh', '# was STORY_PROVIDER="${STORY_PROVIDER:-codex}", fixed below\n');
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('does NOT flag a site matching a declared exemption exactly', () => {
    const d = fixture();
    write(d, 'free.sh', '\n\n\n\n\n\nFREE_PROVIDER="${FREE_PROVIDER:-openrouter}"\n'); // line 7
    writeExemptions(d, [{ file: 'orchestrations/scripts/free.sh', line: 7, var: 'FREE_PROVIDER', literal: 'openrouter', why: 'test' }]);
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });

  it('STILL FLAGS the same shape at a DIFFERENT line — an exemption is exact, never a filename blanket', () => {
    // The whole risk of an exemption list: it must not become "this file is exempt". A second,
    // genuinely new defect in the SAME file at a DIFFERENT line must still be caught.
    const d = fixture();
    write(d, 'free.sh', 'FREE_PROVIDER="${FREE_PROVIDER:-openrouter}"\nOTHER_PROVIDER="${OTHER_PROVIDER:-claude}"\n');
    writeExemptions(d, [{ file: 'orchestrations/scripts/free.sh', line: 1, var: 'FREE_PROVIDER', literal: 'openrouter', why: 'test' }]);
    const r = run(d);
    expect(r.out).toMatch(/free\.sh:2\tOTHER_PROVIDER\tclaude/);
    rmSync(d, { recursive: true, force: true });
  });

  it('STILL FLAGS the same variable at the exempted line if the LITERAL changed — exact-match, not line-only', () => {
    const d = fixture();
    write(d, 'free.sh', 'FREE_PROVIDER="${FREE_PROVIDER:-claude}"\n'); // literal changed from openrouter
    writeExemptions(d, [{ file: 'orchestrations/scripts/free.sh', line: 1, var: 'FREE_PROVIDER', literal: 'openrouter', why: 'test' }]);
    const r = run(d);
    expect(r.out).toMatch(/free\.sh:1\tFREE_PROVIDER\tclaude/);
    rmSync(d, { recursive: true, force: true });
  });

  it('treats a MISSING exemptions file as zero exemptions, not an error', () => {
    const d = fixture();
    write(d, 'x.sh', 'STORY_PROVIDER="${STORY_PROVIDER:-codex}"\n');
    const r = run(d); // no writeExemptions() call — file genuinely absent
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/x\.sh:1\tSTORY_PROVIDER\tcodex/);
    rmSync(d, { recursive: true, force: true });
  });

  it('reports nothing, not everything, when providers.json is absent', () => {
    // NO GUESSED VENDOR LIST. A tree that cannot declare its vendors cannot be judged by this
    // scanner — reporting nothing is correct, the same shape as testable-source.js refusing to
    // assume extensions.
    const d = mkdtempSync(join(tmpdir(), 'swap-unsafe-noconf-'));
    mkdirSync(join(d, 'orchestrations/scripts'), { recursive: true });
    writeFileSync(join(d, 'orchestrations/scripts/x.sh'),
      'STORY_PROVIDER="${STORY_PROVIDER:-codex}"\n');
    const r = run(d);
    expect(r.out.trim()).toBe('');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('provider-swap-unsafe scanner, against the real tree', () => {
  it('finds exactly 5 — every TIER 1 site fixed, plus CPA_PROVIDER (TIER 2) 2026-09-03', () => {
    // 17 by hand -> 16 excluding tier2-free-run.sh (not a defect) -> 12 after
    // run-agent-orchestration.sh's 4 ORCH_GATE_PROVIDER sites -> 8 after claude.sh's 4
    // STORY_PROVIDER sites -> 6 after tier3-skyscanner-app-run.sh and tier3-travel-app-run.sh's
    // EPAM_FINAL_FALLBACK_PROVIDER default (all TIER 1: epam run --provider and provider_to_cli()
    // both bypass EPAM_PROVIDER_SET entirely, confirmed by grep across src/) -> 5 after
    // contextualize-stories.sh's CPA_PROVIDER (TIER 2 — already re-validated downstream by
    // llm-handler.sh, but fixed anyway to remove the redundant, competing "openrouter" default).
    //
    // Fixing the TIER 1 group also surfaced and fixed a real regression risk in its own
    // mechanism: ladder-providers.js's routable-list computation never considered a set's
    // declared $credentials, only its runners — so under EPAM_PROVIDER_SET=openrouter (the
    // skyscanner/travel-app projects' real operating set), resolve_primary_provider() would have
    // SILENTLY SUBSTITUTED a correct, deliberate roster choice of aiProvider: "minimax" to
    // "claude", the opposite of what that mechanism exists to protect. See
    // ladder-providers-honours-credentials.test.ts.
    //
    // The CPA_PROVIDER fix ALSO caught a real bug in itself: the first version of the edit placed
    // an explanatory comment mid-way through a `\`-continued shell command. A `#` on a line inside
    // a continuation terminates it unless that comment line ALSO ends in `\` — bash -n cannot
    // catch this, because the result is still valid bash, just a DIFFERENT command (the pipe fed
    // a bare assignment instead of cpa-inference.js). Found by running the real test suite, not
    // by reading the diff: the-cpa-pass-gates-before-the-run.test.ts went from 19/20 to 15/20.
    //
    // The remaining 5 are TIER 2 (already re-validated by llm-handler.sh downstream:
    // SPEC_MODE_PROVIDER, EPAM_ORCHESTRATION_PROVIDER x3) or TIER 3 (update-monitor.sh —
    // dashboard display only, never routes a call).
    const r = run(ROOT);
    const lines = r.out.trim().split('\n').filter(Boolean);
    expect(lines.length, `found:\n${r.out}`).toBe(5);
  });

  it('no longer flags run-agent-orchestration.sh, claude.sh, the tier3 launchers, or contextualize-stories.sh', () => {
    const r = run(ROOT);
    expect(r.out).not.toMatch(/run-agent-orchestration\.sh/);
    expect(r.out).not.toMatch(/claude\.sh/);
    expect(r.out).not.toMatch(/tier3-skyscanner-app-run\.sh/);
    expect(r.out).not.toMatch(/tier3-travel-app-run\.sh/);
    expect(r.out).not.toMatch(/contextualize-stories\.sh/);
  });

  it('names what remains: the three EPAM_ORCHESTRATION_PROVIDER sites and the display-only one', () => {
    const r = run(ROOT);
    expect(r.out).toMatch(/code-review-cycle\.sh:137\tEPAM_ORCHESTRATION_PROVIDER\tclaude/);
    expect(r.out).toMatch(/team-lead-review\.sh:186\tEPAM_ORCHESTRATION_PROVIDER\tclaude/);
    expect(r.out).toMatch(/team-lead-review\.sh:195\tEPAM_ORCHESTRATION_PROVIDER\tclaude/);
    expect(r.out).toMatch(/update-monitor\.sh:132\tPROVIDER\tclaude/);
  });

  it('does NOT flag tier2-free-run.sh — a standalone free-tier test harness, not a real seam', () => {
    // change-log/SEAM-CONSISTENCY-ANALYSIS.md originally counted this among the 17; it does not
    // belong there. FREE_PROVIDER:-openrouter is the entire point of the script.
    const r = run(ROOT);
    expect(r.out).not.toMatch(/tier2-free-run\.sh/);
  });

  it('never flags a binary-name default in the real tree', () => {
    const r = run(ROOT);
    expect(r.out).not.toMatch(/EPAM_CLI|CLAUDE_CMD|AI_RUNNER_CMD/);
  });
});
