/**
 * What the ENGINE owns. One definition, because three copies is how they drift.
 *
 * These directories hold epam-cli's own state — knowledge base, agent profiles, run
 * logs, code indexes, telemetry, contracts. None of it is client content. It must never
 * be created inside a client codeline: not committed, not staged, not WRITTEN.
 *
 * Live metrolinx 20260804T225443Z: `orchestrations/agents/KB.md` was created inside the
 * upexpress client repo, because the writer prompt says "append one entry to
 * `orchestrations/agents/KB.md`" — a relative path — while the agent's cwd is the client
 * codeline. It then entered that lane's writer-output manifest as though the writer had
 * produced it.
 *
 * This had already been fixed once, at ONE of three staging sites (lib/git-ops.sh, whose
 * comment records the 2026-08-01 incident). worktree-health-check.sh excluded only
 * `orchestrations/logs/*`, and Step 9's auto-commit excluded nothing at all. Filtering at
 * the commit seam is cleanup, not a perimeter — by then the file already exists in the
 * customer's working tree. The perimeter is the WRITE.
 *
 * These are the engine's own artefact names — engine self-knowledge, not facts about any
 * client's stack. Adding a new engine artefact directory means adding it here, once.
 */
import fs from 'fs';
import path from 'path';

export const ENGINE_OWNED_DIRS = [
  'orchestrations',
  '.epam',
  '.codegraph',
  '.deepeval',
  '.contracts',
] as const;

/**
 * True when `relPath` (repo-relative, POSIX or native separators) lies inside one of the
 * engine's own directories.
 *
 * Compares whole path SEGMENTS rather than matching a pattern: `src/orchestrations-ui/`
 * is client code and must not be caught, while `orchestrations/agents/KB.md` and
 * `packages/web/.epam/settings.json` both must be.
 */
export function isEngineOwnedPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/).filter((s) => s && s !== '.');
  return segments.some((seg) => (ENGINE_OWNED_DIRS as readonly string[]).includes(seg));
}

/**
 * Where epam-cli itself lives. Inside it, engine paths are legitimate — that IS the
 * engine's own state. Everywhere else they are a perimeter breach.
 *
 * Derived from this module's own location, NOT from process.cwd(): an agent runs with its
 * cwd set to the client codeline, so a cwd-relative rule answers the wrong question and
 * silently permits the write. `EPAM_ENGINE_ROOT` overrides for tests and unusual layouts.
 */
export function engineRoot(): string {
  const override = process.env.EPAM_ENGINE_ROOT;
  if (override) return path.resolve(override);
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '../..');
}

/**
 * The perimeter test: would writing `absPath` put engine state inside something that is
 * not the engine? Answers the question for an ABSOLUTE path, independent of cwd.
 */
export function breachesEnginePerimeter(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const root = engineRoot();
  const insideEngine = resolved === root || resolved.startsWith(root + path.sep);
  if (insideEngine) return false;
  return isEngineOwnedPath(resolved);
}
