'use strict';
/**
 * CONFIGURATION THAT CROSSES A BOUNDARY THE RUNTIME DOES NOT CROSS.
 *
 * A build-time-substituted value read where substitution never happens is `undefined`. It
 * type-checks, it lints clean, it passes review, and at runtime the branch it guards silently
 * does nothing. There is no stack trace, because nothing failed.
 *
 * Live 2026-08-14, AMSD-2041 on next.metrolinx.com:
 *
 *     if (process.env.CONTENTSTACK_LIVE_PREVIEW_ENABLED !== "true") return;   // _app.tsx
 *
 * called from useEffect, i.e. the browser. Next.js inlines only NEXT_PUBLIC_-prefixed variables
 * into the client bundle; the guard returned early on every page load and the live-preview SDK
 * was never initialised. The same commit read the same variable inside getStaticProps and was
 * CORRECT there -- so the writer knew the right pattern and used it one file away.
 *
 * WHY THIS IS A PLUGIN AND NOT AN ENGINE CHECK
 *
 * The engine may not know that Next.js has a NEXT_PUBLIC_ prefix, any more than it may know that
 * a project installs with pnpm. Framework facts live here, behind ADAPTERS. Adding a stack is
 * adding an adapter; it is never an engine change, and the engine never learns a framework's
 * name -- the same rule dependency-scan-plugin.js follows for install commands.
 *
 * WHY IT IS NOT PINNED TO A CODELINE
 *
 * It is handed the codeline being changed and reads THAT codeline's own package.json and config.
 * It carries no codeline identity, so gotransit, upexpress and metrolinx are the same call.
 *
 * ABSENT IS ABSENT
 *
 * A codeline whose stack no adapter recognises reports exposureDeclared:false and NO findings.
 * It must never report a clean bill of health, because a check that silently finds nothing looks
 * exactly like a repository with nothing wrong -- the failure mode that made a $7.47 run report
 * $0.00 and be believed.
 */
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const PLUGIN_API_VERSION = 1;

/**
 * ADAPTERS. One per stack, each answering the same three questions:
 *
 *   detect            does this codeline use the stack, judged from its own package.json
 *   clientPrefixes    the prefixes whose values ARE substituted into client code
 *   alwaysExposed     names the framework substitutes regardless of prefix
 *   serverOnly        contexts whose bodies are never bundled to the client
 *   serverOnlyPaths   path fragments that are server-only in their entirety
 *   exposureConfig    the config file that may expose additional names
 *
 * Nothing here names a project or a codeline.
 */
const ADAPTERS = [
  {
    id: 'nextjs',
    detect: (deps) => Boolean(deps.next),
    clientPrefixes: ['NEXT_PUBLIC_'],
    alwaysExposed: ['NODE_ENV'],
    serverOnly: ['getStaticProps', 'getServerSideProps', 'getStaticPaths', 'getInitialProps'],
    // Paths whose contents never reach a browser bundle. Server routes, middleware, and TESTS.
    //
    // Tests belong here and it is not a technicality: a spec sets process.env to CONFIGURE the
    // unit under test, which is the correct way to write it, and it runs in the test runner where
    // every variable is present. Live 2026-08-14 the first wiring of this check flagged nine such
    // reads in one gotransit spec file and would have failed a run whose code was correct.
    serverOnlyPaths: ['/pages/api/', '/app/api/', '/middleware.', '.server.',
      '.test.', '.spec.', '/__tests__/', '/__mocks__/', '.mock.'],
    exposureConfig: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
  },
  {
    id: 'vite',
    detect: (deps) => Boolean(deps.vite),
    clientPrefixes: ['VITE_'],
    alwaysExposed: ['NODE_ENV', 'MODE', 'BASE_URL'],
    serverOnly: [],
    serverOnlyPaths: ['.server.', '/server/', '.test.', '.spec.', '/__tests__/', '/__mocks__/', '.mock.'],
    exposureConfig: ['vite.config.js', 'vite.config.ts'],
  },
  {
    id: 'create-react-app',
    detect: (deps) => Boolean(deps['react-scripts']),
    clientPrefixes: ['REACT_APP_'],
    alwaysExposed: ['NODE_ENV', 'PUBLIC_URL'],
    serverOnly: [],
    serverOnlyPaths: ['.test.', '.spec.', '/__tests__/', '/__mocks__/', '.mock.'],
    exposureConfig: [],
  },
];

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** resolveAdapter — which stack this codeline is, from its own manifest. Null when unknown. */
function resolveAdapter(projectRoot) {
  const pkg = readJson(join(projectRoot, 'package.json'));
  if (!pkg) return null;
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  return ADAPTERS.find((a) => a.detect(deps)) || null;
}

