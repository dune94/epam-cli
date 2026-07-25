import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'greet.test.ts'],
    // B29: default COMPOSE_OVERRIDE to a throwaway path so no test can rewrite
    // the repo's live dashboard mount config. See the setup file for why this is
    // a global default rather than a per-call-site fix.
    setupFiles: ['test/setup/compose-override-guard.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'orchestrations/scripts/**/*.js'],
      exclude: ['src/**/*.d.ts', 'orchestrations/scripts/**/*.test.js'],
    },
  },
  resolve: {
    alias: {
      '@': '/home/bjerome/projects/ai/epam-cli/src',
    },
  },
});
