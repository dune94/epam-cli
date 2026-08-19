/**
 * REPLAY FIXTURES: A REAL REPOSITORY, NAMED BY THE OPERATOR — NEVER BY AN ABSOLUTE PATH.
 *
 * Several guards are strongest when replayed against a real client repository rather than a
 * synthetic one: the helper gate judged by real committed diffs, the lockfile gate against the
 * commit that actually shipped the desync, the SAST policy against the CVE that actually blocked.
 *
 * Those tests were written with `/home/bradleyjerome/projects/metrolinx/next.metrolinx.com` baked
 * in, guarded by `it.runIf(existsSync(...))`. On any other machine — or after the repository
 * moves — they SKIP SILENTLY and the file reports green. A guard that quietly stops guarding is
 * the failure mode these very tests exist to catch, so the coupling is worse here than elsewhere.
 *
 * The root now comes from EPAM_REPLAY_CODELINE_ROOT. When it is unset the tests still skip — there
 * is nothing to replay against — but `describe.skip` carries the reason in its title, so the
 * output says why instead of showing nothing at all.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROJECTS = join(__dirname, '../../orchestrations/projects');

/**
 * THE ROOTS ARE ALREADY DECLARED — they are not invented here.
 *
 * Every project's config.env states `JIRA_CODELINE_ROOT`, which is where the pipeline itself
 * finds that project's repositories, and the file already documents it as "the only permitted
 * source". Reading it is reading operator-declared configuration; writing an absolute path into
 * a test would be inventing a second, silently-drifting copy of the same fact.
 *
 * EPAM_REPLAY_CODELINE_ROOTS (colon-separated) overrides, for an operator whose checkout lives
 * somewhere the configs do not name.
 */
export function replayRoots(): string[] {
  const override = (process.env.EPAM_REPLAY_CODELINE_ROOTS || '').trim();
  if (override) return override.split(':').map((r) => r.trim()).filter(Boolean);
  const roots: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(PROJECTS); } catch { return roots; }
  for (const project of entries) {
    let text = '';
    try { text = readFileSync(join(PROJECTS, project, 'config.env'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = /^\s*JIRA_CODELINE_ROOT=(.+?)\s*$/.exec(line);
      if (m) roots.push(m[1].replace(/^["']|["']$/g, ''));
    }
  }
  return [...new Set(roots)];
}

/** The first declared root, or '' when none is declared. Kept for messages. */
export const replayRoot = (): string => replayRoots()[0] || '';

/** One repository, found under whichever declared root holds it, or '' when unavailable. */
export function replayRepo(name: string): string {
  for (const root of replayRoots()) {
    const dir = join(root, name);
    if (existsSync(join(dir, '.git'))) return dir;
  }
  return '';
}

/**
 * A title suffix that states why a replay block is skipped, so a silent skip is impossible to
 * mistake for a pass. Pass the result to `describe(...)`.
 */
export function replayTitle(base: string, repo: string, name: string): string {
  if (repo) return base;
  return replayRoots().length
    ? `${base} [SKIPPED: ${name} not found under any declared JIRA_CODELINE_ROOT]`
    : `${base} [SKIPPED: no JIRA_CODELINE_ROOT declared and EPAM_REPLAY_CODELINE_ROOTS unset]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY — a replay guard finds its subject; it never names one.
//
// Naming a repository, a branch or a commit writes one client's estate on one day into the
// ENGINE's test suite. The guard then proves something only for that estate, and rots the moment
// a branch is pruned. Every property these guards test ("a dependency the change ADDS is
// introduced; one already in the baseline is not") holds for any repository and any ecosystem, so
// the subject is found rather than stated.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { allManifests, lockfileFor } = require('../../orchestrations/scripts/lib/ecosystems.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFileSync } = require('node:child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readdirSync: readDirs, statSync } = require('node:fs');

type Eco = {
  file: string;
  lockfiles?: Record<string, string>;
  deps?: (text: string) => string[];
};

const git = (repo: string, args: string[]): string => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch { return ''; }
};

/** The ecosystem a repository carries, or null. Read from the one table, never guessed. */
export function ecosystemOf(repo: string): Eco | null {
  for (const eco of allManifests() as Eco[]) {
    if (existsSync(join(repo, eco.file))) return eco;
  }
  return null;
}

/**
 * Any real repository under the declared roots that carries BOTH a manifest and a lockfile of a
 * known ecosystem — the only two things a dependency replay needs. Returns '' when none exists.
 */
export function discoverManifestRepo(): string {
  for (const root of replayRoots()) {
    let entries: string[] = [];
    try { entries = readDirs(root); } catch { continue; }
    for (const name of entries.sort()) {
      const dir = join(root, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (!existsSync(join(dir, '.git'))) continue;
      const eco = ecosystemOf(dir);
      if (!eco || typeof eco.deps !== 'function') continue;
      if (!lockfileFor(eco, (f: string) => existsSync(join(dir, f)))) continue;
      return dir;
    }
  }
  return '';
}

export type DependencyChange = {
  repo: string;
  manifest: string;
  baseRef: string;
  headRef: string;
  added: string[];
  baselineDeps: string[];
  headDeps: string[];
};

/**
 * A real commit in this repository that really ADDED at least one dependency, found by walking the
 * manifest's own history and comparing the declared names on each side with the ecosystem's own
 * parser. Returns null when the history contains no such commit.
 */
export function discoverDependencyAddingChange(repo: string, limit = 60): DependencyChange | null {
  if (!repo) return null;
  const eco = ecosystemOf(repo);
  if (!eco || typeof eco.deps !== 'function') return null;

  const revs = git(repo, ['log', '--format=%H', `-n${limit}`, '--', eco.file])
    .split('\n').map((r) => r.trim()).filter(Boolean);

  const names = (ref: string): string[] | null => {
    const text = git(repo, ['show', `${ref}:${eco.file}`]);
    if (!text) return null;
    try { return eco.deps!(text) || []; } catch { return null; }
  };

  for (const head of revs) {
    const parent = git(repo, ['rev-parse', `${head}^`]).trim();
    if (!parent) continue;
    const before = names(parent);
    const after = names(head);
    if (!before || !after) continue;
    const added = after.filter((n) => !before.includes(n));
    if (added.length) {
      return { repo, manifest: eco.file, baseRef: parent, headRef: head, added,
               baselineDeps: before, headDeps: after };
    }
  }
  return null;
}

/** The lockfile a repository carries, from the one table, or '' when it carries none. */
export function lockfileOf(repo: string): string {
  const eco = ecosystemOf(repo);
  return eco ? lockfileFor(eco, (f: string) => existsSync(join(repo, f))) : '';
}
