/**
 * STATIC CHECKING FOR THE PIPELINE ITSELF.
 *
 * package.json lints "src --ext .ts" and nothing else, so every JavaScript file under
 * orchestrations/ — the whole orchestration engine — had no static checking at all.
 *
 * On 2026-08-17 a function was deleted and one of its call sites survived, because the edit script
 * that was meant to remove the call aborted on an unrelated error before writing. tsc does not see
 * these files and the test suite never exercised that path, so the ReferenceError surfaced as a
 * dead run: "FAILED: validateSurveyFilesRead is not defined", after discovery, the survey and the
 * mint had all completed. `no-undef` finds it in about a second.
 *
 * Deliberately narrow: this is not a style pass over 40k lines of working code. It catches the
 * class that costs a run — a name used that does not exist.
 */
export default [
  // Vendored third-party JS: a python venv's site-packages, node_modules. Not ours to lint.
  { ignores: ['**/.venv*/**', '**/node_modules/**', '**/site-packages/**', '**/dist/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly',
        structuredClone: 'readonly', queueMicrotask: 'readonly', performance: 'readonly',      },
    },
    linterOptions: {
      // Existing files carry eslint-disable comments for rules from plugins this narrow config
      // does not load (import/*, global-require). Those are not defects — reporting them would
      // bury the one thing this config exists to find.
      reportUnusedDisableDirectives: false,
    },
    // Declared as no-ops so an eslint-disable comment naming a rule from a plugin this narrow
    // config does not load is not itself an error. The comment is legitimate under the repo's
    // full config; this pass simply does not know that rule.
    plugins: { import: { rules: { 'no-dynamic-require': { create: () => ({}) } } } },
    rules: { 'no-undef': 'error' },
  },
];
