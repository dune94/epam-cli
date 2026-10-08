#!/usr/bin/env node
// THE ANALYST'S PROJECT PROMPT, AS A RUN'S START BUILDS IT — from the CURRENT template, through the pipeline's own
// builder (lib/project-prompt-builder.js buildProjectPrompts, keepExisting as a resume calls it), its generator at the
// prompt-builder seam on the live set (lib/seam-invocation.js + spec-mode-runner.js runClaude), exactly as
// mint-agents-step.js wires it. Only the LIST is narrowed to the analyst's seam: the copied project's other prompts were
// built from that install's templates and are not what this harness tests.
//
//   rebuild-analyst-prompt.js <project_config_dir> <log_dir> <codeline_name> <codeline_path>
const fs = require('fs');
const path = require('path');

const [projectConfigDir, logDir, clName, clPath] = process.argv.slice(2);
const ENGINE = path.resolve(__dirname, '../../../..');
const SCRIPTS = path.join(ENGINE, 'orchestrations/scripts');
const AGENTS = path.join(ENGINE, 'orchestrations/agents');
const { buildProjectPrompts } = require(path.join(SCRIPTS, 'lib/project-prompt-builder.js'));
const { seamInvocationEnv } = require(path.join(SCRIPTS, 'lib/seam-invocation.js'));
const spec = require(path.join(SCRIPTS, 'spec-mode-runner.js'));

(async () => {
  const registry = JSON.parse(fs.readFileSync(path.join(AGENTS, 'invocation-profiles.json'), 'utf8'));
  const profiles = Object.fromEntries(Object.entries(registry.profiles || {}).filter(([, p]) => p && p.template === 'failure-analyst'));
  if (!Object.keys(profiles).length) throw new Error('no seam in the registry runs the failure-analyst template');
  const narrowRegistry = path.join(logDir, 'registry.failure-analyst.json');
  fs.writeFileSync(narrowRegistry, JSON.stringify({ ...registry, profiles }));
  const narrowBootstrap = path.join(logDir, 'bootstrap.none.json');
  fs.writeFileSync(narrowBootstrap, JSON.stringify({ copyVerbatim: [], generated: [] }));

  const promptExec = spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(SCRIPTS, 'ai-run.sh'));
  const built = await buildProjectPrompts({
    keepExisting: true,
    templatesDir: path.join(ENGINE, 'orchestrations/prompts/templates'),
    bootstrapFile: narrowBootstrap,
    registryFile: narrowRegistry,
    projectConfigDir,
    mode: process.env.EPAM_PROMPT_PROVISION_MODE,
    attempts: Number(process.env.EPAM_PROMPT_ATTEMPTS || 5),
    projectContext: `Project: ${path.basename(projectConfigDir)}\nTickets in scope: S-1: The greeting says hello there`,
    codelineContext: `- ${clName} (${clPath})`,
    mintedRoles: '(none minted this run)',
    log: (m) => process.stderr.write(`${m}\n`),
    runText: (prompt, meta) => {
      const rung = Math.max(0, (Number((meta && meta.attempt) || 1) || 1) - 1);
      const seamEnv = seamInvocationEnv('prompt-builder', AGENTS, { rung });
      if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
      seamEnv.EPAM_AGENT_NAME = 'prompt-builder';
      return spec.runClaude(promptExec, prompt, path.join(logDir, `prompt-build-${(meta && meta.id) || 'unknown'}.log`), seamEnv, { costAgent: 'prompt-builder' });
    },
  });
  process.stdout.write(`${JSON.stringify({ generated: built.generated, copied: built.copied })}\n`);
})().catch((e) => { process.stderr.write(`${e && e.stack || e}\n`); process.exit(1); });
