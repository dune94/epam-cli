/**
 * THE EFFECTIVE LLM SETTINGS FOR A PROJECT — engine base, project differences.
 *
 * claude.sh already reads an engine-wide config/llm-defaults.json, and its own comment states the
 * rule: "engine-wide defaults, project overrides. Two tiers so a project states only what it
 * changes." That inheritance was enumerated key by key and covered effortTiers, roleOverrides and
 * outputTokenFloors only.
 *
 * `ladders` and `modelOverrides` — the two largest blocks — were left out, so every project carried
 * a full copy of both. The cost was real: the same ten model pins lived in metrolinx, mock3 and
 * skyscanner, removing them on 2026-08-25 was the same edit four times, and onboarding a project
 * meant restating an entire ladder that the engine already had an opinion about.
 *
 * This is the one place that answers "what settings does this project actually run with".
 *
 * THE MERGE RULE, and why each part of it:
 *
 *   objects merge     so a project can override `ladders.medium.startModel` and keep the chain it
 *                     did not mention. Replacing whole objects would force a project to restate
 *                     everything to change one field, which is the duplication being removed.
 *
 *   arrays REPLACE    a modelLadder is a declaration, not a set of slots. Merging element-wise
 *                     would splice a project's two-hop chain into the engine's five-hop one and
 *                     produce a ladder nobody wrote — and an escalation path nobody reviewed.
 *
 *   project wins      wherever both speak. The engine's value is a default, never a policy.
 *
 * With no defaults declared this returns the project file unchanged, which is the state every
 * project is in today.
 */
const fs = require('fs');
const path = require('path');

/** Where the engine keeps its base. Overridable for tests and for an operator who relocates it. */
function defaultsPath(explicit) {
  if (explicit) return explicit;
  if (process.env.EPAM_LLM_DEFAULTS_FILE) return process.env.EPAM_LLM_DEFAULTS_FILE;
  return path.join(configDir(), 'llm-defaults.json');
}

/**
 * THE PROVIDER-SET REGISTRY. Where the sets are DECLARED, so the engine names none of them.
 *
 * Relocatable, and everything else is resolved relative to it: move the config dir and the
 * base, the sets and the registry travel together rather than half of them staying behind.
 */
function providerSetsPath() {
  return process.env.EPAM_PROVIDER_SETS_FILE
    || path.join(__dirname, '..', '..', 'config', 'provider-sets.json');
}

function configDir() { return path.dirname(providerSetsPath()); }

/**
 * The settings file for the ACTIVE set, or null when no registry exists (the state before
 * sets were introduced — absence must keep working, never become a new way to fail).
 *
 * AN UNKNOWN SET THROWS. It must never fall through to the default: a typo'd name that
 * quietly resolved would run a whole programme on the wrong stack while every log line looked
 * configured. That is the shape of the missing-tier fail-open seam-invocation.js records —
 * reported, then continued past — and it is not repeated here.
 */
function activeSet() {
  const registry = readJson(providerSetsPath());
  if (!registry || !registry.sets) return null;
  const declared = Object.keys(registry.sets);
  const wanted = process.env.EPAM_PROVIDER_SET || registry.defaultSet;
  if (!wanted) return null;
  const chosen = registry.sets[wanted];
  if (!chosen) {
    throw new Error(
      "[llm-settings] EPAM_PROVIDER_SET='" + wanted + "' is not a declared provider set — "
      + 'declared: ' + (declared.join(', ') || '(none)')
      + ' (see ' + providerSetsPath() + ')');
  }
  return { name: wanted, cfg: chosen, registry };
}

function activeSetFile() {
  const active = activeSet();
  if (!active) return null;
  const { name: wanted, cfg: chosen } = active;
  const file = path.join(configDir(), chosen.settingsFile);
  if (!fs.existsSync(file)) {
    // A HALF-SWAP IS REFUSED. A set that declares a file it does not have would resolve to no
    // ladders at all, which is worse than either stack: it looks configured and escalates nowhere.
    throw new Error(
      "[llm-settings] provider set '" + wanted + "' declares settingsFile '" + chosen.settingsFile
      + "' but it does not exist at " + file);
  }
  return file;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Deep-merge `over` onto `base`. Arrays replace; plain objects merge; everything else takes `over`.
 * Neither input is mutated — a cached defaults object must not acquire a project's values.
 */
function merge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(over) || Array.isArray(base)) return over;
  const bothObjects = base && over && typeof base === 'object' && typeof over === 'object';
  if (!bothObjects) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

