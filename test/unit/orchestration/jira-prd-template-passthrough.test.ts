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
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

describe('Jira ingest — PRD template is configurable per project', () => {
  it('ingest passes --template through to synthesize-prd-from-jira.js', () => {
    expect(INGEST).toMatch(/--template/);
  });

  it('the template comes from an env var so each project supplies its own', () => {
    expect(INGEST).toMatch(/JIRA_PRD_TEMPLATE/);
  });

  it('behaviour is unchanged when the env var is unset (safe default)', () => {
    // The flag must be conditional — an empty --template would break every
    // existing project that relies on the built-in canonical.
    const i = INGEST.indexOf('JIRA_PRD_TEMPLATE');
    const near = INGEST.slice(Math.max(0, i - 400), i + 400);
    expect(near).toMatch(/if \[ -n|:-|\[ -f/);
  });
});

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
