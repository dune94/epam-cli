/**
 * A RUN'S ARTEFACTS MUST DESCRIBE THAT RUN. CROSS-PROJECT CONTAMINATION IS NOT ACCEPTABLE.
 *
 * Live 2026-08-05: a clean mock1 run (project hello-dolly, story MOCK-HW-1) archived
 * artefacts describing a DIFFERENT project, a DIFFERENT story and a DIFFERENT day —
 *
 *   working-prd.json          AMSD-2041, project.name: metrolinx
 *   kb/healing-events.jsonl   19 entries from the previous day's metrolinx runs
 *
 * Final artefacts ARE scoped per project (projects/<name>/runs/<id>/). The WORKING files
 * were not: every lane wrote its PRD to a flat, machine-global /tmp namespace —
 *
 *   /tmp/orch-<codeline>-prd-<pid>.json
 *
 * — and archive-run-artifacts.sh then took `ls -t /tmp/orch-*-prd-*.json | head -1`,
 * commented "take the newest, which is this run's". It is the newest from ANY project on
 * the machine. Today's metrolinx runs left one there, so mock1 archived it.
 *
 * Run evidence that confidently names the wrong project is worse than no evidence: it is
 * indistinguishable from the real thing, and decisions get made on it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');
const ARCHIVER = join(REPO, 'orchestrations/scripts/archive-run-artifacts.sh');

const codeLines = (rel: string) =>
  readFileSync(join(REPO, rel), 'utf8')
    .split('\n')
    .map((l, i) => ({ l: l.trim(), n: i + 1 }))
    .filter(({ l }) => l && !l.startsWith('#'));

describe('working files are scoped to the run, not a shared namespace', () => {
  it('no lane writes its PRD into a machine-global /tmp path', () => {
    const hits = codeLines('orchestrations/scripts/run-agent-orchestration.sh')
      .filter(({ l }) => /_prd="?\/tmp\/orch-/.test(l))
      .map(({ l, n }) => `run-agent-orchestration.sh:${n}: ${l}`);
    expect(
      hits,
      'a flat /tmp name is shared by every project and every concurrent run on this ' +
        `machine — the archiver then cannot tell them apart:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('the archiver never GUESSES which PRD belongs to this run', () => {
    const hits = codeLines('orchestrations/scripts/archive-run-artifacts.sh')
      .filter(({ l }) => /ls -t .*\/tmp\/orch-.*prd/.test(l))
      .map(({ l, n }) => `archive-run-artifacts.sh:${n}: ${l}`);
    expect(
      hits,
      `"the newest matching file" is an assumption, not this run's PRD:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('the archiver fails loudly when it is not told which PRD to capture', () => {
    const src = readFileSync(ARCHIVER, 'utf8');
    expect(
      src,
      'silently archiving nothing is better than archiving another project\'s PRD, but ' +
        'both must be VISIBLE — artifacts.json already records a "missing" list, which is ' +
        'the right pattern',
    ).toMatch(/missing/i);
  });
});
