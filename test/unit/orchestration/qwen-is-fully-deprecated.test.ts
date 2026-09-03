/**
 * THE WORD DOES NOT APPEAR IN ANYTHING THIS PROJECT AUTHORS.
 *
 * Not as a provider, not as a model id, not in a comment, not in a config value. OpenRouter
 * replaced it completely. Anything less is a partial state, and a partial state is what made the
 * operator's instruction impossible to follow: the dispatch accepted only the old name and
 * rejected openrouter, so a run launched as asked died at startup.
 *
 * ONE THING IS OUT OF SCOPE, DELIBERATELY: preserved run evidence.
 *
 *   orchestrations/projects/<project>/runs/<TIMESTAMP>Z/...
 *
 * Those directories record what a past run actually said and did. Editing them to satisfy a
 * present-day rename would make the record disagree with the run — a rename is a change to what
 * this project writes NEXT, never to what a completed run already emitted. They are chmod 444 for
 * exactly that reason.
 *
 * So the exclusion has to be narrow, or it becomes a hiding place. Three properties hold it shut:
 * the scan is proven to reach the live tree (no vacuous pass), everything excluded is proven to sit
 * inside a timestamped run directory, and nothing the project authors is excluded at all.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');

/** A completed run's own output: <project>/runs/<TIMESTAMP>Z/ and everything beneath it. */
const PRESERVED_RUN_EVIDENCE = /(^|\/)projects\/[^/]+\/runs\/\d{8}T\d{6}Z\//;

/** Every occurrence of a word in the working tree, excluding history and third-party code. */
function occurrences(word: string): string[] {
  try {
    const out = execFileSync('grep', [
      '-rniI', word, '.',
      '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=logs',
      '--exclude-dir=dist', '--exclude-dir=.venv-deepeval', '--exclude-dir=reports',
      '--exclude=qwen-is-fully-deprecated.test.ts',
    ], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean);
  } catch (e: any) {
    // grep exits 1 when it finds nothing, which is the outcome this test wants.
    if (e && e.status === 1) return [];
    throw e;
  }
}

const found = occurrences('qwen');
const authored = found.filter((l) => !PRESERVED_RUN_EVIDENCE.test(l));
const evidence = found.filter((l) => PRESERVED_RUN_EVIDENCE.test(l));

describe('the word qwen does not appear in anything this project authors', () => {
  it('the scan reaches the live tree, so a clean result means something', () => {
    // Without this, deleting the source tree would turn every assertion below green. The
    // replacement name must be findable in the code that does the replacing.
    const live = occurrences('openrouter')
      .filter((l) => /^\.\/(src|orchestrations\/(scripts|config|agents))\//.test(l));
    expect(live.length, 'the scan found no openrouter in the live tree — it is not reaching the '
      + 'code at all, so a clean qwen result proves nothing').toBeGreaterThan(10);
  }, 120_000);

  it('grep finds nothing in anything the project authors', () => {
    expect(authored, `${authored.length} occurrence(s) remain:\n${authored.slice(0, 25).join('\n')}`)
      .toEqual([]);
  }, 120_000);

  it('everything excluded is inside a timestamped run directory, and nothing else is', () => {
    // The exclusion is a hiding place the moment it covers a path a person edits. Re-derive it from
    // the path itself rather than trusting the partition above.
    for (const line of evidence) {
      const path = line.slice(0, line.indexOf(':'));
      expect(path, `${path} is excluded but is not preserved run evidence`)
        .toMatch(/^\.\/orchestrations\/projects\/[^/]+\/runs\/\d{8}T\d{6}Z\//);
    }
  });

  it('and no excluded file is one the pipeline executes', () => {
    // Evidence is data a run emitted. An executable parked under a runs/ directory would be live
    // code wearing an archive's exemption.
    const executable = evidence
      .map((l) => l.slice(0, l.indexOf(':')))
      .filter((p) => /\.(ts|tsx|mjs|cjs)$/.test(p));
    expect([...new Set(executable)], 'these are excluded as evidence but are source files')
      .toEqual([]);
  });
});
