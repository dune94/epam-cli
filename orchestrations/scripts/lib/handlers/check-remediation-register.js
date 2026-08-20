#!/usr/bin/env node
/**
 * check-remediation-register.js — enforce the OPERATOR's decisions, which live in DATA.
 *
 * orchestrations/config/remediation-register.json is the operator's list: literals that must be
 * gone, and guards judged useless. Nothing here decides what belongs on those lists — this only
 * reports which `enforce:true` entries STILL MATCH, so the decision and the enforcement never
 * require a code change to each other.
 *
 *   node check-remediation-register.js [repoRoot] [registerPath]
 *     → one "ID  file  reason" per live violation
 *
 * Exit 0 when clean, 1 when any enforced entry still matches, 2 when the register itself cannot
 * be read. An unreadable register is NOT "no violations": absence must never arrive as success.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTER = 'orchestrations/config/remediation-register.json';

function load(root, registerPath) {
  const p = path.isAbsolute(registerPath) ? registerPath : path.join(root, registerPath);
  const raw = fs.readFileSync(p, 'utf8');           // throws → caller exits 2
  const j = JSON.parse(raw);
  return {
    bannedLiterals: Array.isArray(j.bannedLiterals) ? j.bannedLiterals : [],
    uselessGuards: Array.isArray(j.uselessGuards) ? j.uselessGuards : [],
  };
}

/** A banned literal is live when its pattern still occurs in the file it names. */
function literalViolations(root, entries) {
  const out = [];
  for (const e of entries) {
    if (!e || e.enforce !== true) continue;
    if (!e.file || !e.pattern) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, e.file), 'utf8'); }
    catch {
      // The file named by an enforced decision is gone. Report it: a decision pointing at
      // nothing is stale, and silently passing would retire it without anyone deciding to.
      out.push({ id: e.id, file: e.file, reason: 'file not found — register entry is stale' });
      continue;
    }
    let re;
    try { re = new RegExp(e.pattern); }
    catch { out.push({ id: e.id, file: e.file, reason: 'pattern is not a valid regex' }); continue; }
    if (re.test(src)) out.push({ id: e.id, file: e.file, reason: e.reason || 'banned literal still present' });
  }
  return out;
}

/** A useless guard is live when its symbol is still present in the file it names. */
function guardViolations(root, entries) {
  const out = [];
  for (const e of entries) {
    if (!e || e.enforce !== true) continue;
    if (!e.file || !e.symbol) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, e.file), 'utf8'); }
    catch {
      out.push({ id: e.id, file: e.file, reason: 'file not found — register entry is stale' });
      continue;
    }
    if (src.includes(e.symbol)) out.push({ id: e.id, file: e.file, reason: e.reason || 'guard judged useless is still present' });
  }
  return out;
}

function check(root, registerPath = DEFAULT_REGISTER) {
  const reg = load(root, registerPath);
  return [
    ...literalViolations(root, reg.bannedLiterals),
    ...guardViolations(root, reg.uselessGuards),
  ];
}

module.exports = { check, load, literalViolations, guardViolations, DEFAULT_REGISTER };

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  const reg = process.argv[3] || DEFAULT_REGISTER;
  let violations;
  try { violations = check(root, reg); }
  catch (e) {
    process.stderr.write(`[register] cannot read ${reg}: ${e.message}\n`);
    process.exit(2);
  }
  for (const v of violations) console.log(`${v.id}\t${v.file}\t${v.reason}`);
  process.exit(violations.length ? 1 : 0);
}
