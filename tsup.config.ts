import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry (executable)
  {
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
  },
  // Library SDK surface — importable by external projects
  {
    entry: { sdk: 'src/sdk.ts' },
    format: ['cjs'],
    target: 'node20',
    external: ['keytar'],
    clean: false,
    sourcemap: true,
    dts: true,
    minify: false,
    splitting: false,
    treeshake: true,
    outDir: 'dist',
  },
]);
