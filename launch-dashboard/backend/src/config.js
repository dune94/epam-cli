/**
 * config.js — every setting, read once, from the environment, with no vendor or secret defaulted.
 *
 * A missing password or provider set is a STARTUP failure, not a runtime surprise. A misconfigured
 * install must fail where someone is watching, not at the first click that spends money.
 */
const REQUIRED = ['LAUNCH_PASSWORD', 'EPAM_PROVIDER_SET'];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(
      `missing required configuration: ${missing.join(', ')}. `
      + 'LAUNCH_PASSWORD gates a button that spends real money; EPAM_PROVIDER_SET must never be '
      + 'guessed — a guessed vendor is how MiniMax reached a claude run.',
    );
  }
  return {
    port: Number(env.PORT ?? 8099),
    host: env.HOST ?? '0.0.0.0',
    dbFile: env.RUNS_DB ?? '/data/runs.db',
    spoolDir: env.SPOOL_DIR ?? '/spool',
    password: env.LAUNCH_PASSWORD,
    providerSet: env.EPAM_PROVIDER_SET,
    // Recorded on every run so a replay can target the level it originally ran against.
    codeLevel: env.EPAM_CODE_LEVEL ?? null,
  };
}

export { loadConfig, REQUIRED };
