/**
 * VERIFICATION IS A PROJECT FACT, NOT AN ENGINE FACT.
 *
 * `tsc` was invoked from SIXTEEN hardcoded call sites across five scripts, including a fully
 * spelled-out `~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsc` in
 * merge-worktree.sh. Every one of them assumed TypeScript, `tsconfig.json`, a `src/` directory,
 * `.ts` extensions and a Node runtime path. Pointed at a Python, Go or .NET repo the checks
 * silently return success, because "no tsconfig.json" was treated as "nothing to verify" rather
 * than "I do not know how to verify this stack".
 *
 * That mattered most in the worst possible place: the compile result decided whether the
 * writer's work was KEPT or DESTROYED. On 2026-08-10 it discarded 25 file writes.
 *
 * This plugin replaces all of it with one contract — the project declares how it verifies
 * itself, the engine runs that and reads an exit code. No tool name, no file extension, no
 * directory layout, no runtime path in the engine.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require(join(__dirname, '../../../orchestrations/plugins/verification-tools.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project whose .epam manifest declares how it verifies itself. */
function project(command: string | null, opts: { exitCode?: number; stdout?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-')); dirs.push(dir);
  mkdirSync(join(dir, '.epam'), { recursive: true });
  if (command !== null) {
    writeFileSync(join(dir, '.epam', 'verification.json'),
      JSON.stringify({ typecheck: { command } }, null, 2));
  }
  // A stand-in for whatever the stack's real checker is.
  const bin = join(dir, 'checker.sh');
  writeFileSync(bin, `#!/usr/bin/env bash\n${opts.stdout ? `echo ${JSON.stringify(opts.stdout)}` : ''}\nexit ${opts.exitCode ?? 0}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const tool = () => plugin.tools.find((t: { definition: { name: string } }) =>
  t.definition.name === 'verify_typecheck');

describe('the plugin is a well-formed, registrable plugin', () => {
  it('exports a tools array', () => {
    expect(Array.isArray(plugin.tools)).toBe(true);
    expect(plugin.tools.length).toBeGreaterThan(0);
  });

  it('declares a verify_typecheck tool with a schema', () => {
    const t = tool();
    expect(t, 'no verify_typecheck tool exported').toBeTruthy();
    expect(t.definition.inputSchema.type).toBe('object');
  });

  it('declares a pluginApiVersion the loader accepts', () => {
    // Live 2026-08: a numeric 1 instead of '1.0.0' made `.split()` throw and the whole plugin
    // failed to load — scan_secrets was silently absent for weeks.
    const t = tool();
    const v = t.definition.pluginApiVersion ?? plugin.pluginApiVersion;
    expect(v, 'no pluginApiVersion declared').toBeTruthy();
    expect(() => String(v).split('.')).not.toThrow();
  });
});

describe('THE CONTRACT: the project declares the command, the engine runs it', () => {
  it('runs the declared command and reports success', async () => {
    const p = project(`bash ${'${PROJECT_ROOT}'}/checker.sh`, { exitCode: 0 });
    const r = await tool().execute({ projectRoot: p.dir });
    expect(r.isError).not.toBe(true);
    expect(r.content).toMatch(/pass|success|0/i);
  });

  it('reports failure with the checker\'s own output, so it can feed a retry', async () => {
    const p = project(`bash ${'${PROJECT_ROOT}'}/checker.sh`,
      { exitCode: 2, stdout: 'src/a.ts(3,1): error TS1005' });
    const r = await tool().execute({ projectRoot: p.dir });
    expect(r.content, 'the retry loop needs the errors, not just a verdict').toContain('TS1005');
  });

  it('no tool name, extension, directory or runtime path is baked into the plugin', () => {
    const src = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/plugins/verification-tools.js'), 'utf8');
    const code = src.split('\n').filter((l: string) => !l.trim().startsWith('*') &&
      !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    for (const banned of ['tsconfig.json', 'node_modules/.bin', '.nvm/versions', 'tsc ']) {
      expect(code, `'${banned}' is hardcoded — this is meant to be stack-agnostic`)
        .not.toContain(banned);
    }
  });
});

describe('FAIL CLOSED: an undeclared stack is not a passing stack', () => {
  it('a project with no verification manifest reports UNKNOWN, not success', async () => {
    // The old behaviour: `[ ! -f tsconfig.json ] && return 0` — a non-TS project silently
    // "passed" every compile gate, which also made the keep/discard decision unconditional.
    const p = project(null);
    const r = await tool().execute({ projectRoot: p.dir });
    expect(r.isError, 'an undeclared project silently passed').toBe(true);
    expect(r.content).toMatch(/not declared|no verification|unknown/i);
  });

  it('a manifest with an empty command is refused rather than treated as a pass', async () => {
    const p = project('');
    const r = await tool().execute({ projectRoot: p.dir });
    expect(r.isError).toBe(true);
  });

  it('a malformed manifest is refused, not ignored', async () => {
    const p = project('x');
    writeFileSync(join(p.dir, '.epam', 'verification.json'), '{ not json');
    const r = await tool().execute({ projectRoot: p.dir });
    expect(r.isError).toBe(true);
  });
});

describe('the manifest is generated, not hand-written', () => {
  it('the plugin can detect a stack and produce a manifest', () => {
    // "Why it cannot be built dynamically during pre-launch in .epam folders is beyond me."
    // It can: detect from the repo's own manifest files, same as dependency-check does.
    expect(typeof plugin.detectVerification).toBe('function');
  });

  it('a Node/TS project yields its own script, not a hardcoded binary path', () => {
    const p = project(null);
    writeFileSync(join(p.dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
    writeFileSync(join(p.dir, 'tsconfig.json'), '{}');
    const d = plugin.detectVerification(p.dir);
    expect(d, 'no verification detected for an obvious TS project').toBeTruthy();
    expect(d.typecheck.command, 'it hardcoded a binary path instead of using the project script')
      .toMatch(/npm run typecheck|yarn typecheck|pnpm typecheck/);
  });

  it('an unrecognised stack yields nothing rather than a guess', () => {
    const p = project(null);
    writeFileSync(join(p.dir, 'Cargo.toml'), '[package]\nname="x"');
    const d = plugin.detectVerification(p.dir);
    expect(d, 'it invented a command for a stack it does not know').toBeFalsy();
  });
});
