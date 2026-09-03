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
  it('finds exactly the 17 seams the analysis verified by hand', () => {
    const r = run(ROOT);
    const lines = r.out.trim().split('\n').filter(Boolean);
    expect(lines.length, `found:\n${r.out}`).toBe(17);
  });

  it('names the worst three from the analysis: CPA_PROVIDER, STORY_PROVIDER:-codex, the assignment form', () => {
    const r = run(ROOT);
    expect(r.out).toMatch(/contextualize-stories\.sh:783\tCPA_PROVIDER\topenrouter/);
    expect(r.out).toMatch(/claude\.sh:1632\tSTORY_PROVIDER\tcodex/);
    expect(r.out).toMatch(/update-monitor\.sh:132\tPROVIDER\tclaude/);
  });

  it('never flags a binary-name default in the real tree', () => {
    const r = run(ROOT);
    expect(r.out).not.toMatch(/EPAM_CLI|CLAUDE_CMD|AI_RUNNER_CMD/);
  });
});
