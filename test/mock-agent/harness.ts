/**
 * A £0 RUN OF A REAL PROJECT, DRIVEN BY THE MOCKING AGENT.
 *
 * The project's own data (config, canonical PRD) is copied into a fixture install of this working
 * tree; its generated artefacts are left behind so the run generates them itself. Every vendor
 * endpoint the providers read is pointed at the agent, the codeline goes to a temporary directory,
 * and the real launcher runs. Nothing of the pipeline is imported, lifted or stubbed.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureInstall, edgeFor, zeroCostEnv, run, ROOT } from '../integration/lib/fixture-install';
import { MockAgent } from './agent';
import { World } from './world';
import type { ChildProcess } from 'node:child_process';

export type ProjectRun = { install: string; out: string; agent: MockAgent; project: string; prd: string; config: Record<string, string>; realOut: string; world: World };

/** Copy a project from another install, leaving behind everything a run generates. */
export function adoptProject(src: string, project: string, install: string): void {
  const generated = JSON.parse(readFileSync(join(ROOT, 'orchestrations-installer/generated-run-state-paths.json'), 'utf8')).paths as string[];
  const runState = JSON.parse(readFileSync(join(ROOT, 'orchestrations-installer/run-state-paths.json'), 'utf8')).paths as string[];
  const leaveBehind = [...generated, ...runState]
    .map((p) => p.match(/^orchestrations\/projects\/\*\/(.+)$/)).filter(Boolean)
    .map((m) => new RegExp('^' + m![1].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '(/|$)'));
  const from = join(src, 'orchestrations/projects', project);
  const dest = join(install, 'orchestrations/projects', project);
  cpSync(from, dest, { recursive: true, filter: (f) => {
    const rel = f.slice(from.length + 1);
    return !rel || !leaveBehind.some((r) => r.test(rel) || r.test(rel + '/'));
  } });
  const cfg = readFileSync(join(dest, 'config.env'), 'utf8');
  const canonical = (cfg.match(/^PRD_CANONICAL=(.*)$/m) || [, ''])[1].trim();
  if (canonical && !canonical.startsWith('/')) { mkdirSync(join(install, canonical, '..'), { recursive: true }); cpSync(join(src, canonical), join(install, canonical)); }
}

/** A credential is never carried: its name says so. */
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|COOKIE)/i;
/** Endpoints the run must reach only at the agent. */
const ENDPOINT = /(_BASE_URL|_URL|_HOST|_ENDPOINT)$/;

/** The install's CURRENT configuration (.env), minus credentials and endpoints — as the operator set it. */
export function currentConfig(src: string): Record<string, string> {
  const f = join(src, '.env'); const out: Record<string, string> = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || SECRET.test(m[1]) || ENDPOINT.test(m[1])) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Every string in the adopted data that names the project's REAL codeline now names the fixture's.
 * Generic: the real path is whatever the project's own config declares, wherever the data repeats it.
 */
function redirectCodeline(install: string, projDir: string, realOut: string, out: string, prd: string) {
  if (!realOut) return;
  const files = [...readdirSync(projDir).map((f) => join(projDir, f)), prd].filter((f) => { try { return readFileSync(f, 'utf8').length >= 0; } catch { return false; } });
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    if (t.includes(realOut)) writeFileSync(f, t.split(realOut).join(out));
  }
  const left = files.filter((f) => readFileSync(f, 'utf8').includes(realOut));
  if (left.length) throw new Error(`the fixture still names the real codeline ${realOut} in ${left.join(', ')} — refusing to launch`);
}

