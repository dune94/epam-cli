/**
 * AN UPDATE MUST NOT DESTROY WHAT A RUN GENERATED.
 *
 * Live 2026-09-05. A run reached pause 1 after 1h10m and $8.89: a 49-agent roster, 41 provisioned
 * prompts, the story assigned to a minted `checkout-forms-engineer`. Updating that install in place
 * to a newer ref — the supported `install.sh --dest` path — replaced the mint's own outputs with
 * whatever the ref's git history held at the same paths. The roster came back holding
 * `checkout-form-engineer` (singular) while the PRD still named the minted `checkout-forms-engineer`,
 * and the resume died:
 *
 *     [assign] AMSD-1919 was assigned "checkout-forms-engineer", which is not in the roster —
 *              it has no profile entry, so the writer would run with an empty system prompt.
 *     [mint] roster derivation FAILED — refusing to continue with agents that have no identity.
 *
 * The whole mint was unrecoverable: no copy of the minted profile survived anywhere on disk.
 *
 * WHY IT SLIPPED: run-state-paths.json declares what an update must never overwrite, and it lists
 * logs, runs, spool, data, kb — the things that look like evidence. The mint's own products are
 * evidence too, and are equally unrepeatable without paying again, and none of them were declared.
 *
 * AND WHY THE OBVIOUS FIX IS WRONG: run-state-paths.json works by tar `--exclude`, which means the
 * path is never extracted AT ALL. Every one of these files is TRACKED, so excluding them would
 * leave a FRESH install without them. The needed semantic is "do not overwrite if it already
 * exists", which install.sh already implements for operator config: snapshot, extract, restore.
 *
 * BOTH ENDS ARE TESTED HERE, deliberately:
 *   - an existing install keeps what its run generated
 *   - a fresh install still receives those files, and ordinary app code still updates
 * A fix that only satisfies the first would break every first install, silently.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const INSTALLER = join(REPO, 'orchestrations-installer');
const LIB = join(INSTALLER, 'lib/preserve-operator-config.sh');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('the generated-run-state list', () => {
  const file = join(INSTALLER, 'generated-run-state-paths.json');

  it('exists', () => {
    expect(existsSync(file),
      'nothing declares the mint\'s outputs as un-overwritable, so an update destroys them')
      .toBe(true);
  });

  const declared: string[] = existsSync(file) ? readJson(file).paths || [] : [];

  /**
   * THE PROMPT CACHE IS A PER-INSTALL ASSET, AND AN UPDATE WAS RESETTING IT.
   *
   * Operator, 2026-09-05: "it does not have to be generated again and again... I want it to be
   * tagged to a codeline and reused for the codeline."
   *
   * project-prompt-builder.js caches each generated prompt under the project's `.prompt-cache`,
   * keyed by the template digest and (when the prompt names a minted role) the roster digest, so
   * an unchanged prompt is reused instead of regenerated. The mechanism works. What defeated it is
   * that `.prompt-cache` is TRACKED — 78 files, 39 for metrolinx at v1.43 — so every
   * `install.sh --dest --ref` extracts the committed cache over the install's live one. The
   * committed entries were written against some other run's roster, so their rolesDigest never
   * matches and every prompt regenerates.
   *
   * Measured on the 2026-09-05 run: 39 templates regenerated, each then reviewed by a second
   * model — prompt-builder $1.25 over 25 calls plus prompt-review $1.51 over 16, together 36% of
   * the run's spend before the pipeline did any work of its own.
   *
   * It belongs on THIS list rather than run-state-paths.json for the same reason the roster does:
   * that list works by tar --exclude, so the path is never extracted at all and a FRESH install
   * would receive no cache. The needed semantic is "do not overwrite what is already there".
   */
  it('declares the prompt cache — an update must not reset it', () => {
    expect(declared.join('|'), [
      'orchestrations/projects/*/.prompt-cache is not declared, so every republish overwrites the',
      "install's accumulated cache with the ref's committed copy. Those entries were generated",
      'against a different roster, so nothing matches and all 39 prompts are regenerated and',
      're-reviewed — 36% of a run\'s spend, repeated every install.',
    ].join('\n')).toContain('.prompt-cache');
  });

  it('and the cache is NOT excluded — a fresh install may still receive one', () => {
    const excluded: string[] = readJson(join(INSTALLER, 'run-state-paths.json')).paths || [];
    expect(excluded.join('|'),
      '.prompt-cache was added to the exclude list, so a fresh install would never receive it')
      .not.toContain('.prompt-cache');
  });

  /**
   * THE ARTEFACTS ARE DERIVED FROM WHAT THE MINT ACTUALLY WRITES, not from a list I typed. Each
   * name is taken from the code that produces it, so a new mint output is caught by this test
   * rather than by another dead run.
   */
  const producedByTheMint = (() => {
    // The mint writes into the PROJECT config dir; those calls name the file. Only files that are
    // TRACKED are at risk — git archive can only overwrite what it carries — so the untracked ones
    // (prd.json, project-profiles.json) are not required to be declared.
    const sources = ['orchestrations/scripts/mint-agents-step.js',
      'orchestrations/scripts/lib/project-roster.js'].map(
      (f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
    const names = new Set<string>();
    for (const m of sources.matchAll(/projectConfigDir,\s*['"]([a-z-]+\.json)['"]/g)) names.add(m[1]);
    // projectRosterPath() builds this one from a constant beside it.
    for (const m of sources.matchAll(/['"](roster\.json)['"]/g)) names.add(m[1]);
    return [...names].filter((n) => {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch',
          `orchestrations/projects/metrolinx/${n}`], { cwd: REPO, stdio: 'ignore' });
        return true;
      } catch { return false; }
    });
  })();

  it('the derivation found the mint\'s outputs — otherwise the cases below are vacuous', () => {
    expect(producedByTheMint.length,
      'no generated artefact name was derived from project-roster.js').toBeGreaterThan(1);
  });

  // A file already preserved by the operator-config list is preserved — the requirement is that
  // it survives an update, not which list carries it. codeline-facts.json is declared there.
  const alreadyPreserved: string[] =
    readJson(join(INSTALLER, 'operator-config-paths.json')).paths || [];

  it.each(producedByTheMint)('declares %s', (name) => {
    if (alreadyPreserved.join('|').includes(name)) return;
    expect(declared.join('|'), [
      `${name} is written by the mint and is not declared, so an update overwrites it with`,
      'whatever the ref happens to hold. That is what destroyed a $8.89 roster and made the run',
      'unresumable — the minted agent existed in the PRD and nowhere else.',
    ].join('\n')).toContain(name);
  });

  it('does NOT use the exclude mechanism — these files are tracked and a fresh install needs them', () => {
    const excluded: string[] = readJson(join(INSTALLER, 'run-state-paths.json')).paths || [];
    for (const name of producedByTheMint) {
      expect(excluded.join('|'), [
        `${name} was added to run-state-paths.json, which tar --excludes — the path is then never`,
        'extracted at all, so a FRESH install would never receive it. Every one of these files is',
        'tracked in git.',
      ].join('\n')).not.toContain(name);
    }
  });
});

describe('the mechanism, driven end to end against a real tree', () => {
  /** Snapshot → overwrite (as tar would) → restore, using the real shell functions. */
  function roundTrip(existingFiles: Record<string, string>, refFiles: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'update-preserve-'));
    const dest = join(dir, 'install');
    for (const [rel, body] of Object.entries(existingFiles)) {
      mkdirSync(join(dest, rel, '..'), { recursive: true });
      writeFileSync(join(dest, rel), body);
    }
    const tmp = join(dir, 'snap');
    mkdirSync(tmp, { recursive: true });
    const script = join(dir, 's.sh');
    writeFileSync(script, [
      '#!/bin/bash', 'set -uo pipefail',
      `. ${JSON.stringify(LIB)}`,
      `snapshot_operator_config ${JSON.stringify(dest)} ${JSON.stringify(join(INSTALLER, 'generated-run-state-paths.json'))} ${JSON.stringify(tmp)}`,
      // stand in for `git archive | tar -x`: the ref's version lands on top
      ...Object.entries(refFiles).map(([rel, body]) =>
        `mkdir -p ${JSON.stringify(join(dest, rel, '..'))} && printf '%s' ${JSON.stringify(body)} > ${JSON.stringify(join(dest, rel))}`),
      `restore_operator_config ${JSON.stringify(dest)} ${JSON.stringify(tmp)}`,
    ].join('\n'));
    const r = execFileSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
    const out: Record<string, string | null> = {};
    for (const rel of new Set([...Object.keys(existingFiles), ...Object.keys(refFiles)])) {
      out[rel] = existsSync(join(dest, rel)) ? readFileSync(join(dest, rel), 'utf8') : null;
    }
    rmSync(dir, { recursive: true, force: true });
    return { out, log: r };
  }

  it('END ONE — an EXISTING roster survives the update', () => {
    const { out } = roundTrip(
      { 'orchestrations/projects/metrolinx/roster.json': '{"agents":{"checkout-forms-engineer":{}}}' },
      { 'orchestrations/projects/metrolinx/roster.json': '{"agents":{"checkout-form-engineer":{}}}' },
    );
    expect(out['orchestrations/projects/metrolinx/roster.json'], [
      'the update replaced the run\'s minted roster with the ref\'s. That is exactly the one-character',
      'difference — forms vs form — that made a $8.89 run unresumable.',
    ].join('\n')).toContain('checkout-forms-engineer');
  });

  it('END TWO — a FRESH install still receives the file', () => {
    // Nothing exists beforehand: the ref's copy must land and stay.
    const { out } = roundTrip(
      {},
      { 'orchestrations/projects/metrolinx/roster.json': '{"agents":{"seed":{}}}' },
    );
    expect(out['orchestrations/projects/metrolinx/roster.json'], [
      'a fresh install ended up with no roster at all. This is why the fix cannot be a tar',
      '--exclude: these files are tracked and a first install genuinely needs them.',
    ].join('\n')).toContain('seed');
  });

  it('END THREE — ordinary app code still updates', () => {
    const { out } = roundTrip(
      { 'orchestrations/scripts/claude.sh': 'OLD' },
      { 'orchestrations/scripts/claude.sh': 'NEW' },
    );
    expect(out['orchestrations/scripts/claude.sh'],
      'the preserve list is too broad — it is now stopping real code updates from landing')
      .toBe('NEW');
  });

  it('THE PROMPT CACHE SURVIVES — the install\'s own entry beats the ref\'s', () => {
    /**
     * The declaration above only says the path is listed. This drives the real snapshot/restore
     * shell functions to prove an update actually keeps the install's cache — the difference
     * between "declared" and "preserved" being exactly what made the roster loss possible.
     *
     * The two bodies differ in rolesDigest, which is what decides reuse: if the ref's copy wins,
     * every prompt naming a minted role regenerates, which is the 36%-of-spend defect.
     */
    const p = 'orchestrations/projects/metrolinx/.prompt-cache/roster-review.json';
    const { out } = roundTrip(
      { [p]: '{"base":"aaa","roles":"THIS_INSTALL","usesRoles":true,"reviewed":true}' },
      { [p]: '{"base":"aaa","roles":"FROM_THE_REF","usesRoles":true,"reviewed":false}' },
    );
    expect(out[p], [
      "the update replaced this install's prompt cache with the ref's committed copy. The ref's",
      'entries were generated against a different roster, so no rolesDigest matches and all 39',
      'prompts are regenerated and re-reviewed — every republish, forever.',
    ].join('\n')).toContain('THIS_INSTALL');
  });

  it('and a FRESH install still receives the ref\'s cache', () => {
    // The other end: excluding the path outright would leave a first install with no cache at
    // all, which is why this is on the preserve list and not the tar --exclude list.
    const p = 'orchestrations/projects/metrolinx/.prompt-cache/roster-review.json';
    const { out } = roundTrip({}, { [p]: '{"base":"seed"}' });
    expect(out[p], 'a fresh install received no prompt cache').toContain('seed');
  });

  it('a project the ref newly adds is still created', () => {
    const { out } = roundTrip(
      { 'orchestrations/projects/metrolinx/roster.json': '{"agents":{"mine":{}}}' },
      { 'orchestrations/projects/newproj/roster.json': '{"agents":{"seed":{}}}' },
    );
    expect(out['orchestrations/projects/metrolinx/roster.json']).toContain('mine');
    expect(out['orchestrations/projects/newproj/roster.json'],
      'a brand-new project added by a later ref never got its files').toContain('seed');
  });
});

describe('install.sh actually applies the list — an undeclared list preserves nothing', () => {
  const src = readFileSync(join(INSTALLER, 'install.sh'), 'utf8');

  it('snapshots and restores it around the extraction', () => {
    expect(src, 'generated-run-state-paths.json is declared but install.sh never reads it')
      .toMatch(/generated-run-state-paths\.json/);
  });

  it('and does so with its OWN snapshot directory, not the operator-config one', () => {
    // Sharing one tmp dir would make the second snapshot clobber the first.
    const idx = src.indexOf('generated-run-state-paths.json');
    const near = src.slice(Math.max(0, idx - 1500), idx + 1500);
    expect(near, 'the two snapshots share a directory, so one overwrites the other')
      .toMatch(/_GENSTATE_TMP|_RUNGEN_TMP/);
  });
});
