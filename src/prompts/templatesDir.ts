/**
 * WHERE THE ENGINE KEEPS ITS PROMPT TEMPLATES — READ FROM CONFIG, NEVER WRITTEN HERE.
 *
 * Three files used to spell this out as a hardcoded walk up from __dirname, each with a DIFFERENT
 * level count:
 *
 *   src/scaffold/prompts.ts   '../..'      (two levels)
 *   src/agent/squad/roles.ts  '../../..'   (three)
 *   src/agent/PlanMode.ts     '../..'      (two)
 *
 * Every count is correct from that file's own place in the source tree and wrong from the compiled
 * bundle, because tsup flattens all of it into dist/*.js — ONE level below the engine root. Each
 * therefore resolved ABOVE the repository at runtime and threw ENOENT on a path like
 * /home/<user>/projects/orchestrations/prompts/templates. It cost three consecutive launches, and
 * no test could see it: the suite imports src/, where every guess happens to be right.
 *
 * A path baked into engine code is a fact the engine cannot be told. So the location is DATA —
 * orchestrations/config/engine-layout.json — with an environment override for a packaged install
 * that lays things out differently. Nothing here names a directory.
 *
 * The engine root itself is found by walking up to the package.json, which is a property of the
 * layout rather than a count of levels, so it is correct from src/ and from dist/ alike.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/** The engine's own root: the nearest ancestor with a package.json. Never a level count. */
export function engineRoot(): string {
  const override = process.env.EPAM_ENGINE_ROOT;
  if (override) return resolve(override);

  // __dirname: this package compiles to CommonJS, so import.meta is not available here.
  let dir = __dirname;
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error(`[layout] cannot locate the engine root by walking up from ${__dirname}`);
}

type LayoutEntry = { path?: string; env?: string };

/** One declared location from the layout config, with its environment override applied. */
function declaredDir(key: string): string {
  const root = engineRoot();
  const configFile = join(root, 'orchestrations', 'config', 'engine-layout.json');

  let entry: LayoutEntry;
  try {
    entry = (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, LayoutEntry>)[key];
  } catch (err) {
    throw new Error(
      `[layout] cannot read ${configFile}: ${(err as Error).message}. `
      + 'The engine does not know its own layout without it, and will not guess.',
    );
  }
  if (!entry || !entry.path) {
    throw new Error(`[layout] ${configFile} declares no '${key}.path'`);
  }

  // An override may be absolute (a packaged install elsewhere) or engine-relative.
  const override = entry.env ? process.env[entry.env] : undefined;
  const rel = override && override.trim() ? override.trim() : entry.path;
  return isAbsolute(rel) ? rel : join(root, rel);
}

let cached: string | undefined;

/**
 * The absolute path of the prompt-template directory.
 *
 * @throws when it cannot be found — a caller must never fall back to an inline prompt, which is
 *         the whole reason the template layer exists.
 */
export function templatesDir(): string {
  if (cached) return cached;
  const dir = declaredDir('promptTemplates');
  if (!existsSync(dir)) {
    throw new Error(
      `[layout] the declared prompt-template directory does not exist: ${dir}. `
      + 'Check promptTemplates.path in orchestrations/config/engine-layout.json.',
    );
  }
  cached = dir;
  return dir;
}

/** The absolute path of one template file. Does not check that it exists. */
export function templatePath(id: string): string {
  return join(templatesDir(), `${id}.json`);
}
