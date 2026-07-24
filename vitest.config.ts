import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'greet.test.ts'],
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
