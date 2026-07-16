
- [2026-07-07T14:33:39Z] Check the source before writing CLI tests to verify whether output uses console.log or process.stdout.write, then spy on whichever it actually uses.

- [2026-07-07T18:54:47Z] Always export classes using a named export. Never use a default export for a class, and never declare a class without exporting it.

- [2026-07-14T10:23:13Z] Always: In strict TypeScript, always annotate callback parameters with explicit types (e.g., `.map((c: Column) =>` not `.map(c =>`). Never rely on implicit any inference for array method callbacks.

- [2026-07-15T02:48:02Z] Never access ECMAScript private fields (#fieldName) from outside the class in test code — TypeScript cannot parse it and will emit TS1005/TS1109. Test private state indirectly through public methods o

- [2026-07-15T03:53:06Z] NEVER modify files inside node_modules/ — if a dependency is missing or has wrong types, add it to package.json devDependencies/dependencies and run npm install. If a type mismatch exists, use declara

- [2026-07-15T04:03:31Z] Never modify any file inside node_modules/ — only edit source files under src/ or config files like package.json/tsconfig.json. If a dependency is missing, add it to package.json devDependencies and r
