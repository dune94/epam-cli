/**
 * A SOURCE LINE THAT RUNS BEFORE ITS PATH VARIABLE IS SET KILLS THE RUN AT STARTUP.
 *
 * Lifting functions into lib/ leaves a `. "$SCRIPT_DIR/lib/x.sh"` behind. Placed above the line
 * that DEFINES SCRIPT_DIR, it expands to "/lib/x.sh" and every run dies with
 * "No such file or directory" before doing anything.
 *
 * Nothing else catches it. `bash -n` sees valid syntax — the path is only wrong at runtime. Unit
 * tests source the lib directly, so they never exercise the orchestrator's own source line. It
 * took a full pipeline rehearsal to surface, and it would have been a paid run if the rehearsal
 * had not been free.
 *
 * This is the cheap version of that rehearsal: a source line must resolve when it executes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/** Shell scripts at the top level of orchestrations/scripts. */
function shellScripts(): string[] {
  return readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh')).map((f) => join(SCRIPTS, f));
}

type Bad = { file: string; line: number; text: string; why: string };

function badSourceLines(file: string): Bad[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Bad[] = [];

  // Where each path-ish variable is first assigned. A source using it earlier expands to nothing.
  const definedAt = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/.exec(l);
    if (m && !definedAt.has(m[1])) definedAt.set(m[1], i);
  });

  lines.forEach((l, i) => {
    const m = /^\s*(?:\.|source)\s+"?\$\{?([A-Z_][A-Z0-9_]*)\}?\/([^"\s]+)"?/.exec(l);
    if (!m) return;
    const [, varName, rest] = m;
    const at = definedAt.get(varName);
    if (at === undefined) {
      out.push({ file, line: i + 1, text: l.trim(), why: `${varName} is never assigned in this file` });
    } else if (at > i) {
      out.push({
        file, line: i + 1, text: l.trim(),
        why: `${varName} is not assigned until line ${at + 1}, so this expands to "/${rest}"`,
      });
    }
  });
  return out;
}

describe('a source line resolves when it runs', () => {
  const scripts = shellScripts();

  it('there are scripts to check — an empty sweep proves nothing', () => {
    expect(scripts.length).toBeGreaterThan(5);
  });

  it('no script sources a path through a variable set later in the same file', () => {
    const bad = scripts.flatMap(badSourceLines);
    const report = bad.map((b) => `${b.file.replace(SCRIPTS, '')}:${b.line}  ${b.why}\n    ${b.text}`);
    expect(bad, `these die at startup with "No such file or directory":\n${report.join('\n')}`)
      .toEqual([]);
  });

  it('every sourced lib path that IS resolvable actually exists on disk', () => {
    // The other half: a correct variable pointing at a file nobody shipped fails the same way.
    const missing: string[] = [];
    for (const f of scripts) {
      const dir = dirname(f);
      for (const l of readFileSync(f, 'utf8').split('\n')) {
        const m = /^\s*(?:\.|source)\s+"?\$\{?[A-Z_][A-Z0-9_]*\}?\/(lib\/[A-Za-z0-9._-]+\.sh)"?/.exec(l);
        if (m && !existsSync(join(dir, m[1]))) missing.push(`${f.replace(SCRIPTS, '')} -> ${m[1]}`);
      }
    }
    expect(missing, `sourced libraries that do not exist:\n${missing.join('\n')}`).toEqual([]);
  });
});
