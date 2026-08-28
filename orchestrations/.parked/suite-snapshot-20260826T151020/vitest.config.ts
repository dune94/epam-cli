import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// HOW MANY WORKERS THIS SUITE MAY USE.
//
// vitest defaults to one worker per CPU. This suite is over a thousand files and hundreds of
// them spawn bash, git and node SUBPROCESSES — so 16 workers each holding several children
// exhausted a 13GB WSL box and killed the machine mid-run, twice. A suite that cannot be run is
// a suite that is not run: the real failure count went unmeasured because of it.
//
// Half the cores, capped at 6, and overridable. Not a number frozen here — a larger machine
// should use what it has, and a smaller one should be able to go lower still.
const MAX_WORKERS = Number(process.env.EPAM_TEST_MAX_WORKERS)
  || Math.max(1, Math.min(6, Math.floor((cpus()?.length || 2) / 2)));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'greet.test.ts'],
    // B29: default COMPOSE_OVERRIDE to a throwaway path so no test can rewrite
    // the repo's live dashboard mount config. See the setup file for why this is
    // a global default rather than a per-call-site fix.
    setupFiles: ['test/setup/compose-override-guard.ts'],

    // FORKS, NOT THREADS. These tests shell out constantly; a forked pool reclaims a child's
    // memory when the worker exits, where threads in one process accumulate it for the whole run.
    pool: 'forks',
    poolOptions: {
      forks: { maxForks: MAX_WORKERS, minForks: 1 },
      threads: { maxThreads: MAX_WORKERS, minThreads: 1 },
    },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'orchestrations/scripts/**/*.js'],
      exclude: ['src/**/*.d.ts', 'orchestrations/scripts/**/*.test.js'],
    },
  },
  resolve: {
    alias: {
      // RELATIVE TO THIS FILE, not to one developer's home directory. This read
      // '/home/bjerome/projects/ai/epam-cli/src' — a username that does not exist in this
      // checkout — so every `@/...` import has been resolving to nothing on every machine
      // since whoever wrote it moved on.
      '@': resolve(HERE, 'src'),
    },
  },
});
