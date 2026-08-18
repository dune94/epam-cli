import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: __dirname,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});
