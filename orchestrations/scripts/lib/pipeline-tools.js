'use strict';
/**
 * HOW AN AGENT IS TOLD ITS PIPELINE TOOLS — by name, never by a local path.
 *
 * Operator, 2026-10-01: "hard coded local paths are not generated into prompts or SI text. This is
 * not permitted. Relative paths only." The detective, the guard-vocabulary check and the repro test
 * writer were told `bash "<install>/orchestrations/scripts/codegraph-agent-query.sh" …`.
 *
 * How the tools reach an agent is a fact about the active set, read from its declaration:
 *  - a runner that declares hostedToolPlugins attaches the pipeline's tools to the agent, which is
 *    told to call them (prompts/templates/pipeline-tools-hosted.json);
 *  - on every other set the agent runs the scripts through its shell, named by the variables in
 *    config/pipeline-tool-commands.json (prompts/templates/pipeline-tools-command.json). The hub
 *    exports them (commandEnv), so the shell resolves each one and the prompt carries no path.
 *
 * CLI: `--block` prints the block for the active set; `--env` prints KEY=path lines for the hub.
 */
const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const COMMANDS_FILE = path.join(__dirname, '..', '..', 'config', 'pipeline-tool-commands.json');

/** True when the active set's runner hosts the pipeline's tools. */
function hostsPipelineTools() {
  // eslint-disable-next-line global-require
  const { activeSetFile, readSetFile } = require('./llm-settings-resolve.js');
  const file = activeSetFile();
  const runners = (file && (readSetFile(file) || {}).runners) || {};
  return Object.values(runners).some((r) => r && Array.isArray(r.hostedToolPlugins) && r.hostedToolPlugins.length > 0);
}

/** Variable -> absolute script, for the hub's environment (never for a prompt). */
function commandEnv() {
  const { commands } = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8'));
  const out = {};
  for (const [k, script] of Object.entries(commands || {})) out[k] = path.join(SCRIPTS, script);
  return out;
}

/** The tools block for the active set. */
function pipelineToolsBlock() {
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('./engine-prompt.js');
  return renderEngineTemplate(hostsPipelineTools() ? 'pipeline-tools-hosted' : 'pipeline-tools-command', {});
}

module.exports = { hostsPipelineTools, commandEnv, pipelineToolsBlock };

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--env') {
    for (const [k, v] of Object.entries(commandEnv())) process.stdout.write(`${k}=${v}\n`);
  } else if (arg === '--block') {
    process.stdout.write(pipelineToolsBlock());
  } else {
    process.stderr.write('usage: pipeline-tools.js --block | --env\n');
    process.exitCode = 2;
  }
}
