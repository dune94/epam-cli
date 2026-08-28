/**
 * A STACK'S SCRIPT NAMES BELONG TO THE STACK, NOT TO A GATE.
 *
 * verification-plugin.js carries three lists of npm script names it hopes a project uses —
 * ['typecheck','type-check','tsc','check-types','lint:types'], ['test','tests','test:unit',...] —
 * while its own docstring says "the engine never learns the tool's name".
 *
 * Measured live 2026-08-28: "[tsc-verify] MOCK3-1: the project declares no typecheck command — the
 * check could not run", on a repository whose package.json builds with tsc under a script the list
 * does not name. The writer then hand-wrote a manifest entry pointing at `npm run build`, which is
 * an agent patching around a missing capability.
 *
 * orchestrations/ecosystems/ is where a stack's facts already live — one file per manifest kind, so
 * a new stack is a new file and no engine code changes. These names go there.
 *
 * AND THE SCANNER FOLLOWS THEM. Relocating a literal into config, and calling that repair, is a
 * documented past failure of this very audit: on 2026-08-23 every hardcoding defect it missed had
 * been moved somewhere it did not look. So the move only counts if the new home is scanned.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('THE SCRIPT NAMES MOVED TO THE STACK THAT OWNS THEM', () => {
  it('the node ecosystem file declares the verification script names', () => {
    const eco = read('orchestrations/ecosystems/package-json.js');
    expect(eco, 'the stack file does not declare which scripts verify a project')
      .toMatch(/verificationScripts/);
    expect(eco).toMatch(/typecheck/);
    expect(eco).toMatch(/'test'/);
  });

  it('the gate no longer carries its own copy', () => {
    const plugin = read('orchestrations/plugins/verification-plugin.js');
    expect(plugin, 'the gate still names the stack\'s scripts, which its own docstring forbids')
      .not.toMatch(/\['typecheck', 'type-check', 'tsc'/);
  });

  it('the gate reads them from the ecosystem instead', () => {
    expect(read('orchestrations/plugins/verification-plugin.js'))
      .toMatch(/verificationScripts/);
  });
});

describe('THE AUDIT FOLLOWS THEM TO THEIR NEW HOME', () => {
  it('orchestrations/ecosystems is in the audit scope', () => {
    // Otherwise this change would read as a 3-finding improvement while nothing improved —
    // the exact way this audit was defeated on 2026-08-23.
    const scope = JSON.parse(read('orchestrations/config/hardcoding-audit-scope.json'));
    const paths = scope.scan.map((s: { path: string }) => s.path);
    expect(paths, 'the names would move somewhere the scanner cannot see, and the count would fall '
      + 'for a relocation').toContain('orchestrations/ecosystems');
  });
});
