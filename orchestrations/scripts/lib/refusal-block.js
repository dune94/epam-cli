/**
 * THE BLOCK AN AGENT IS SHOWN WHEN ITS PREVIOUS ATTEMPT WAS REFUSED.
 *
 * Three call sites wrote this in JavaScript, each with its own wording — the roster stage, the
 * prompt generator, and the roster namer. Model-facing prose in engine code cannot be reviewed in
 * the prompt layer, is invisible to the drift checks that hold every project copy to its template,
 * and cannot be changed per project. One prompt, one file: prompts/templates/previous-refusal.json.
 *
 * NO REFUSAL, NO BLOCK. A first attempt must not carry a heading for a refusal that never
 * happened — an agent told it was refused, with nothing after it, invents a reason.
 *
 * @param {string} reason    what the previous attempt got wrong, in the checker's own words
 * @param {string} artefact  what it is being asked to produce again ('roster', 'prompt', ...)
 * @returns {string} the rendered block, or '' when there is nothing to correct
 */
function refusalBlock(reason, artefact) {
  const why = String(reason || '').trim();
  if (!why) return '';
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('./engine-prompt.js');
  return renderEngineTemplate('previous-refusal', {
    __REASON__: why,
    __ARTEFACT__: String(artefact || '').trim() || 'artefact',
  });
}

module.exports = { refusalBlock };