/**
 * The settings a project actually runs with.
 *
 * @param {object}  o
 * @param {string}  o.projectConfigDir  the project whose llm-settings.json is the override layer
 * @param {string} [o.defaultsFile]     the engine base; defaults to config/llm-defaults.json
 * @returns {object} the merged settings — never null, so a caller need not guard
 */
/**
 * The merged settings WITHOUT the inherited-key filter.
 *
 * resolveLlmSettings deliberately returns only the blocks it owns (ladders, modelOverrides,
 * ladderTierOrder) because effortTiers and friends have their own precedence path in claude.sh
 * and merging them twice would give one setting two answers. `runners` has no such second
 * path, so it is read from the full merge rather than being added to that filter — which would
 * silently widen what every existing caller receives.
 */
function resolveLlmSettingsFull({ projectConfigDir, defaultsFile } = {}) {
  const explicit = defaultsFile || process.env.EPAM_LLM_DEFAULTS_FILE;
  let stack = readJson(defaultsPath(defaultsFile)) || {};
  if (!explicit) {
    const setFile = activeSetFile();
    if (setFile) stack = merge(stack, readJson(setFile) || {});
  }
  const project = projectConfigDir
    ? readJson(path.join(projectConfigDir, 'llm-settings.json'))
    : null;
  return merge(stack, project || {});
}

function resolveLlmSettings({ projectConfigDir, defaultsFile } = {}) {
  // ONLY the blocks this resolver owns are inherited. effortTiers/roleOverrides/outputTokenFloors
  // already have their own precedence path in claude.sh, and merging them here as well would give
  // one setting two answers.
  const INHERITED = ['ladderTierOrder', 'ladders', 'modelOverrides'];
  const onlyInherited = (o) => {
    const out = {};
    for (const k of INHERITED) if (o && o[k] !== undefined) out[k] = o[k];
    return out;
  };

  // THREE LAYERS, EACH WITH ONE JOB:
  //   base    set-INDEPENDENT engine values, shared by every set, so swapping providers never
  //           changes how much budget a tier gets
  //   set     WHICH MODELS this stack runs — the only layer a hot swap replaces
  //   project its own differences, and it still wins over both
  //
  // An explicit defaultsFile (or EPAM_LLM_DEFAULTS_FILE) is the operator's escape hatch and
  // REPLACES the set layer rather than stacking with it — one override, one answer.
  const explicit = defaultsFile || process.env.EPAM_LLM_DEFAULTS_FILE;
  let stack = onlyInherited(readJson(defaultsPath(defaultsFile)) || {});
  if (!explicit) {
    const setFile = activeSetFile();
    if (setFile) stack = merge(stack, onlyInherited(readJson(setFile) || {}));
  }

  const project = projectConfigDir
    ? readJson(path.join(projectConfigDir, 'llm-settings.json'))
    : null;
  return merge(stack, project || {});
}

/**
 * The env files a project has: the half that is true whatever stack it runs on, and the half
 * the active set decides.
 *
 * BOTH FILENAMES COME FROM THE REGISTRY. A loader that spelled `config.env` itself would put
 * the name in code, and renaming it would stop being a config edit. `{set}` is replaced by the
 * active set's declared suffix.
 *
 * The caller loads whichever of these exist. Order does not matter, because the two files must
 * declare DISJOINT keys — asserted by a test, so nobody has to remember a precedence rule.
 *
 * @returns {{base: string, overlay: string, set: string}|null} null when no registry declares them
 */
function projectEnvFiles(projectConfigDir) {
  if (!projectConfigDir) return null;
  const active = activeSet();
  if (!active || !active.registry.projectEnv) return null;
  const { base, overlay } = active.registry.projectEnv;
  if (!base || !overlay) return null;
  return {
    base: path.join(projectConfigDir, base),
    overlay: path.join(projectConfigDir, overlay.replace('{set}', active.cfg.projectEnvSuffix)),
    set: active.name,
  };
}

/**
 * WHAT A RUNNER TAKES — declared, never listed in code.
 *
 * The two execution paths were asymmetric: `ai-run` received every budget as environment,
 * while the external-CLI path received only a model and permissions. Every cap was therefore
 * INERT on that path, which is how one seam ran 1,486 turns with nothing able to stop it.
 *
 * The engine does not know a single knob name. A runner declares:
 *   alwaysFlags  flags passed unconditionally (a correctness requirement, not a preference)
 *   env          ENV_NAME -> the settings name whose resolved value it carries
 *   flags        --flag   -> likewise
 *
 * Adding a knob is a config edit. Returning null for an undeclared runner is what keeps this
 * additive: a path with no declaration behaves exactly as it did before runners existed.
 *
 * @returns {{alwaysFlags: string[], env: object, flags: object}|null}
 */