export async function startProjectRun(opts: { src: string; project: string; dirs: string[]; children: ChildProcess[]; journal: string }): Promise<ProjectRun> {
  const install = fixtureInstall(opts.dirs);
  adoptProject(opts.src, opts.project, install);
  const projDir = join(install, 'orchestrations/projects', opts.project);
  // Named as the real codeline is named: the pipeline names a codeline by its directory, and a run
  // on the fixture must see the name a real run sees.
  const realName = basename((readFileSync(join(projDir, 'config.env'), 'utf8').match(/^OUTPUT_DIR=(.*)$/m) || [, 'codeline'])[1].trim()) || 'codeline';
  const out = join(mkdtempSync(join(tmpdir(), `mock-agent-${opts.project}-`)), realName); opts.dirs.push(join(out, '..'));
  // THE CODELINE IS NEVER THE PROJECT'S REAL ONE. The environment wins over config (load_project_env
  // preserve), and every copy of the real path in the adopted data is redirected, so a run can reach
  // nothing else.
  const cfgPath = join(projDir, 'config.env');
  const realOut = (readFileSync(cfgPath, 'utf8').match(/^OUTPUT_DIR=(.*)$/m) || [, ''])[1].trim();
  const prdRel = (readFileSync(cfgPath, 'utf8').match(/^PRD_CANONICAL=(.*)$/m) || [, ''])[1].trim();
  const prd = prdRel.startsWith('/') ? prdRel : join(install, prdRel);
  redirectCodeline(install, projDir, realOut, out, prd);
  const stories = () => { try { return (JSON.parse(readFileSync(prd, 'utf8')).stories || []).map((s: any) => s.id); } catch { return []; } };
  // The project's modes, as the registry's appliesTo speaks of them: its own EPAM_BROWNFIELD declaration.
  const modes = [/^EPAM_BROWNFIELD=1\s*$/m.test(readFileSync(cfgPath, 'utf8')) ? 'brownfield' : 'greenfield'];
  const agent = new MockAgent(join(install, 'orchestrations'), opts.journal, stories, modes);
  await agent.start();
  edgeFor(install, agent.url, opts.children);
  const world = new World(() => [out], () => prd, projDir);
  return { install, out, agent, project: opts.project, prd, config: currentConfig(opts.src), realOut, world };
}

/**
 * The provider set the install is CURRENTLY on, and what that set declares it needs: its own
 * credential names (config/provider-sets.json). A vendor's endpoint variable is named the way the
 * providers read it — the credential's vendor prefix with _BASE_URL — so every vendor the set can
 * call answers at the agent, and no vendor is named here.
 */
export function vendorEdge(r: ProjectRun): Record<string, string> {
  const sets = JSON.parse(readFileSync(join(r.install, 'orchestrations/config/provider-sets.json'), 'utf8'));
  const set = r.config.EPAM_PROVIDER_SET || sets.defaultSet;
  const decl = sets.sets?.[set];
  if (!decl) throw new Error(`the install's current set '${set}' is not declared in provider-sets.json`);
  const env: Record<string, string> = { EPAM_PROVIDER_SET: set };
  for (const c of decl.credentials || []) {
    // Never a usable value: EPAM_FREE_RUN makes the pipeline's own guard replace it and refuse any
    // key-shaped value that survives.
    env[c.from] = 'mock-no-spend';
    const vendor = String(c.from).replace(/_API_KEY$/, '');
    if (vendor !== c.from) env[`${vendor}_BASE_URL`] = r.agent.url;
  }
  return env;
}

/** Launch the project through its real launcher, on the install's current configuration. */
export function launch(r: ProjectRun, extra: Record<string, string> = {}, timeoutMs = 60 * 60_000) {
  const env = zeroCostEnv(join(r.install, '.edge-bin'), r.agent.url, {
    ...r.config,
    ...vendorEdge(r),
    EPAM_FREE_RUN: '1',
    OUTPUT_DIR: r.out, EPAM_PAUSE_AFTER_AGENT_MINT: '0', EPAM_PAUSE_BEFORE_WRITER: '0',
    EPAM_PROJECT_CONFIG_DIR: '',
    ...extra,
  });
  return run('bash', [join(r.install, 'orchestrations/scripts/tier3-run.sh'), '--project', r.project, '--yes'], { cwd: r.install, env, timeout: timeoutMs });
}
