/**
 * EVERY SEAM RESOLVES THE SAME WITH OR WITHOUT THE SHELL EXPORTS.
 *
 * Two paths resolve a seam's model, chain, budget and tools: shell callers source
 * model-ladders.sh, which exports EPAM_MODEL_LADDER_TIER_ORDER and one chain per tier from the
 * project's effective settings; JS callers (ac-gate.js, spec-mode-runner.js, codeline-discovery
 * under resolve-codeline-scope.sh) call seamInvocationEnv directly. The second path read only the
 * project's llm-settings.json for the tier order and chains — a file that has carried neither
 * since the ladders moved to the provider SET on 2026-08-25. So without the exports every seam
 * resolved NO model on every set ("asks for ladder position X but EPAM_MODEL_LADDER_TIER_ORDER is
 * unset"), and the 2026-09-01 rename of every seam to a literal tier name changed nothing.
 * Found 2026-09-11 by snapshotting both paths on every set and project.
 *
 * This test IS that snapshot: for every provider set and every declared seam, the environment
 * seamInvocationEnv hands out with nothing exported must equal the one it hands out after
 * model-ladders.sh has exported — and both must carry a model. It also holds the registry to
 * positions: a seam declares base/mid/top, never a set's tier name.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const sets = Object.keys(JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).sets);
// EVERY project the repository declares — derived, none named. A project is data; a test that names
// one tests that one and certifies the rest by assumption.
const PROJECTS = readdirSync(join(ROOT, 'orchestrations/projects'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'orchestrations/projects', e.name, 'config.env')))
  .map((e) => join(ROOT, 'orchestrations/projects', e.name));
const cases = sets.flatMap((set) => PROJECTS.map((project) => ({ set, project, name: `${set} × ${project.split('/').pop()}` })));

/** One line per seam: the resolved env, in a fresh process so nothing leaks between sets. */
const snapshotJs = `
const m = require(${JSON.stringify(join(SCRIPTS, 'lib/seam-invocation.js'))});
const reg = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(ROOT, 'orchestrations/agents/invocation-profiles.json'))}, 'utf8'));
for (const seam of Object.keys(reg.profiles).sort()) {
  const env = m.seamInvocationEnv(seam, ${JSON.stringify(join(ROOT, 'orchestrations/agents'))});
  const keep = Object.entries(env).filter(([k]) => /^EPAM_(MODEL|MAX_|REASONING|TIMEOUT_SECS|ALLOWED_TOOLS|LADDER)/.test(k)).sort();
  process.stdout.write(seam + ' ' + JSON.stringify(Object.fromEntries(keep)) + '\\n');
}`;

function snapshot(set: string, project: string, withExports: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'seam-snap-'));
  writeFileSync(join(d, 'snap.js'), snapshotJs);
  const exports = withExports
    ? `. ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))} >/dev/null 2>&1; export_model_ladders "$EPAM_PROJECT_CONFIG_DIR/llm-settings.json" >/dev/null 2>&1;`
    : '';
  const r = spawnSync('bash', ['-c', `${exports} exec "$NODE_BIN" ${JSON.stringify(join(d, 'snap.js'))}`], {
    encoding: 'utf8', timeout: 60_000, cwd: ROOT,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: set, EPAM_PROJECT_CONFIG_DIR: project },
  });
  return { out: (r.stdout || '').trim(), err: r.stderr || '' };
}

describe('every seam resolves the same with or without the exports', () => {
  it('there are sets and projects to check', () => { expect(sets.length).toBeGreaterThan(1); expect(PROJECTS.length).toBeGreaterThan(0); });

  it.each(cases)('on $name: nothing exported resolves exactly what model-ladders.sh exports, and every seam has a model', ({ set, project }) => {
    const bare = snapshot(set, project, false);
    const exported = snapshot(set, project, true);
    expect(exported.out.split('\n').length, 'the exported snapshot is empty').toBeGreaterThan(20);
    expect(exported.out.split('\n').filter((l) => !/"EPAM_MODEL":/.test(l)), `seams with no model even after the exports (${set})`).toEqual([]);
    expect(bare.out.split('\n').filter((l) => !/"EPAM_MODEL":/.test(l)), `seams with no model without the exports (${set}):\n${bare.err.slice(-600)}`).toEqual([]);
    expect(bare.out, `the two paths disagree on the ${set} set`).toBe(exported.out);
    expect(bare.err, 'the resolver still complains about an unset tier order').not.toMatch(/EPAM_MODEL_LADDER_TIER_ORDER is unset/);
  });

  it('the registry declares positions, never a tier name a set owns', () => {
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    const positions: string[] = reg._ladderPositions?.names || [];
    expect(positions.length).toBeGreaterThan(1);
    const bad = Object.entries<any>(reg.profiles).filter(([, p]) => p.ladder && !positions.includes(p.ladder)).map(([n, p]) => `${n} -> ${p.ladder}`);
    expect(bad).toEqual([]);
  });
});
