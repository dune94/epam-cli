/**
 * config.js — every setting, read once, from the environment, with no vendor or secret defaulted.
 *
 * A missing password is a STARTUP failure, not a runtime surprise. A misconfigured install must
 * fail where someone is watching, not at the first click that spends money.
 *
 * EPAM_PROVIDER_SET used to be REQUIRED here — a single value fixed for every launch this server
 * would ever make. It is gone: every request now declares its own provider set (createRun/
 * resumeRun in runs-store.js validate it per-request), so a server-wide default would be at best
 * unused and at worst a stale value nothing reads. The mount that used to back it
 * (orchestrations/config/provider-sets.json, read by provider-sets.js) is still required — see
 * server.js, which reads it once at startup so a missing/misconfigured mount fails loudly there.
 */
const REQUIRED = ['LAUNCH_PASSWORD'];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(
      `missing required configuration: ${missing.join(', ')}. `
      + 'LAUNCH_PASSWORD gates a button that spends real money.',
    );
  }
  return {
    port: Number(env.PORT ?? 8099),
    host: env.HOST ?? '0.0.0.0',
    dbFile: env.RUNS_DB ?? '/data/runs.db',
    spoolDir: env.SPOOL_DIR ?? '/spool',
    password: env.LAUNCH_PASSWORD,
    // Recorded on every run so a replay can target the level it originally ran against.
    codeLevel: env.EPAM_CODE_LEVEL ?? null,
  };
}

export { loadConfig, REQUIRED };
