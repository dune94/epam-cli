import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { epam: 'src/index.ts' },
  format: ['cjs'],
  target: 'node20',
  external: ['keytar'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  sourcemap: true,
  dts: false,
  minify: false,
  splitting: false,
  treeshake: true,
  outDir: 'dist',
});
