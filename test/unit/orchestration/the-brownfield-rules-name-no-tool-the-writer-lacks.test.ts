/**
 * THE BROWNFIELD RULES NAME NO PATH AND NO TOOL THE WRITER LACKS.
 *
 * 2026-10-04: "VERIFY THIRD-PARTY SDK CALLS" told every brownfield writer to use the codegraph_query
 * tool or `bash orchestrations/scripts/resolve-package-symbol.sh`. The script path is relative to the
 * install; a lane writer works in its codeline's worktree, where it does not exist. And on the copilot
 * runner the writer is granted neither named tool — its request lists the CLI's own (bash, view,
 * edit, grep, glob …). The rule asked for two things the agent could not do. It now says what to
 * establish and where the evidence is, and leaves the means to the agent.
 *
 * EXECUTED: the real renderer (lib/render-prompt-section.js) over the shipped catalog, both arms.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const render = (section: string) => spawnSync(process.execPath,
  [join(ORCH, 'scripts/lib/render-prompt-section.js'), join(ORCH, 'config/agent-contract.json'), section, '_startIndex=4'],
  { encoding: 'utf8' }).stdout;

describe('the brownfield rules a writer receives', () => {
  for (const section of ['brownfieldExisting', 'brownfieldNovel']) {
    it(`${section}: still asks for third-party calls to be verified, naming no path and no tool`, () => {
      const out = render(section);
      expect(out, `${section} rendered nothing`).toMatch(/VERIFY THIRD-PARTY SDK CALLS/);
      expect(out).toMatch(/package's own (source|type declarations)/);
      expect(out, 'an install-relative script path').not.toMatch(/orchestrations\//);
      expect(out, 'a tool the copilot writer is not granted').not.toMatch(/codegraph_query|resolve[-_]package[-_]symbol/);
    });
  }
});