function resolveRunner(runnerName, { projectConfigDir, defaultsFile } = {}) {
  if (!runnerName) return null;
  const settings = resolveLlmSettingsFull({ projectConfigDir, defaultsFile });
  const declared = settings && settings.runners && settings.runners[runnerName];
  if (!declared) return null;
  return {
    alwaysFlags: Array.isArray(declared.alwaysFlags) ? declared.alwaysFlags : [],
    env: declared.env && typeof declared.env === 'object' ? declared.env : {},
    flags: declared.flags && typeof declared.flags === 'object' ? declared.flags : {},
  };
}

/**
 * Every settings name a runner's declaration points at.
 *
 * A map entry naming a setting nothing defines is a SILENT NO-OP — the precise defect this
 * layering exists to remove. Exposing the names lets a test assert each one actually resolves,
 * rather than discovering mid-run that a declared cap was never passed.
 */
function runnerSettingNames(runner) {
  if (!runner) return [];
  return [...new Set([...Object.values(runner.env || {}), ...Object.values(runner.flags || {})])];
}

/**
 * The VALUE for each name a runner declares — resolved, not merely named.
 *
 * A declaration that names a setting nothing can supply is a SILENT NO-OP, which is the defect
 * this layering exists to remove. Found live: the mockserver set declares
 * `ANTHROPIC_BASE_URL: mockBaseUrl`, and `mockBaseUrl` is a top-level key of the settings file
 * — not an operator override — so nothing resolved it and the redirect was never exported. The
 * mock would have looked configured and called the real endpoint.
 *
 * Precedence, highest first:
 *   1. EPAM_RUNNER_VALUE_<name>   an operator override, as everywhere else
 *   2. the resolved settings      a top-level key the stack declares
 * A name with neither is reported by runnerSettingNames() and skipped, never exported empty.
 */
function runnerValues(runnerName, { projectConfigDir, defaultsFile } = {}) {
  const runner = resolveRunner(runnerName, { projectConfigDir, defaultsFile });
  if (!runner) return null;
  const settings = resolveLlmSettingsFull({ projectConfigDir, defaultsFile });
  // THE RUN'S OWN ENV IS A SOURCE, NOT AN AFTERTHOUGHT.
  //
  // reasoningEffort and autoCompressAt are PER-MODEL values: the seam layer resolves them from
  // modelOverrides for the model this attempt is on and exports them as EPAM_*. They are not
  // top-level settings keys, so looking only there returned empty for every one of them and the
  // declaration named knobs nothing could fill — the silent no-op this layer exists to remove.
  //
  // The EPAM_ name is derived from the setting name by the project's existing convention
  // (camelCase -> UPPER_SNAKE), so a new setting needs no entry anywhere.
  const envNameFor = (name) => `EPAM_${String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
  const valueFor = (name) => {
    const override = process.env[`EPAM_RUNNER_VALUE_${name}`];
    if (override !== undefined && override !== '') return override;
    const fromRun = process.env[envNameFor(name)];
    if (fromRun !== undefined && fromRun !== '') return fromRun;
    const declared = settings ? settings[name] : undefined;
    return declared === undefined || declared === null ? '' : String(declared);
  };
  // envNames is returned alongside the values because a caller that knows MORE than this
  // resolver — the seam layer knows the tier and the model — must be able to fill a name this
  // one could not. Without it, every per-tier and per-model budget resolved empty and was
  // silently skipped, so the declaration named knobs nothing could fill.
  const out = { env: {}, flags: {}, alwaysFlags: runner.alwaysFlags, envNames: {}, flagNames: {} };
  for (const [k, name] of Object.entries(runner.env)) { out.env[k] = valueFor(name); out.envNames[k] = name; }
  for (const [k, name] of Object.entries(runner.flags)) { out.flags[k] = valueFor(name); out.flagNames[k] = name; }
  return out;
}

module.exports = {
  resolveLlmSettings, merge, activeSet, activeSetFile, providerSetsPath, projectEnvFiles,
  resolveRunner, runnerSettingNames, runnerValues,
};
