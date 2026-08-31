import { defineConfig } from 'vitest/config';
import { cpus, totalmem } from 'node:os';
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

// HOW LARGE ONE WORKER MAY GROW BEFORE IT IS KILLED.
//
// Capping the worker COUNT bounds how many children exist; it does not bound how large any one of
// them may grow. A single file that accumulates grows until the OS picks a victim, and on a WSL box
// the victim is the box. This suite has taken the machine down three times, and twice the response
// was to lower the worker count — which changes the odds, not the outcome.
//
// Derived from the machine, never fixed: total RAM at config time, half left for the parent, docker
// and the OS, the rest split between workers. With a ceiling a leaking file dies with a heap error
// NAMING ITSELF, the run continues, and the leak becomes a finding instead of a reboot.
const TOTAL_MB = Math.floor(totalmem() / (1024 * 1024));
const WORKER_HEAP_MB = Number(process.env.EPAM_TEST_WORKER_HEAP_MB)
  || Math.max(512, Math.floor((TOTAL_MB * 0.5) / MAX_WORKERS));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // ARCHIVED TESTS ARE NOT RUN. test/archived holds files that were red at the measured
    // baseline — kept, tracked and documented in test/archived/MANIFEST.json, but excluded here so
    // the suite reports on tests that are actually protecting something. Restoring one is a move
    // back under test/.
    include: ['test/**/*.test.ts', 'greet.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/archived/**'],
    // B29: default COMPOSE_OVERRIDE to a throwaway path so no test can rewrite
    // the repo's live dashboard mount config. See the setup file for why this is
    // a global default rather than a per-call-site fix.
    setupFiles: ['test/setup/compose-override-guard.ts'],

    // FORKS, NOT THREADS. These tests shell out constantly; a forked pool reclaims a child's
    // memory when the worker exits, where threads in one process accumulate it for the whole run.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: MAX_WORKERS,
        minForks: 1,
        execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
      },
      threads: { maxThreads: MAX_WORKERS, minThreads: 1 },
    },

    // WHAT THE REPORTER KEEPS. The parent holds every failure until the run ends, and this suite
    // fails in the hundreds; an assertion comparing two large arrays retains both sides, so the
    // REPORT outgrows the tests it describes. Truncated to what a human reads anyway.
    outputTruncateLength: Number(process.env.EPAM_TEST_OUTPUT_TRUNCATE) || 2000,
    outputDiffMaxSize: Number(process.env.EPAM_TEST_DIFF_MAX) || 20000,

    coverage: {
      provider: 'v8',
      // WRITE THE REPORT EVEN WHEN TESTS FAIL. Defaults to FALSE, so one failing test anywhere
      // silently suppresses the whole coverage report — no lcov, no table, no warning. Two 800s
      // runs produced nothing and looked like coverage had simply not been requested.
      //
      // Measurement must not depend on a green suite: coverage is how the gaps are found, and a
      // report available only once everything passes is unavailable exactly when it is needed.
      reportOnFailure: true,
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
