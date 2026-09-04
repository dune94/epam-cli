import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// TRUE PATH ISOLATION for the "missing tool" test: prefixing PATH with a stub dir does not make a
// tool ABSENT if the real one is still findable further down PATH (jq typically lives in /usr/bin
// alongside grep/awk/etc, so excluding jq's directory wholesale would also break those). Instead
// build one bin dir containing SYMLINKS to only the real tools the script actually needs, minus
// whichever names are deliberately excluded — a genuinely restricted PATH, not a hopeful prefix.
function isolatedBin(dir: string, need: string[], exclude: string[] = []) {
  const bin = path.join(dir, 'isolated-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of need) {
    if (exclude.includes(name)) continue;
    let real: string;
    try {
      real = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {
      continue; // not on this host at all — nothing to link
    }
    if (real) fs.symlinkSync(real, path.join(bin, name));
  }
  return bin;
}

/**
 * pipeline-health.sh answers "can an operator launch a run from here, right now" — a different
 * question from install.sh --check ("did the install complete"). These tests build a minimal
 * fixture tree and STUB every external command it probes, so each assertion proves the SCRIPT's
 * own logic reacts correctly to a real signal, never that a real tool happened to be present on
 * the machine running the test.
 */
const REPO = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'orchestrations-installer/pipeline-health.sh';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-health-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, SCRIPT_REL), path.join(dir, SCRIPT_REL));
  fs.chmodSync(path.join(dir, SCRIPT_REL), 0o755);

  fs.writeFileSync(
    path.join(dir, 'orchestrations/config/provider-sets.json'),
    JSON.stringify({
      defaultSet: 'claude',
      sets: {
        claude: { settingsFile: 'llm-defaults.claude.json', credentials: [] },
        openrouter: {
          settingsFile: 'llm-defaults.openrouter.json',
          credentials: [
            { env: 'EPAM_API_KEY_OPENROUTER', from: 'OPENROUTER_API_KEY', required: true },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'orchestrations/config/llm-defaults.claude.json'),
    JSON.stringify({ runners: { claude: {} } }),
  );
  fs.writeFileSync(
    path.join(dir, 'orchestrations/config/llm-defaults.openrouter.json'),
    JSON.stringify({ runners: {} }),
  );

  // Real node and bash — only the pipeline-facing binaries (git/jq/python3/claude/docker) are
  // stubbed, so PATH is prefixed, never replaced.
  for (const cmd of ['git', 'jq', 'python3', 'claude']) {
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/bash\nexit 0\n`);
    fs.chmodSync(path.join(bin, cmd), 0o755);
  }
  return { dir, bin };
}

const run = (f: { dir: string; bin: string }, env: Record<string, string> = {}) =>
  spawnSync('bash', [path.join(f.dir, SCRIPT_REL)], {
    cwd: f.dir, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, HOME: f.dir, ...env },
  });

describe('pipeline-health.sh', () => {
  it('reports the resolved stack and its runner, read live from provider-sets.json — never hardcoded', () => {
    const f = fixture();
    const r = run(f);
    expect(r.stdout).toMatch(/resolved stack: claude/);
    expect(r.stdout).toMatch(/'claude' runner is on PATH/);
  });

  it('EPAM_PROVIDER_SET overrides the default and its OWN required credentials are checked', () => {
    const f = fixture();
    const r = run(f, { EPAM_PROVIDER_SET: 'openrouter', OPENROUTER_API_KEY: '' });
    expect(r.stdout).toMatch(/resolved stack: openrouter/);
    // _bad() (✗ lines) writes to stderr, by design — combine both streams for a failure assertion.
    expect(`${r.stdout}${r.stderr}`, `did not flag the missing required credential:\n${r.stdout}\n${r.stderr}`).toMatch(/OPENROUTER_API_KEY/);
    expect(r.status, 'a missing required credential must fail the check').toBe(1);
  });

  it('flags ANTHROPIC_API_KEY as an OAuth-outranking trap on the claude stack, never silently', () => {
    const f = fixture();
    const r = run(f, { ANTHROPIC_API_KEY: 'sk-ant-fake' });
    expect(r.stdout, `did not warn about the API key outranking OAuth:\n${r.stdout}`).toMatch(/OUTRANKS/);
  });

  it('a missing required command fails the check with a concrete fix, not a silent skip', () => {
    const f = fixture();
    // TRUE isolation, not just a stub removed from a PREFIX: jq typically shares /usr/bin with
    // grep/awk/etc, so simply dropping the stub still finds the real jq further down PATH. Build a
    // bin dir with symlinks to only what the script needs, minus jq.
    const iso = isolatedBin(f.dir, ['bash', 'node', 'uname', 'grep', 'awk', 'wc', 'cut', 'df', 'find', 'git', 'python3', 'dirname', 'head'], ['jq']);
    const r = spawnSync('bash', [path.join(f.dir, SCRIPT_REL)], {
      cwd: f.dir, encoding: 'utf8', timeout: 20_000,
      env: { PATH: iso, HOME: f.dir },
    });
    expect(`${r.stdout}${r.stderr}`, `no failure reported for missing jq:\n${r.stdout}\n${r.stderr}`).toMatch(/jq is missing/);
    expect(r.status).toBe(1);
  });

  it('a dead epam shim (points at a file that no longer exists) is caught, not reported healthy', () => {
    const f = fixture();
    const shimDir = path.join(f.dir, '.local/bin');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'epam'), `#!/usr/bin/env bash\nexec node "/no/such/path/dist/epam.js" "$@"\n`);
    const r = run(f);
    expect(`${r.stdout}${r.stderr}`, `did not catch the dead shim:\n${r.stdout}\n${r.stderr}`).toMatch(/epam shim.*points at a missing file/);
    expect(r.status).toBe(1);
  });

  it('exits 0 when every check passes — a genuinely healthy fixture is reported healthy', () => {
    const f = fixture();
    const r = run(f);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/healthy — ready to launch|runnable, with warnings/);
  });
});

