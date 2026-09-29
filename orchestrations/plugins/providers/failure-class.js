'use strict';
/**
 * A FAILED CALL'S CLASS, FROM ITS STRUCTURED CAUSE — one reader for every runner plugin.
 *
 *   failureClass(pluginDir, { status, systemCode, fields })
 *
 * fields: the vendor's own structured fields ({error_code: ...}, {errorType, errorCode}); read through
 * <pluginDir>/failures.json. status: the HTTP status; systemCode: Node's error `code`; both read
 * through config/failure-classes.json. First match wins in that order (a vendor code is the most
 * specific thing a call says about itself); nothing matched is the declared default. The failure's
 * words are not an input (review of 2026-09-29).
 */
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'config', 'failure-classes.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

function failureClass(pluginDir, { status, systemCode, fields } = {}) {
  const shared = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));  // the declaration is the install's; unreadable is a broken install, said loudly
  const vendor = readJson(path.join(pluginDir, 'failures.json')).fields || {};
  for (const [field, map] of Object.entries(vendor)) {
    const v = fields && fields[field];
    if (v != null && Object.prototype.hasOwnProperty.call(map, String(v))) return map[String(v)];
  }
  const byStatus = shared.byStatus || {};
  const s = Number(status) || 0;
  if (s) {
    if (byStatus[String(s)]) return byStatus[String(s)];
    const hundred = `${Math.floor(s / 100)}xx`;
    if (byStatus[hundred]) return byStatus[hundred];
  }
  if (systemCode && (shared.bySystemCode || {})[systemCode]) return shared.bySystemCode[systemCode];
  return shared.default;
}

module.exports = { failureClass };
