/**
 * The Jira ingest must let a project supply its own PRD template.
 *
 * `synthesize-prd-from-jira.js` already accepts `--template` and keys it by story
 * id (`templateStoryMap[s.id]`), preserving each story's `agentGroup`, `agentRole`
 * and `effort`. But `ingest-jira-tickets.sh` never passed the flag, so synthesis
 * always fell back to the hardcoded `orchestrations/travel-app-prd.canonical.json`
 * — a travel-app fixture, regardless of which project is running.
 *
 * Two consequences:
 *   1. Any non-travel-app project (metrolinx included) silently synthesized its
 *      stories against a template belonging to a different product.
 *   2. mock2 could not exercise the real Jira ingest at all while keeping its
 *      lane topology (main / primary / independent), because topology comes from
 *      the template. It was therefore running with JIRA_PIPELINE=0 — skipping a
 *      whole production stage. User directive 2026-07-24: "mock2 should not skip
 *      jira", and "no difference in piping".
 *
 * With the template configurable, mock2 drives the REAL ingest (real jira-client,
 * real AC-gate, real synthesis) while its topology stays deterministic — the
 * property that makes it a topology test rather than a coin flip.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = (p: string) => join(__dirname, '../../../', p);
const INGEST = readFileSync(root('orchestrations/scripts/ingest-jira-tickets.sh'), 'utf8');
const SYNTH = root('orchestrations/scripts/synthesize-prd-from-jira.js');
// DERIVED, never a machine path: the interpreter already running this test.
const NODE20 = process.execPath;

/**
 * REMOVED 2026-08-05 — three assertions of the form `expect(INGEST).toMatch(/--template/)`.
 *
 * They asserted that the ingest SCRIPT CONTAINS the string "--template" and the string
 * "JIRA_PRD_TEMPLATE", and passed for months while every Jira-sourced run inherited a
 * different project's identity: no project ever set JIRA_PRD_TEMPLATE, so synthesis always
 * fell through to a built-in canonical. mock1 run 20260805T192100Z executed hello-dolly and
 * shipped project.name "skyscanner-app".
 *
 * A string in a file cannot show which template a run actually used. That is now proven by
 * running the chain: test/integration/jira-ingest-project-identity.test.ts drives the real
 * mock Jira server, the real ingest, the real ac-gate and the real synthesis, and reads
 * project.name out of the PRD on disk.
 */
describe('synthesis preserves topology from the supplied template', () => {
  it('agentGroup / agentRole survive synthesis, keyed by story id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synth-tmpl-'));
    try {
      // A template with a deliberate 3-lane topology, exactly mock2's shape.
      const template = {
        project: { name: 'mock2' },
        stories: [
          { id: 'MAIN-1', agentGroup: 'main', agentRole: 'typescript-engineer' },
          { id: 'PRI-1', agentGroup: 'primary', agentRole: 'typescript-engineer' },
          { id: 'IND-1', agentGroup: 'independent', agentRole: 'typescript-engineer' },
        ],
      };
      const tmplPath = join(dir, 'template.json');
      writeFileSync(tmplPath, JSON.stringify(template));

      // AC-gate classification output, as the real ingest would produce.
      const classifications = [
        { storyId: 'MAIN-1', jiraKey: 'MOCK-1', title: 'main story', verdict: 'sufficient', originalAcs: ['a'] },
        { storyId: 'PRI-1', jiraKey: 'MOCK-2', title: 'primary story', verdict: 'sufficient', originalAcs: ['b'] },
        { storyId: 'IND-1', jiraKey: 'MOCK-3', title: 'independent story', verdict: 'sufficient', originalAcs: ['c'] },
      ];
      const classPath = join(dir, 'classifications.json');
      writeFileSync(classPath, JSON.stringify(classifications));
      const outPath = join(dir, 'out.json');

      execFileSync(NODE20, [SYNTH, '--classifications', classPath, '--out', outPath, '--template', tmplPath],
        // JIRA_DEFAULT_CODELINE: synthesis requires a codeline, normally supplied
        // by Jira labels. The real ingest sets it the same way.
        { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1', JIRA_DEFAULT_CODELINE: 'mock' } });

      const prd = JSON.parse(readFileSync(outPath, 'utf8'));
      const byId = Object.fromEntries((prd.stories || []).map((s: any) => [s.id, s]));
      // Without the template these would all collapse to the default group.
      expect(byId['MAIN-1']?.agentGroup).toBe('main');
      expect(byId['PRI-1']?.agentGroup).toBe('primary');
      expect(byId['IND-1']?.agentGroup).toBe('independent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
