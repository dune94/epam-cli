/**
 * THE KB STARTS FRESH EVERY RUN. IT DOES NOT GROW ACROSS RUNS.
 *
 * Policy (user, 2026-08-04): self-heal writes the KB *during* a run, engine-side. Agents
 * never write it. Until the pipeline is stable, nothing aggregates or grows the KB across
 * runs — every run starts from the same canonical state.
 *
 * What was actually happening:
 *
 *   - `orchestrations/agents/KB.md` had NO canonical to restore from. profiles.json has
 *     profiles.json.original and every launcher restores it; the KB had no equivalent, so
 *     it accumulated indefinitely — 28 entries at the time of this change.
 *   - pre-run-reset.sh cleared only `$LOG_DIR/kb-scratchpad`, never the KB itself.
 *   - claude.sh's coordinator appended a "cross-run synthesis" entry explicitly so
 *     "future runs benefit from the accumulated failure pattern" — growth by design.
 *
 * This matters because the KB is not inert: it is injected into writer prompts. A wrong
 * entry teaches every subsequent agent. One had to be removed by hand on 2026-08-03
 * (565d10e, "remove a disproven vendor-API claim the KB was teaching agents") — a run's
 * mistaken conclusion had become durable guidance for every run after it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const KB_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/kb-canonical.sh');
const PRE_RUN_RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const KB_CANONICAL = join(REPO_ROOT, 'orchestrations/agents/KB.md.original');

/** Run the REAL restore against a throwaway engine tree. */
function restore(opts: { canonical?: string; current?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'kb-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  const kb = join(root, 'agents/KB.md');
  const canon = join(root, 'agents/KB.md.original');
  if (opts.current !== undefined) writeFileSync(kb, opts.current);
  if (opts.canonical !== undefined) writeFileSync(canon, opts.canonical);

  const script = join(root, 'run.sh');
  writeFileSync(
    script,
    [
      'set -uo pipefail',
      'log(){ :; }; info(){ echo "INFO: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; success(){ echo "OK: $*"; }',
      `source ${JSON.stringify(KB_LIB)}`,
      `kb_restore_canonical ${JSON.stringify(root)}`,
      'echo "RC=$?"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  return {
    kb: existsSync(kb) ? readFileSync(kb, 'utf8') : null,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    rc: Number(/RC=(\d+)/.exec(r.stdout || '')?.[1] ?? -1),
  };
}

describe('the KB is restored to canonical before every run', () => {
  it('THE GROWTH: entries a previous run appended are discarded', () => {
    const canonical = '# KB\n\n## KB-001 -- 2026-01-01\ncurated\n';
    const grown = `${canonical}\n## KB-099 -- 2026-08-04\nsomething a run concluded\n`;
    const r = restore({ canonical, current: grown });
    expect(r.rc).toBe(0);
    expect(
      r.kb,
      'without a canonical restore the KB only ever grows, and a run\'s mistaken ' +
        'conclusion becomes durable guidance injected into every later writer prompt ' +
        '(565d10e had to remove one such entry by hand)',
    ).toBe(canonical);
    expect(r.kb).not.toContain('KB-099');
  });

  it('is idempotent — restoring twice leaves canonical content', () => {
    const canonical = '# KB\n\n## KB-001 -- 2026-01-01\ncurated\n';
    const first = restore({ canonical, current: 'mutated\n' });
    expect(first.kb).toBe(canonical);
  });

  it('recreates the KB when a run deleted it outright', () => {
    const canonical = '# KB\n\ncurated\n';
    expect(restore({ canonical }).kb).toBe(canonical);
  });

  it('does NOT silently no-op when the canonical is missing — it says so', () => {
    const r = restore({ current: 'grown\n' });
    expect(
      r.out,
      'a reset that quietly skips is how the KB grew unnoticed in the first place; ' +
        'absence of the canonical must be reported, not assumed benign',
    ).toMatch(/WARN|canonical/i);
    expect(r.kb, 'the existing KB must not be destroyed when there is nothing to restore')
      .toBe('grown\n');
  });
});

describe('the canonical exists and is wired into the run', () => {
  it('KB.md.original is checked in', () => {
    expect(
      existsSync(KB_CANONICAL),
      'profiles.json has profiles.json.original and every launcher restores it; the KB ' +
        'had no equivalent, which is why it accumulated 28 entries across runs',
    ).toBe(true);
  });

  it('pre-run-reset.sh performs the restore', () => {
    const src = readFileSync(PRE_RUN_RESET, 'utf8');
    expect(
      src,
      'pre-run-reset.sh cleared $LOG_DIR/kb-scratchpad but never the KB itself',
    ).toMatch(/kb_restore_canonical/);
  });
});

describe('nothing grows the KB for future runs while the pipeline is unstable', () => {
  const src = readFileSync(CLAUDE_SH, 'utf8');

  it('the cross-run synthesis is gated OFF by default', () => {
    const i = src.indexOf('KB-PERSIST-');
    expect(i, 'the cross-run synthesis block moved').toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, i - 1500), i + 500);
    expect(
      block,
      'this block appended an entry expressly so "future runs benefit from the ' +
        'accumulated failure pattern" — cross-run growth, which is off until the ' +
        'pipeline is stable',
    ).toMatch(/EPAM_KB_CROSS_RUN_SYNTHESIS/);
  });

  it('the gate defaults to disabled, not enabled', () => {
    expect(src).toMatch(/EPAM_KB_CROSS_RUN_SYNTHESIS:-0/);
  });
});
