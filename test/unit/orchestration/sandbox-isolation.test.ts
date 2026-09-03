/**
 * Root cause of a live defect (2026-07-13/14): SKY-004 and SKY-002-impl/
 * SKY-003-b repeatedly hit `[vendor-guard] Vendor directory tampering
 * detected` — the existing defense (`chmod -R a-w node_modules` in
 * `_vendor_lock`/`_vendor_unlock`, claude.sh) is same-UID-bypassable: the
 * agent's own Bash tool runs as the same user and can just `chmod +w` it
 * back, which self-heal guidance was explicitly telling it to do. Verified
 * live that the OS "immutable" alternative (`chattr +i`) is also a dead
 * end — it requires CAP_LINUX_IMMUTABLE, which neither the orchestrator nor
 * the agent has (both run as the same non-root user), so the orchestrator
 * can't even grant the protection.
 *
 * Fix: this repo already had a complete, working sandbox mechanism
 * (`EPAM_SANDBOX=true` / `--sandbox`, `orchestrations/scripts/lib/
 * sandbox-invoke.sh` + `Dockerfile.sandbox`) that nobody had connected to
 * this bug. Extended (not rebuilt) to: (1) mount each dir already declared
 * in `.epam/dependency-check.json`'s "vendorDirs" read-only inside the
 * container — a kernel-enforced bind-mount permission the agent's own
 * process genuinely cannot undo, unlike chmod; (2) accept a configurable
 * target command so the SAME wrapper can front the `openrouter`/`minimax`
 * provider branch (this project's actual providers), not just `claude`;
 * (3) derive the container's base image from `project.stack.language`/
 * `.runtime` — data the LLM-based `generatePrd()` pipeline (src/scaffold/
 * ManifestAnalyzer.ts) already writes into every project's prd.json, so no
 * project-specific value is hand-authored anywhere.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SANDBOX_INVOKE_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/sandbox-invoke.sh');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionByLineAnchor(src: string, name: string): string {
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l === `${name}() {`);
  if (startIdx === -1) throw new Error(`${name} start anchor not found`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === '}');
  if (endIdx === -1) throw new Error(`${name} end anchor not found`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

describe('sandbox-invoke.sh — REAL execution, vendor-dir mounts + configurable target cmd', () => {
  function run(opts: {
    vendorDirs?: string[];
    targetCmd?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
  }): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-invoke-test-'));
    try {
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg.js'), 'module.exports = {}');
      if (opts.vendorDirs) {
        mkdirSync(join(dir, '.epam'), { recursive: true });
        writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify({ vendorDirs: opts.vendorDirs }));
      }

      const fakeDockerDir = join(dir, 'fake-bin');
      mkdirSync(fakeDockerDir, { recursive: true });
      const fakeDockerPath = join(fakeDockerDir, 'docker');
      writeFileSync(fakeDockerPath, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n');
      chmodSync(fakeDockerPath, 0o755);

      const args = ['--json', '-', ...(opts.extraArgs ?? [])];
      const output = execFileSync('bash', [SANDBOX_INVOKE_SH, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeDockerDir}:${process.env.PATH}`,
          PROJECT_ROOT: dir,
          ...(opts.targetCmd ? { EPAM_SANDBOX_TARGET_CMD: opts.targetCmd } : {}),
          ...opts.env,
        },
      });
      return output.trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the fix: a configured vendorDir gets its own nested :ro mount', () => {
    const argv = run({ vendorDirs: ['node_modules'] });
    const roMountIdx = argv.findIndex((a) => a.endsWith('/node_modules:ro') && a.includes(':'));
    expect(roMountIdx).toBeGreaterThan(-1);
    expect(argv[roMountIdx]).toMatch(/^.+\/node_modules:.+\/node_modules:ro$/);
  });

  it('is a no-op (no extra :ro mount) when no dependency-check.json is present', () => {
    const argv = run({});
    const roMounts = argv.filter((a) => a.endsWith(':ro') && a.includes('node_modules'));
    expect(roMounts.length).toBe(0);
  });

  it('defaults the target command to "claude" (preserves original behavior)', () => {
    const argv = run({});
    // Last args before the passed-through "$@" should be the image, then "claude"
    const imageIdx = argv.indexOf('epam-cli-sandbox:latest');
    expect(imageIdx).toBeGreaterThan(-1);
    expect(argv[imageIdx + 1]).toBe('claude');
  });

  it('uses a custom EPAM_SANDBOX_TARGET_CMD, split into multiple argv tokens', () => {
    const argv = run({ targetCmd: 'node /opt/epam-cli/dist/epam.js run' });
    const imageIdx = argv.indexOf('epam-cli-sandbox:latest');
    expect(argv[imageIdx + 1]).toBe('node');
    expect(argv[imageIdx + 2]).toBe('/opt/epam-cli/dist/epam.js');
    expect(argv[imageIdx + 3]).toBe('run');
  });

  it('always bind-mounts epam-cli\'s own repo root read-only at /opt/epam-cli', () => {
    const argv = run({});
    const mountIdx = argv.findIndex((a) => a.endsWith(':/opt/epam-cli:ro'));
    expect(mountIdx).toBeGreaterThan(-1);
  });

  it('forwards *_API_KEY / EPAM_* env vars by name, but excludes EPAM_SANDBOX_* control vars', () => {
    const argv = run({ env: { ANTHROPIC_API_KEY: 'test-key', OPENROUTER_API_KEY: 'or-key' } });
    expect(argv).toContain('ANTHROPIC_API_KEY');
    expect(argv).toContain('OPENROUTER_API_KEY');
    expect(argv).not.toContain('EPAM_SANDBOX_TARGET_CMD');
    expect(argv).not.toContain('EPAM_SANDBOX_IMAGE');
  });

  it('appends passed-through args after the target command', () => {
    const argv = run({ targetCmd: 'node /opt/epam-cli/dist/epam.js run', extraArgs: ['--provider', 'openrouter'] });
    expect(argv.slice(-5)).toEqual(['run', '--json', '-', '--provider', 'openrouter']);
  });
});

describe('derive_sandbox_base_image — REAL execution (run-agent-orchestration.sh)', () => {
  function run(stack: { language?: string; runtime?: string } | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'derive-image-test-'));
    try {
      const prdFile = join(dir, 'prd.json');
      writeFileSync(prdFile, JSON.stringify(stack ? { project: { stack } } : {}));
      const fnBody = extractFunctionByLineAnchor(orchSrc, 'derive_sandbox_base_image');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, [fnBody, `derive_sandbox_base_image "${prdFile}"`].join('\n'));
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('maps Node/TypeScript stack to node:20-slim', () => {
    expect(run({ language: 'TypeScript', runtime: 'Node.js 20' })).toBe('node:20-slim');
  });

  it('maps Python stack to python:3.11-slim', () => {
    expect(run({ language: 'Python', runtime: 'Python 3.11' })).toBe('python:3.11-slim');
  });

  it('maps Go stack to golang:1.22-bookworm', () => {
    expect(run({ language: 'Go', runtime: 'Go 1.22' })).toBe('golang:1.22-bookworm');
  });

  it('maps Rust stack to rust:1.75-slim', () => {
    expect(run({ language: 'Rust', runtime: 'Rust 1.75' })).toBe('rust:1.75-slim');
  });

  it('falls back to node:20-slim when project.stack is entirely missing (older PRD)', () => {
    expect(run(null)).toBe('node:20-slim');
  });

  it('falls back to node:20-slim for an unrecognized stack rather than failing the build', () => {
    expect(run({ language: 'Cobol', runtime: 'Mainframe' })).toBe('node:20-slim');
  });

  it('is case-insensitive', () => {
    expect(run({ language: 'PYTHON', runtime: 'PYTHON 3.11' })).toBe('python:3.11-slim');
  });
});

describe('claude.sh epam-run branch — wired through the sandbox when active (static)', () => {
  it('the copilot|openai|openrouter|cursor|minimax branch checks EPAM_SANDBOX_IMAGE and swaps to $CLAUDE_CMD', () => {
    const branchStart = claudeSrc.indexOf('copilot|openai|openrouter|cursor|minimax)');
    expect(branchStart).toBeGreaterThan(-1);
    const branchEnd = claudeSrc.indexOf('\n            epam)', branchStart);
    const branchBody = claudeSrc.slice(branchStart, branchEnd);

    expect(branchBody).toMatch(/EPAM_SANDBOX_IMAGE/);
    expect(branchBody).toMatch(/_epam_run_binary="\$CLAUDE_CMD"/);
    expect(branchBody).toMatch(/_epam_sandbox_target="node \/opt\/epam-cli\/dist\/epam\.js"/);
    // The actual invocation must use the variable, not a literal $EPAM_CLI —
    // otherwise the sandbox branch above would be dead code.
    expect(branchBody).toMatch(/"\$_epam_run_binary"\s+run/);
    expect(branchBody).not.toMatch(/"\$EPAM_CLI"\s+run/);
  });

  it('EPAM_SANDBOX_TARGET_CMD is passed through to the invocation regardless of sandbox state (empty when not sandboxed)', () => {
    const branchStart = claudeSrc.indexOf('copilot|openai|openrouter|cursor|minimax)');
    const branchEnd = claudeSrc.indexOf('\n            epam)', branchStart);
    const branchBody = claudeSrc.slice(branchStart, branchEnd);
    expect(branchBody).toMatch(/EPAM_SANDBOX_TARGET_CMD="\$\{_epam_sandbox_target\}"/);
  });
});