/**
 * A HEALTH CHECK THAT ONLY CHECKS DAEMONS IS HALF A HEALTH CHECK.
 *
 * This script proved runner-host and snapshot-watch were alive and never asked whether the services
 * they exist to serve actually answer. Three operator-facing breakages got through it in one day,
 * each found by a human opening a browser: the dashboard serving 404 for /prd.json ("data offline"),
 * Langfuse and Grafana probed on the compose defaults instead of this install's isolated ports, and
 * nginx unable to serve /logs/*. Every one is a single curl.
 *
 * THE SERVICE LIST IS DERIVED from config/services.json, never named in the script — a service added
 * there tomorrow is probed tomorrow. Required-vs-optional is derived too: a service that declares a
 * stateVar is one this install allocates a port for, so it is part of the stack and must answer.
 */
describe('pipeline-health probes the declared service endpoints, not just the daemons', () => {
  const HEALTH = fs.readFileSync(path.join(REPO, SCRIPT_REL), 'utf8');
  const SERVICES = JSON.parse(
    fs.readFileSync(path.join(REPO, 'orchestrations/config/services.json'), 'utf8'),
  ).services as Record<string, Record<string, string>>;

  it('names no service in the script — the registry is the source', () => {
    const code = HEALTH.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    // 'dashboard' survives as the ONE derived sub-probe (its /logs and /prd.json mounts), which is
    // a property of that endpoint's content, not a second list of services.
    for (const name of Object.keys(SERVICES).filter((n) => n !== 'dashboard')) {
      expect(code, `${name} is spelled in the script — add it to services.json instead`)
        .not.toContain(`"${name}"`);
    }
  });

  it('resolves endpoints through service_url, so an isolated install is probed on ITS ports', () => {
    expect(HEALTH, 'a literal URL would pass against a service nobody is using')
      .toMatch(/service_url/);
    expect(HEALTH).toMatch(/service-urls\.sh/);
  });

  it('probes the dashboard MOUNTS, not only that nginx answers on /', () => {
    // Both were broken while / returned 200 — that is exactly how "data offline" reached a human.
    expect(HEALTH).toMatch(/\/logs\/agent-status\.json/);
    expect(HEALTH).toMatch(/\/prd\.json/);
  });

  it('does not fail a run over a trace sink the stack can never write to', () => {
    // Langfuse traces come from wrapWithTracing inside the epam CLI; a runner that shells out to a
    // vendor CLI never reaches it. Declared per runner as emitsTraces.
    expect(HEALTH).toMatch(/emitsTraces/);
  });

  it('install.sh runs it as a post-install step — the last word of an install is a probe, not a report', () => {
    const installer = fs.readFileSync(path.join(REPO, 'orchestrations-installer/install.sh'), 'utf8');
    expect(installer, 'an installer that only reports on its own steps is reporting on itself')
      .toMatch(/pipeline-health\.sh/);
  });
});
