#!/usr/bin/env node
/**
 * declared-packages.js <codeline-root> — what the codeline's manifest DECLARES, as JSON on stdout.
 *
 * One answer for every agent that may prescribe or use a package: the same checkPackageAvailability the gate and the
 * agents' dependency_available tool use (dependency-contract-plugin.js), reduced to the declaration. A package on disk
 * and not declared is not available — the manifest decides.
 *
 *   { "manifestFile": "<declared by the codeline>", "manifestRead": true|false, "declared": ["<name>", ...] }
 */
'use strict';
const path = require('path');
const { checkPackageAvailability } = require(path.join(__dirname, '..', '..', '..', 'plugins', 'dependency-contract-plugin.js'));
const r = checkPackageAvailability(process.argv[2] || process.cwd(), []);
process.stdout.write(JSON.stringify({ manifestFile: r.manifestFile, manifestRead: r.manifestRead, declared: r.declared }, null, 2));
