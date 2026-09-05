/**
 * A COMPLETED PROVISIONING MARKS ITSELF COMPLETE — and nothing else may.
 *
 * The consumer already exists and is tested: pre-run-reset.sh reuses a codeline's agents and
 * prompts only when `.prompt-cache/.complete` says the last run finished them for THIS codeline
 * with zero refusals. That gate is worthless until something writes the marker, and a gate whose
 * producer was never wired is a defect this repo has shipped before — lib/plan-fidelity-gate.sh
 * was built, tested and called by nothing for weeks.
 *
 * WHERE THE SIGNAL COMES FROM, honestly. buildProjectPrompts THROWS when a prompt cannot be
 * installed after its attempts ("a project missing one prompt must not look provisioned"). So
 * reaching the end of provisioning is itself the completion proof — the marker records a fact the
 * control flow has already established, rather than a second opinion about it that could disagree.
 *
 * BOTH ENDS:
 *   - a completed provisioning writes a marker naming the codeline and the count
 *   - no codeline declared writes NOTHING, because an untagged marker would be reused by whatever
 *     codeline ran next, which is the cross-codeline contamination the consumer refuses
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUILDER = join(__dirname, '../../../orchestrations/scripts/lib/project-prompt-builder.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeCompletionMarker, clearCompletionMarker } = require(BUILDER);

function outDir() {
  const root = mkdtempSync(join(tmpdir(), 'marker-'));
  const out = join(root, 'projects', 'metrolinx', 'prompts');
  mkdirSync(out, { recursive: true });
  const cache = join(root, 'projects', 'metrolinx', '.prompt-cache');
  // The codeline is the FILENAME — that is the whole marker contract now.
  const marker = (codeline: string) => join(cache, `.complete-${codeline}`);
  return { root, out, cache, marker };
}

describe('the completion marker', () => {
  it('is written beside the cache, not inside prompts/', () => {
    // prompts/ is deleted and recreated by pre-run-reset on a non-reusing run; a marker in there
    // could never survive to be read.
    const { root, out, cache, marker } = outDir();
    try {
      writeCompletionMarker({ outDir: out, codeline: 'next.gotransit.com', provisioned: 39 });
      expect(existsSync(marker('next.gotransit.com')),
        'the marker was not written where pre-run-reset reads it (.prompt-cache/.complete)')
        .toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records the codeline and the count, with refused: 0', () => {
    const { root, out, cache, marker } = outDir();
    try {
      writeCompletionMarker({ outDir: out, codeline: 'next.gotransit.com', provisioned: 39 });
      // The NAME is the claim; the file is empty by design, so there is nothing to parse and
      // nothing that can be malformed.
      expect(existsSync(marker('next.gotransit.com'))).toBe(true);
      expect(readFileSync(marker('next.gotransit.com'), 'utf8')).toBe('');
      expect(existsSync(marker('next.upexpress.com')),
        'a marker for a DIFFERENT codeline exists — the name must be the identity')
        .toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('THE OTHER END — no codeline declared writes NO marker', () => {
    // An untagged marker would be honoured by whichever codeline ran next.
    const { root, out, cache, marker } = outDir();
    try {
      for (const codeline of [undefined, '', '   ', null]) {
        writeCompletionMarker({ outDir: out, codeline: codeline as string, provisioned: 39 });
        expect(existsSync(marker('next.gotransit.com')),
          `codeline=${JSON.stringify(codeline)} produced a marker that any codeline could claim`)
          .toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('provisioned: 0 writes no marker — nothing was provisioned to reuse', () => {
    const { root, out, cache, marker } = outDir();
    try {
      writeCompletionMarker({ outDir: out, codeline: 'next.gotransit.com', provisioned: 0 });
      expect(existsSync(marker('next.gotransit.com'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('clears EVERY codeline\'s marker when provisioning starts', () => {
    const { root, out, cache, marker } = outDir();
    try {
      // Two codelines are two files. clearCompletionMarker removes ALL of them on the way in,
      // so a stale claim for another codeline cannot survive a provisioning run.
      writeCompletionMarker({ outDir: out, codeline: 'a', provisioned: 10 });
      writeCompletionMarker({ outDir: out, codeline: 'b', provisioned: 39 });
      expect(existsSync(marker('a'))).toBe(true);
      expect(existsSync(marker('b'))).toBe(true);
      clearCompletionMarker({ outDir: out });
      expect(existsSync(marker('a')), 'a previous codeline\'s claim survived the clear').toBe(false);
      expect(existsSync(marker('b'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never throws — a marker is an optimisation, never a reason to fail a run', () => {
    /**
     * If it cannot be written, the next run simply regenerates: today's behaviour. Failing a
     * provisioned run over a cache hint would trade a saving for an outage.
     *
     * THE UNWRITABLE CASE IS A REAL ONE, not a pathological path. An earlier version of this test
     * used /proc/..., where mkdirSync(recursive) HANGS on this kernel instead of throwing — the
     * test never failed, it just never finished. A parent that is a FILE is the failure this code
     * would actually meet (a stray `.prompt-cache` file where the directory should be) and it
     * fails fast.
     */
    const root = mkdtempSync(join(tmpdir(), 'marker-unwritable-'));
    try {
      const proj = join(root, 'projects', 'metrolinx');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, '.prompt-cache'), 'a FILE where the cache directory belongs');
      expect(() => writeCompletionMarker({
        outDir: join(proj, 'prompts'), codeline: 'x', provisioned: 1,
      })).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(() => writeCompletionMarker({} as never)).not.toThrow();
    expect(() => writeCompletionMarker(undefined as never)).not.toThrow();
  });

  it('a marker written by a PREVIOUS run is removed when this run starts provisioning', () => {
    /**
     * The dangerous ordering. If this run wipes prompts/ and regenerates, but dies partway, a
     * marker left by the LAST run still says "complete" — and the next run reuses a half-written
     * set. The marker must be cleared before provisioning begins and rewritten only on success.
     */
    const { root, out, cache, marker } = outDir();
    try {
      mkdirSync(cache, { recursive: true });
      writeFileSync(marker('stale'), '');
      clearCompletionMarker({ outDir: out });
      expect(existsSync(marker('next.gotransit.com')),
        "the previous run's completion marker survived into this run; if this run dies partway "
        + 'its half-written prompts are inherited as complete').toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
