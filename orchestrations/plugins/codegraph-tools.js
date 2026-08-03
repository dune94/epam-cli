'use strict';
/**
 * CodeGraph Tools — a ToolPlugin (epam-cli plugin architecture,
 * src/tools/plugin.ts + PluginLoader.ts) exposing CodeGraph's real,
 * symbol-index-backed codebase queries as a FIRST-CLASS tool.
 *
 * Built 2026-08-02 after a real assessment found CodeGraph queries were only
 * ever reachable through a shell script (orchestrations/scripts/codegraph-
 * agent-query.sh) the model had to invoke via the generic Bash tool — real,
 * measured cost: every call required the model to reconstruct a full
 * `PROJECT_ROOT="$PROJECT_ROOT" bash "$SCRIPT_DIR/codegraph-agent-query.sh"
 * <subcommand> <args>` command line as OUTPUT tokens (repeated on every one
 * of the 5-10 iterative calls a real investigation makes), on top of Bash's
 * own approval/classification overhead for what is, in truth, a read-only
 * code-introspection query. A first-class tool with a small enum+string
 * schema replaces that whole reconstructed command line with a single
 * compact structured call, and needs no PROJECT_ROOT argument at all — the
 * tool infers it from the real working directory, the same way every other
 * plugin tool in this file does.
 *
 * PROJECT-AGNOSTIC: this wraps the CodeGraph CLI itself, not any project's
 * data — safe to provision for every project, not just one.
 *
 * Registered the same way every other plugin here is: an ABSOLUTE path
 * entry in a codeline's .epam/settings.json "tools" array (PluginLoader
 * resolves a leading "/" entry via path.resolve, short-circuiting to the
 * absolute path unchanged) — this module lives in epam-cli's own repo and
 * is never committed into any client codeline.
 */

const path = require('path');
const { existsSync } = require('fs');
const { execFileSync } = require('child_process');

const PLUGIN_API_VERSION = '1.0.0';

const QUERY_SCRIPT = path.join(__dirname, '..', 'scripts', 'codegraph-agent-query.sh');

const MODES = ['explore', 'query', 'callers', 'callees', 'impact', 'helpers', 'show'];

const codegraphQueryTool = {
  name: 'codegraph_query',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Query this codebase\'s real, static symbol index (CodeGraph) instead of grepping. Modes: ' +
    '"explore <domain nouns>" (START HERE for an unfamiliar bug/feature — ranked symbols + blast radius + callers/callees; ' +
    'use domain nouns like "discount refund", never symptom/UI words like "displayed wrong"); ' +
    '"helpers <term>" (ALWAYS run before writing a new function — finds existing exported util/parser/formatter/mapper ' +
    'functions to reuse, with exact symbol + import path); ' +
    '"query <symbol>" (exact definition site of a known symbol name); ' +
    '"callers <symbol>" (who calls this — trace a symptom back to its cause); ' +
    '"callees <symbol>" (what this calls — trace forward); ' +
    '"impact <symbol>" (blast radius if you change this symbol); ' +
    '"show <file> [startLine] [endLine]" (read REAL verbatim source lines — required before quoting any line as evidence, ' +
    'capped at 300 lines per call if no end line given). ' +
    'Call this iteratively (5-10 times is normal), refining your query based on each result, until you converge on the real fix site.',
  permission: 'safe',
  definition: {
    name: 'codegraph_query',
    description: 'Query the real CodeGraph symbol index for this codebase (explore/query/callers/callees/impact/helpers/show).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: MODES,
          description: 'Which CodeGraph query to run.',
        },
        args: {
          type: 'string',
          description:
            'Arguments for the chosen mode: domain nouns for explore/helpers (e.g. "discount refund"), ' +
            'a symbol name for query/callers/callees/impact (e.g. "applyReportDiscountsService"), ' +
            'or "<file> [startLine] [endLine]" for show (e.g. "src/services/discount.ts 40 90").',
        },
      },
      required: ['mode', 'args'],
    },
  },
  async execute(input) {
    try {
      const mode = input && input.mode;
      const args = input && typeof input.args === 'string' ? input.args : '';
      if (!mode || !MODES.includes(mode)) {
        return {
          toolUseId: '',
          content: `Error: mode must be one of ${MODES.join(', ')}.`,
          isError: true,
        };
      }
      if (!args.trim()) {
        return { toolUseId: '', content: `Error: args is required for mode "${mode}".`, isError: true };
      }
      if (!existsSync(QUERY_SCRIPT)) {
        return {
          toolUseId: '',
          content: 'CodeGraph query script not found — tool unavailable in this environment.',
          isError: true,
        };
      }

      const projectRoot = process.cwd();
      const argv = args.split(/\s+/).filter(Boolean);
      let output;
      try {
        output = execFileSync('bash', [QUERY_SCRIPT, mode, ...argv], {
          cwd: projectRoot,
          env: { ...process.env, PROJECT_ROOT: projectRoot },
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
        });
      } catch (execErr) {
        // codegraph-agent-query.sh distinguishes "genuinely broken index/missing
        // binary" (non-zero exit) from "no results" (exit 0, possibly empty
        // stdout) — surface the real stderr/stdout either way rather than
        // collapsing it into a generic failure the agent can't act on.
        const combined = [execErr.stdout, execErr.stderr].filter(Boolean).join('\n').trim();
        return {
          toolUseId: '',
          content: combined || `codegraph-agent-query.sh exited with an error (mode=${mode}).`,
          isError: true,
        };
      }

      const trimmed = (output || '').trim();
      return {
        toolUseId: '',
        content: trimmed || `(no results for ${mode} "${args}")`,
        isError: false,
      };
    } catch (err) {
      return { toolUseId: '', content: `Error running CodeGraph query: ${err.message}`, isError: true };
    }
  },
};

module.exports = {
  tools: [codegraphQueryTool],
};
