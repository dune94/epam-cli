/**
 * LINTING THE PIPELINE — which nothing did until 2026-08-08.
 *
 * The repo's eslint config ends with ignorePatterns: ["dist/", "node_modules/", "*.js"], and
 * its lint script is `eslint src --ext .ts`. Every .js file was excluded — which is the whole
 * orchestration tree, where all the pipeline logic lives and where every defect this week has
 * been found.
 *
 * On 2026-08-08 a variable was deleted during a refactor and a reference to it twelve lines
 * below survived. `no-undef` catches that in under a second; instead it reached a live run,
 * crashed EVERY detective invocation for three attempts across three lanes, and produced no
 * fix sites at all — while a suite of 8821 tests stayed green, because the helper was unit
 * tested in isolation and nothing executed the function containing the dangling reference.
 *
 * Deliberately narrow: correctness rules that catch code which cannot possibly work. Not style.
 * A lint pass that argues about formatting gets switched off, and then catches nothing.
 */
export default [
  {
    files: ['orchestrations/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', __dirname: 'readonly',
        __filename: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        AbortController: 'readonly', fetch: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-cond-assign': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
