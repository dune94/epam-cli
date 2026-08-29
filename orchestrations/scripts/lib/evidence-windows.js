/**
 * HOW MUCH EVIDENCE AN AGENT IS SHOWN, BY NAME — the JavaScript half.
 *
 * The same declaration the shell reader uses (config/evidence-windows.json), so a window widened
 * for a shell caller is widened for a JS one. Two files declaring the same number is how a limit
 * comes to half-apply: the pipeline already had a lint window written twice, and raising one of
 * them changed nothing anybody could see.
 *
 * THROWS ON AN UNKNOWN NAME. A window that silently falls back to some default is the literal
 * again with a layer of indirection over it, and the caller would truncate on a number nobody
 * chose — which is the defect this file exists to remove, not to relocate.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  const file = process.env.EPAM_EVIDENCE_WINDOWS_FILE
    || path.join(__dirname, '..', '..', 'config', 'evidence-windows.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  _cache = { file, windows: (doc && doc.windows) || {} };
  return _cache;
}

/** The declared window, or a throw naming what is missing and where to declare it. */
function evidenceWindow(name) {
  const { file, windows } = _load();
  const w = windows[name];
  if (!w || !Number.isFinite(w.value)) {
    throw new Error(
      `[evidence-window] '${name}' is not declared in ${file} — declare it with a $why, `
      + 'rather than truncating on a number nobody chose.');
  }
  return w.value;
}

module.exports = { evidenceWindow };
