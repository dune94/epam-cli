#!/usr/bin/env node
/**
 * THE STACK FACTS A PROMPT NEEDS, FOR INJECTION AT RENDER TIME.
 *
 * Nine templates carried these as literals in their prompt BODIES — "files without *.test.ts,
 * agentRole \"typescript-engineer\"", "NEVER modify package.json, tsconfig.json, vitest.config.ts",
 * "run vitest". Every agent on every project was therefore told the world is TypeScript, vitest and
 * npm. On a Rust, Python, Go or Ruby codeline the split rules and the protected-file list are
 * simply wrong, and the agent follows them anyway.
 *
 * A prompt may not carry a project fact. It CAN carry a placeholder that is filled from
 * configuration — which is what this emits.
 *
 * Everything comes from somewhere that already owns it:
 *   - the ecosystem (test command, manifest, protected files) from lib/ecosystem-registry.js
 *   - the test-file convention from the same broad regex story-outputs.sh uses
 *   - the ROLES from the project's own minted roster, never from a name written here
 *
 *   argv[2]  the codeline / repository
 *   argv[3]  optional: the project's roles file (project-roles.json), for the role names
 *
 *   stdout   one JSON object of __PLACEHOLDER__ -> value, ready to merge into a values file.
 *
 * A fact this cannot determine is emitted as an explicit, readable phrase rather than a guess: an
 * agent told "this codeline declares no test command" behaves correctly, one told "vitest" does not.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { allManifests } = require('../ecosystem-registry.js');

const repo = process.argv[2];
if (!repo) {
  process.stderr.write('[stack-facts] usage: <repo> [roles-file]\n');
  process.exit(1);
}
const rolesFile = process.argv[3] || '';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const eco = allManifests().find((e) => fs.existsSync(path.join(repo, e.file))) || null;
const manifestText = eco ? read(path.join(repo, eco.file)) : null;

const call = (fn, ...args) => {
  if (typeof fn !== 'function') return '';
  try { return fn(...args) || ''; } catch { return ''; }
};

let packageManager = '';
if (eco) {
  for (const [lock, mgr] of Object.entries(eco.lockfiles || {})) {
    if (fs.existsSync(path.join(repo, lock))) { packageManager = mgr; break; }
  }
}

const testCommand = eco && manifestText !== null ? call(eco.testCommand, manifestText, packageManager) : '';

/**
 * THE TEST-FILE CONVENTION, stated for a reader rather than as one extension.
 *
 * lib/story-outputs.sh and lib/handlers/_testfile.py already recognise this set; naming a single
 * pattern here would reintroduce the defect one layer down.
 */
const TEST_CONVENTIONS = '*.test.*, *.spec.*, *_test.*, *_spec.*, test_*.*, or anything under __tests__/';

/**
 * THE ROLES COME FROM THE PROJECT'S OWN ROSTER.
 *
 * Prompts named "typescript-engineer" — one of epam-cli's own roles — so a client project was told
 * to assign work to an agent it never minted. Picked by what a role SAYS it does, never by matching
 * a name written here: a project may call its writer anything.
 */
function rolesFromRoster() {
  const out = { impl: '', test: '' };
  const raw = rolesFile ? read(rolesFile) : null;
  if (raw === null) return out;

  let doc;
  try { doc = JSON.parse(raw); } catch { return out; }

  // The file wraps the list under `roles` and carries `_what`/`_why` documentation keys alongside
  // it. Reading Object.entries of the whole document picked up "roles" itself as a role name.
  // THREE SHAPES, because this file is handed whichever one the caller has. The roster is the
  // authority now — { agents: { name: { kind } } } — and an implementer is a KIND, not membership
  // of a separate registry. The older { roles: [...] } and bare-array forms are still read while
  // anything still writes them.
  const list = Array.isArray(doc) ? doc
    : (doc && doc.agents && typeof doc.agents === 'object')
      ? Object.entries(doc.agents)
        .filter(([, e]) => e && (e.kind === 'implementer' || e.kind === 'investigator'))
        .map(([name, e]) => ({ id: name, kind: e.kind }))
      : (Array.isArray(doc.roles) ? doc.roles : []);

  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : String(entry && (entry.id || entry.role || entry.name) || '');
    if (!id) continue;
    const blurb = `${id} ${typeof entry === 'string' ? '' : JSON.stringify(entry)}`.toLowerCase();
    if (!out.test && /\btest|\bqa\b|spec/.test(blurb)) { out.test = id; continue; }
    if (!out.impl && /engineer|developer|implement|writer/.test(blurb)) out.impl = id;
  }
  return out;
}

const roles = rolesFromRoster();

const facts = {
  __STACK__: eco ? eco.stack : 'unknown',
  __MANIFEST_FILE__: eco ? eco.file : '(this codeline declares no manifest)',
  __TEST_COMMAND__: testCommand || '(this codeline declares no test command)',
  __TEST_FILE_CONVENTIONS__: TEST_CONVENTIONS,
  __PROTECTED_FILES__: (eco && eco.protectedFiles || []).join(', ')
    || '(this codeline declares no build or scaffold configuration)',
  __IMPL_ROLE__: roles.impl || 'the role this project minted for implementation work',
  __TEST_ROLE__: roles.test || 'the role this project minted for test authoring',
};

process.stdout.write(`${JSON.stringify(facts)}\n`);
