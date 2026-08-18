/**
 * A CONSUMER RECEIVES WHAT IT DECLARED. NOTHING MORE, NOTHING ELSE'S SHAPE.
 *
 * The archetype says what an agent consumes:
 *
 *     "story-writer": { consumes: [ { kind: "fix-plan", required: true, framing: "fix-plan" }, … ] }
 *
 * and this module renders exactly that, in that order, from what producers published. It replaces
 * the thirty conditionals in the writer's prompt builder, each of which was a consumer holding an
 * opinion about a producer's data.
 *
 * THREE RULES, AND WHY EACH EXISTS
 *
 * ABSENT IS ABSENT. A kind nobody published contributes nothing — no heading, no empty section.
 * That is what removes the conditionals: there is no `if` because there is nothing to decide.
 *
 * THE FRAMING BELONGS TO THE READER, AND IT IS A DOCUMENT. "This is the plan of record, apply it"
 * and "this is what the implementer was working from, judge the diff against it" are the same
 * facts under different authority, so the producer cannot supply it. But it is prompt text, so it
 * does not live here either: it lives in the consumer's project-authority prompt document, and
 * this module names the body to render. No prompt prose in code, and no fallback to a template.
 *
 * A REQUIRED INPUT THAT NEVER ARRIVED IS A HARD FAILURE. This is the safety of the whole
 * migration. A prompt built without the root-cause analysis looks exactly like one built with it,
 * and costs a writer 143k tokens re-deriving what an agent had already worked out. The pipeline
 * already refuses to build a writer prompt without its test-ownership policy; this is that rule,
 * applied to every declared input.
 */
'use strict';

const path = require('path');
const agentIo = require('./agent-io.js');
const { resolveSeam } = require('./seam-invocation.js');
const promptLibrary = require('./prompt-library.js');

function defaultRegistryPath() {
  return path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json');
}

/**
 * What this agent declares it consumes, in declared order.
 * Resolved through the SEAM: a minted instance inherits its archetype's declaration, which is the
 * point of the archetype — nobody wires up a newly minted agent by hand.
 */
/**
 * Which kinds are actually TRAVELLING through the store today.
 *
 * A producer gains publishesVia="agent-io" when it is migrated. Required-input enforcement applies
 * only to those kinds: a kind still rendered the old way has nothing in the store, and refusing
 * every prompt over that would stop the pipeline rather than migrate it. When every producer
 * carries the marker, this function returns everything and can be deleted.
 */
function migratedKinds(registry) {
  const kinds = new Set();
  for (const profile of Object.values((registry && registry.profiles) || {})) {
    if (profile && profile.publishesVia === 'agent-io' && profile.produces) {
      kinds.add(String(profile.produces));
    }
  }
  return kinds;
}

function declaredInputs(agent, registryPath) {
  const file = registryPath || defaultRegistryPath();
  const seam = resolveSeam(agent, file);
  // eslint-disable-next-line global-require
  const registry = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const profile = (registry.profiles || {})[seam] || {};
  return Array.isArray(profile.consumes) ? profile.consumes : [];
}

/**
 * Render every declared input this story has, framed as the consumer's own prompt document says.
 *
 * @param {string} agent      the minted agent name, e.g. 'contentstack-live-preview-engineer'
 * @param {string} storyId    the story whose inputs to collect
 * @param {object} opts       { registryPath, projectConfigDir, env }
 * @returns {string} prompt text, or '' when nothing was published
 */
function renderDeclaredInputs(agent, storyId, opts) {
  const o = opts || {};
  const declared = declaredInputs(agent, o.registryPath);
  const projectConfigDir = o.projectConfigDir || process.env.EPAM_PROJECT_CONFIG_DIR;

  // eslint-disable-next-line global-require
  const registry = JSON.parse(require('fs').readFileSync(o.registryPath || defaultRegistryPath(), 'utf8'));
  const onFramework = migratedKinds(registry);

  const missing = [];
  const parts = [];

  for (const entry of declared) {
    if (!entry || !entry.kind) continue;
    const kind = String(entry.kind);

    if (!agentIo.present(storyId, kind, o.env)) {
      if (entry.required && onFramework.has(kind)) missing.push(kind);
      continue; // absent is absent
    }

    if (entry.framing) {
      // NO FALLBACK. A declared framing that will not render is a defect in the prompt library,
      // and rendering the input bare would quietly drop "apply this, do not re-derive it".
      let framing;
      try {
        framing = promptLibrary.buildPrompt(
          promptIdFor(agent, o), projectConfigDir, {}, { part: String(entry.framing) },
        );
      } catch (e) {
        throw new Error(`'${agent}' declares framing '${entry.framing}' for input '${kind}', `
          + `which did not render: ${(e && e.message) || e}`);
      }
      if (!String(framing || '').trim()) {
        throw new Error(`'${agent}' declares framing '${entry.framing}' for input '${kind}', `
          + 'which rendered empty — the input would arrive with no authority attached');
      }
      // The consumer's framing already titles the section, so provenance attributes rather than
      // titles again: "## Root Cause Analysis …" followed by "## fix-plan (from: …)" reads as two
      // sections announcing the same thing under different names.
      const entryRead = agentIo.read(storyId, kind, o.env);
      parts.push(`${String(framing).trim()}\n\n_(${kind}, from: ${entryRead.from})_\n\n`
        + `${entryRead.body.replace(/\n+$/, '')}`);
    } else {
      // No framing declared: the framework's own heading carries the kind and its source.
      parts.push(agentIo.collect(storyId, [kind], o.env).replace(/\n+$/, ''));
    }
  }

  if (missing.length) {
    throw new Error(`'${agent}' requires input(s) nothing published for story ${storyId}: `
      + `${missing.join(', ')}. A prompt built without them looks exactly like one built with `
      + 'them, so it is refused here rather than discovered three hours into a run.');
  }

  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/** Which prompt document holds this consumer's framings: its archetype's template, by name. */
function promptIdFor(agent, opts) {
  const file = (opts && opts.registryPath) || defaultRegistryPath();
  const seam = resolveSeam(agent, file);
  // eslint-disable-next-line global-require
  const registry = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const profile = (registry.profiles || {})[seam] || {};
  return profile.template || seam;
}

module.exports = { declaredInputs, renderDeclaredInputs, promptIdFor };

if (require.main === module) {
  const [, , agent, storyId] = process.argv;
  try {
    process.stdout.write(renderDeclaredInputs(agent, storyId, {}));
  } catch (e) {
    process.stderr.write(`[agent-inputs] ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}