/**
 * additionalExposed — names the project's own config exposes beyond the prefix rule.
 *
 * Best effort by design: a config file may be minified or programmatic, and guessing its
 * semantics is worse than reading only what is plainly there. Anything missed produces a
 * finding the writer can rebut, never a silent pass.
 */
function additionalExposed(projectRoot, adapter) {
  const names = new Set();
  for (const f of adapter.exposureConfig) {
    const p = join(projectRoot, f);
    if (!existsSync(p)) continue;
    let text = '';
    try {
      text = readFileSync(p, 'utf8');
    } catch (_) {
      continue;
    }
    // `env: { FOO: ..., BAR: ... }` — the documented way to expose non-prefixed names.
    const block = text.match(/\benv\s*:\s*\{([^}]*)\}/);
    if (block) {
      for (const m of block[1].matchAll(/([A-Z][A-Z0-9_]*)\s*:/g)) names.add(m[1]);
    }
  }
  return names;
}

/**
 * serverOnlySpans — byte ranges of the file whose contents never reach the client.
 *
 * Brace-matched from each server-only declaration. A read inside one of these is CORRECT and
 * must not be flagged: over-inclusion here would push the writer to break working code, which is
 * worse than the defect being caught.
 */
function serverOnlySpans(src, adapter) {
  const spans = [];
  for (const name of adapter.serverOnly) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    for (const m of src.matchAll(re)) {
      const open = src.indexOf('{', m.index);
      if (open === -1) continue;
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            spans.push([m.index, i]);
            break;
          }
        }
      }
    }
  }
  return spans;
}

const inSpan = (spans, i) => spans.some(([a, b]) => i >= a && i <= b);

/**
 * scanClientEnvBoundary — the one question this plugin answers.
 *
 * Returns { findings, filesScanned, exposureDeclared, adapter }. exposureDeclared:false means
 * NO RULE WAS KNOWN, which is not the same as nothing being wrong.
 */
function scanClientEnvBoundary(projectRoot, changedFiles) {
  const adapter = resolveAdapter(projectRoot);
  if (!adapter) {
    return { findings: [], filesScanned: 0, exposureDeclared: false, adapter: null };
  }

  const exposed = additionalExposed(projectRoot, adapter);
  const files = (changedFiles || []).filter((f) => /\.(t|j)sx?$/.test(f));
  const findings = [];
  let filesScanned = 0;

  for (const rel of files) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    const norm = `/${rel.replace(/\\/g, '/')}`;
    if (adapter.serverOnlyPaths.some((frag) => norm.includes(frag))) continue;

    let src = '';
    try {
      src = readFileSync(abs, 'utf8');
    } catch (_) {
      continue;
    }
    filesScanned++;

    const spans = serverOnlySpans(src, adapter);
    for (const m of src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1];
      if (adapter.clientPrefixes.some((p) => name.startsWith(p))) continue;
      if (adapter.alwaysExposed.includes(name)) continue;
      if (exposed.has(name)) continue;
      if (inSpan(spans, m.index)) continue;

      findings.push({
        verdict: 'CLIENT_ENV_NOT_EXPOSED',
        variable: name,
        file: rel,
        line: src.slice(0, m.index).split('\n').length,
        detail:
          `${name} is read in client-executed code but ${adapter.id} substitutes only ` +
          `${adapter.clientPrefixes.join(', ')} names into the client bundle, and this ` +
          `codeline's config exposes no others. At runtime the value is undefined, so the ` +
          `branch it guards silently does nothing. Either read it in a server-only context ` +
          `and pass the result through props, as this codeline already does elsewhere, or ` +
          `expose it deliberately.`,
      });
    }
  }

  return { findings, filesScanned, exposureDeclared: true, adapter: adapter.id };
}

module.exports = {
  pluginApiVersion: PLUGIN_API_VERSION,
  scanClientEnvBoundary,
  resolveAdapter,
  additionalExposed,
  serverOnlySpans,
  ADAPTERS,
};
