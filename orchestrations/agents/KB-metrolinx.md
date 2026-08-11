# KB — metrolinx

Persistent, cross-run knowledge for this codeline. Appended by the pipeline as agents
learn, and injected into their prompts on later runs. Never reset between runs: this is
the one store that is meant to survive.

- [2026-08-10T03:07:08Z] Always: Before modifying package.json, add `*.json` to .eslintignore (or add "ignorePatterns": ["*.json"] to .eslintrc.json). This repo's ESLint config sets @typescript-eslint/parser as the default pa

- [2026-08-10T03:51:30Z] Always: Whenever a story modifies package.json, lint-staged runs ESLint on it and @typescript-eslint/no-unused-expressions fails at 1:1 because the config lints JSON as TS. Fix: add "package.json" to 
