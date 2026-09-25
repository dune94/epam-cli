/**
 * A REAL INSTALL'S RUN, UPGRADED AND RESUMED AT £0 — on a copy, never the original.
 *
 * The one scenario a fresh fixture cannot reach: a run paused on an installed engine, the engine
 * upgraded by the real installer, the run resumed. What the run built (generated prompts, roster,
 * checkpoint, ledgers, codeline) is the install's own; what changed is the engine. So:
 *
 *   1. the install and its codeline are COPIED (the install's .env — its credentials — is not);
 *   2. every text file in the copy that names the real install or the real codeline is rewritten
 *      to the copy, and the launch is refused if any trace remains;
 *   3. the copy is upgraded by orchestrations-installer/install.sh at the ref under test — the
 *      release path, never a hand patch;
 *   4. the run named by the copy's newest checkpoint is resumed, every vendor at the agent;
 *   5. the real install's run state and the real codeline are fingerprinted before and after.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { ROOT, edgeFor } from '../integration/lib/fixture-install';
import { MockAgent } from './agent';
import { World } from './world';
import { currentConfig, type ProjectRun } from './harness';

const sh = (cmd: string, opts: { cwd?: string; timeout?: number } = {}) =>
  execFileSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 256 << 20, cwd: opts.cwd, timeout: opts.timeout ?? 600_000 });

/** Every text file under a tree that names `from`, rewritten to `to` (vendor trees skipped). */
function redirect(tree: string, from: string, to: string): number {
  const files = sh(`grep -rlIF --exclude-dir=node_modules --exclude-dir=.git -- ${JSON.stringify(from)} ${JSON.stringify(tree)} 2>/dev/null || true`).split('\n').filter(Boolean);
  for (const f of files) writeFileSync(f, readFileSync(f, 'utf8').split(from).join(to));
  return files.length;
}

/** What must not change on the real side: its run state and its codeline. */
export function realFingerprint(install: string, project: string, codeline: string): string {
  const parts = [join(install, 'orchestrations/projects', project), join(install, 'orchestrations/logs'), codeline];
  return sh(parts.filter(existsSync).map((p) => `find ${JSON.stringify(p)} -type f -not -path '*/.git/*' -printf '%P %s %T@\\n' | sort`).join('; ') + ' | md5sum');
}

export type StateRun = ProjectRun & { runId: string; realInstall: string; installLog: string };

export async function startStateRun(opts: { src: string; project: string; ref: string; dirs: string[]; children: ChildProcess[]; journal: string }): Promise<StateRun> {
  const tmp = mkdtempSync(join(tmpdir(), `state-rehearsal-${opts.project}-`)); opts.dirs.push(tmp);
  const install = join(tmp, 'install'); mkdirSync(install);
  sh(`tar -C ${JSON.stringify(opts.src)} --exclude=./.env -cf - . | tar -C ${JSON.stringify(install)} -xf -`, { timeout: 1_200_000 });
  const projDir = join(install, 'orchestrations/projects', opts.project);
  const realOut = (readFileSync(join(projDir, 'config.env'), 'utf8').match(/^OUTPUT_DIR=(.*)$/m) || [, ''])[1].trim();
  const out = join(tmp, basename(realOut) || 'codeline');
  if (realOut && existsSync(realOut)) sh(`cp -a ${JSON.stringify(realOut)} ${JSON.stringify(out)}`, { timeout: 1_200_000 });
  // The copy names only itself.
  redirect(install, opts.src, install);
  if (realOut) redirect(install, realOut, out);
  if (realOut && existsSync(out)) redirect(out, realOut, out);
  const leftovers = sh(`grep -rlIF --exclude-dir=node_modules --exclude-dir=.git -e ${JSON.stringify(opts.src)} ${realOut ? `-e ${JSON.stringify(realOut)}` : ''} ${JSON.stringify(install)} 2>/dev/null | head -5 || true`).trim();
  if (leftovers) throw new Error(`the copy still names the real install or codeline — refusing to run:\n${leftovers}`);
  // The release path: the real installer, at the ref under test, onto the copy.
  const config = currentConfig(opts.src);
  const set = config.EPAM_PROVIDER_SET || JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8')).defaultSet;
  const installLog = join(opts.journal, 'install.log');
  try {
    // THE INSTALLER RUNS WITH A SANDBOX HOME: it links a machine-wide `epam` command into
    // ~/.local/bin, and a rehearsal must touch nothing outside its copy (2026-09-25 it re-pointed
    // the operator's `epam` at a /tmp copy).
    const sandboxHome = join(tmp, 'home'); mkdirSync(sandboxHome, { recursive: true });
    sh(`HOME=${JSON.stringify(sandboxHome)} ${JSON.stringify(join(ROOT, 'orchestrations-installer/install.sh'))} --dest ${JSON.stringify(install)} --ref ${JSON.stringify(opts.ref)} --stack ${JSON.stringify(set)} --no-docker > ${JSON.stringify(installLog)} 2>&1 || true`, { cwd: ROOT, timeout: 1_800_000 });
  } catch { /* the log says why; the launch below will too */ }
  // The run to resume: the copy's newest checkpoint names it.
  const checkpoints = readdirSync(join(install, 'orchestrations/logs')).filter((f) => /^checkpoint-.*-(\d{8}T\d{6}Z)\.jsonl$/.test(f)).sort();
  const runId = (checkpoints.pop() || '').match(/(\d{8}T\d{6}Z)/)?.[1] || '';
  const cfg = readFileSync(join(projDir, 'config.env'), 'utf8');
  const prdRel = (cfg.match(/^PRD_FILE=(.*)$/m) || [, ''])[1].trim();
  const prd = prdRel.startsWith('/') ? prdRel : join(install, prdRel);
  const stories = () => { try { return (JSON.parse(readFileSync(prd, 'utf8')).stories || []).map((s: { id: string }) => s.id); } catch { return []; } };
  const modes = [/^EPAM_BROWNFIELD=1\s*$/m.test(cfg) ? 'brownfield' : 'greenfield'];
  const agent = new MockAgent(join(install, 'orchestrations'), opts.journal, stories, modes);
  await agent.start();
  edgeFor(install, agent.url, opts.children);
  const world = new World(() => [out], () => prd, projDir);
  return { install, out, agent, project: opts.project, prd, config, realOut, world, runId, realInstall: opts.src, installLog };
}
