// THE ONE INSTRUCTION THAT COULD END THE LOOP WAS SWITCHED OFF BY AN UNRELATED FILE.
//
// Live metrolinx AMSD-2041, 2026-08-19 13:55. lockfile-sync blocked four times, correctly: the
// writer added a dependency to the manifest and never installed it, so the lockfile never moved.
// The directive that tells the writer to run the codeline's own add-command — the only thing that
// makes the block actionable — never reached it, because it is gated on:
//
//     [ -f "$PROJECT_ROOT/.epam/dependency-check.json" ]
//
// and that file was absent from the codeline this run (present at 12:00, gone at 13:55).
//
// THAT GATE WAS RIGHT FOR THE OLD TEXT AND WRONG FOR THE NEW ONE. The original directive promised
// "missing imports are detected and installed automatically", which is true only when the PROJECT
// declares autoInstall — hence the file check. The replacement (c981785) promises nothing: it
// tells the writer to run the add-command itself. What it needs is a KNOWN ECOSYSTEM — a manifest,
// a lockfile and an add-command — all of which come from lib/ecosystems.js, never from .epam/.
//
// Gating an instruction on a file it does not depend on is how a writer ends up told what is wrong
// and never told how to fix it.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A codeline: a real ecosystem manifest + lockfile, with or without the .epam/ dependency config. */
function makeRepo(opts: { manifest?: string; lock?: string; depConfig?: boolean }): string {
  const d = mkdtempSync(join(tmpdir(), 'nd-gate-')); made.push(d);
  if (opts.manifest) writeFileSync(join(d, opts.manifest), JSON.stringify({ name: 'f', dependencies: {} }));
  if (opts.lock) writeFileSync(join(d, opts.lock), '{"lockfileVersion":2,"packages":{}}');
  if (opts.depConfig) {
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/dependency-check.json'), JSON.stringify({
      manifestFile: 'package.json', manifestKeys: ['dependencies'],
      scanFileExtensions: ['.ts'], importPattern: 'x',
      installCommand: 'echo {package}', vendorDirs: ['node_modules'],
    }));
  }
  return d;
}

/** Execute the REAL directive block from claude.sh with its REAL collaborators. */
function directive(projectRoot: string): string {
  const script = `
SCRIPT_DIR='${join(ROOT, 'orchestrations/scripts')}'
AUTOMATION_DIR='${join(ROOT, 'orchestrations')}'
NODE_CMD='${NODE}'
source "$SCRIPT_DIR/lib/jq-vals.sh"
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
eval "$(awk '/^_project_dep_config_value\\(\\) \\{/,/^\\}/' "$SCRIPT_DIR/claude.sh")"
eval "$(awk '/^_project_install_command\\(\\) \\{/,/^\\}/' "$SCRIPT_DIR/claude.sh")"
command -v _project_install_command >/dev/null || { echo "HARNESS DID NOT LIFT" >&2; exit 3; }
run_extracted() {
  local PROJECT_ROOT='${projectRoot}'
${block()}
  echo "$new_dependency_directive"
}
run_extracted
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1' } });
  if (r.status === 3) throw new Error('harness failed to lift claude.sh');
  return r.stdout || '';
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readFileSync } = require('node:fs');
function block(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const a = src.indexOf('    local new_dependency_directive=""');
  const b = src.indexOf('\n\n    # Deterministic contract injection', a);
  return src.slice(a, b);
}

describe('a codeline with a known ecosystem and no .epam/ config', () => {
  // This is metrolinx as it actually was on the run that looped.
  const repo = () => makeRepo({ manifest: 'package.json', lock: 'package-lock.json', depConfig: false });

  it('still receives the directive', () => {
    expect(directive(repo()).trim(), 'the writer is told what is wrong and never how to fix it')
      .not.toBe('');
  });

  it('and it names the add-command the ecosystem declares', () => {
    expect(directive(repo())).toMatch(/npm install <package>/);
  });

  it('and the lockfile half, since this codeline has a lockfile', () => {
    expect(directive(repo())).toContain('package-lock.json');
  });
});

describe("the project's own declaration still wins when it has one", () => {
  it('uses the declared install command over the ecosystem default', () => {
    const repo = makeRepo({ manifest: 'package.json', lock: 'package-lock.json', depConfig: true });
    const out = directive(repo);
    expect(out).toContain('echo <package>');
    expect(out).not.toMatch(/npm install <package>/);
  });
});

describe('a codeline this engine cannot advise', () => {
  it('gets no directive rather than one telling it to run nothing', () => {
    // No manifest of any known ecosystem: there is no add-command to name.
    const repo = makeRepo({});
    expect(directive(repo).trim()).toBe('');
  });
});
