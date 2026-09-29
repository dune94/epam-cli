'use strict';
/**
 * COPILOT'S MODELS, READ FROM COPILOT — the catalog GitHub Copilot serves the account, never a list typed here.
 *
 * The copilot runner climbs the same ladders the claude set declares (operator, 2026-09-27: "Models same
 * as claude map to those if available"). A claude-set id is normalised the way Copilot names the same model
 * — a trailing -YYYYMMDD date dropped, a `major-minor` version written `major.minor` — and must be one the
 * catalog serves; nothing is guessed. The catalog also says which reasoning-effort levels each model takes:
 * the GitHub Copilot CLI answers an unsupported `--reasoning-effort` with an error and exit code 0 (spike,
 * 2026-09-27), so an effort reaches the command line only when the model lists it, at the nearest listed
 * level not above the one asked for.
 *
 * The catalog is a JSON file (EPAM_COPILOT_CATALOG), written by `fetch` from
 * https://api.githubcopilot.com/models with the account's GitHub token.
 *
 * CLI:
 *   node copilot-models.js map <model>              → the Copilot id, or exit 1 naming the model
 *   node copilot-models.js effort <copilotId> <lvl> → the level to pass, or nothing
 *   node copilot-models.js fetch <out.json>         → writes the catalog (needs COPILOT_GITHUB_TOKEN)
 */
const fs = require('fs');
const path = require('path');

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CATALOG_URL = 'https://api.githubcopilot.com/models';

function loadCatalog(file = process.env.EPAM_COPILOT_CATALOG) {
  if (!file) throw new Error('no Copilot catalog declared (EPAM_COPILOT_CATALOG) — run `copilot-models.js fetch <file>` first');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`the Copilot catalog at ${file} cannot be read: ${e.message}`);
  }
  const data = Array.isArray(parsed) ? parsed : parsed.data;
  if (!Array.isArray(data) || !data.length) throw new Error(`the Copilot catalog at ${file} lists no models`);
  // Chat models the account can pick; embeddings and disabled models are not ladder candidates.
  return data.filter((m) => m && m.id && m.model_picker_enabled !== false && (!m.policy || m.policy.state !== 'disabled'));
}

/** The Copilot spelling of a model id: date suffix dropped, `x-y` version written `x.y`. */
function normalise(id) {
  return String(id || '').trim()
    .replace(/[-@]\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

function mapModel(id, catalog) {
  const ids = new Set(catalog.map((m) => m.id));
  if (ids.has(id)) return id;
  const n = normalise(id);
  return ids.has(n) ? n : null;
}

function effortFor(copilotId, requested, catalog) {
  if (!requested) return '';
  const m = catalog.find((x) => x.id === copilotId);
  const listed = (m && m.capabilities && m.capabilities.supports && m.capabilities.supports.reasoning_effort) || [];
  if (!Array.isArray(listed) || !listed.length) return '';
  if (listed.includes(requested)) return requested;
  const rank = (l) => EFFORT_ORDER.indexOf(l);
  const want = rank(requested);
  const ordered = listed.filter((l) => rank(l) >= 0).sort((a, b) => rank(a) - rank(b));
  if (!ordered.length) return '';
  const notAbove = ordered.filter((l) => rank(l) <= want);
  return notAbove.length ? notAbove[notAbove.length - 1] : ordered[0];
}

async function fetchCatalog(out) {
  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('no GitHub token for the Copilot catalog (COPILOT_GITHUB_TOKEN)');
  const res = await fetch(CATALOG_URL, { headers: {
    Authorization: `Bearer ${token}`, 'Copilot-Integration-Id': 'copilot-developer-cli', Accept: 'application/json',
  } });
  if (!res.ok) throw new Error(`the Copilot catalog answered HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.data) || !body.data.length) throw new Error('the Copilot catalog answered with no models');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 1) + '\n');
  fs.renameSync(tmp, out);
  return body.data.length;
}

module.exports = { loadCatalog, normalise, mapModel, effortFor, fetchCatalog, EFFORT_ORDER };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  (async () => {
    if (cmd === 'fetch') {
      const n = await fetchCatalog(a);
      console.log(`copilot catalog: ${n} model(s) written to ${a}`);
      return;
    }
    const catalog = loadCatalog();
    if (cmd === 'map') {
      const id = mapModel(a, catalog);
      if (!id) { console.error(`copilot-models: '${a}' is not in the Copilot catalog (as '${normalise(a)}') — the account is not served that model`); process.exit(1); }
      console.log(id);
    } else if (cmd === 'effort') {
      const e = effortFor(a, b, catalog);
      if (e) console.log(e);
    } else {
      console.error('usage: copilot-models.js map <model> | effort <copilotId> <level> | fetch <out.json>');
      process.exit(2);
    }
  })().catch((e) => { console.error(`copilot-models: ${e.message}`); process.exit(1); });
}
