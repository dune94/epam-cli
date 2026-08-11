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

/**
 * Turns a typed (or legacy) tool call into the argv for codegraph-agent-query.sh.
 *
 * Pure and exported so the contract is testable without spawning anything. Returns
 * {ok:true, argv} or {ok:false, error} — and the error NAMES THE FIELD, because "args is
 * required for mode query" sent the agent back to a paragraph while "query requires 'symbol'"
 * tells it exactly what to send.
 */
const MODE_FIELDS = {
  explore:  { field: 'terms',  split: true },
  helpers:  { field: 'terms',  split: true },
  query:    { field: 'symbol', split: false },
  callers:  { field: 'symbol', split: false },
  callees:  { field: 'symbol', split: false },
  impact:   { field: 'symbol', split: false },
  show:     { field: 'file',   split: false },
};

function buildArgv(input) {
  const mode = input && input.mode;
  if (!mode || !MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of ${MODES.join(', ')}.` };
  }
  const spec = MODE_FIELDS[mode];
  const typed = input[spec.field];
  const legacy = typeof input.args === 'string' ? input.args.trim() : '';

  // A typed field always wins: a stale `args` alongside a real `symbol` is the shape a
  // half-migrated caller sends, and honouring the vaguer one would be the wrong choice.
  if (typed === undefined || typed === null || String(typed).trim() === '') {
    if (!legacy) {
      return { ok: false, error: `mode "${mode}" requires '${spec.field}'.` };
    }
    return { ok: true, argv: [mode, ...legacy.split(/\s+/).filter(Boolean)] };
  }

  const value = String(typed).trim();
  const argv = spec.split ? [mode, ...value.split(/\s+/).filter(Boolean)] : [mode, value];

  if (mode === 'show') {
    for (const key of ['startLine', 'endLine']) {
      const raw = input[key];
      if (raw === undefined || raw === null || raw === '') continue;
      // Refused rather than shell-quoted: a non-numeric line bound reaching argv is a bug and
      // an injection surface at the same time.
      if (!Number.isInteger(Number(raw)) || String(raw).trim() !== String(Number(raw))) {
        return { ok: false, error: `'${key}' must be an integer line number, got '${raw}'.` };
      }
      argv.push(String(Number(raw)));
    }
    const s = Number(input.startLine), e = Number(input.endLine);
    if (Number.isInteger(s) && Number.isInteger(e) && e < s) {
      return { ok: false, error: `'endLine' (${e}) is before 'startLine' (${s}).` };
    }
  }
  return { ok: true, argv };
}

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
        // TYPED PER MODE, rather than one `args` string meaning five different things.
        //
        // `mode` was enum-constrained and machine-checked; `args` was checked by nobody, so a
        // wrong shape reached the query script and came back as prose the model had to read,
        // interpret and retry — a paid round trip for something a schema can make impossible.
        // Only `mode` is universally required because what else is needed DEPENDS on it;
        // buildArgv() enforces that and names the missing field.
        symbol: {
          type: 'string',
          description: 'For query/callers/callees/impact: the exact symbol name, e.g. "applyReportDiscountsService".',
        },
        terms: {
          type: 'string',
          description: 'For explore/helpers: domain nouns, e.g. "discount refund". Not symptom or UI words.',
        },
        file: {
          type: 'string',
          description: 'For show: the file to read, e.g. "src/services/discount.ts".',
        },
        startLine: {
          type: 'integer',
          description: 'For show: first line to read (1-based). Optional.',
        },
        endLine: {
          type: 'integer',
          description: 'For show: last line to read. Optional; must not precede startLine.',
        },
        args: {
          type: 'string',
          description:
            'LEGACY, deprecated — prefer the typed fields above. Free-form arguments in the old ' +
            'form: domain nouns for explore/helpers, a symbol for query/callers/callees/impact, ' +
            'or "<file> [startLine] [endLine]" for show. Kept so an agent built against the older ' +
            'contract keeps working; a typed field always wins over it.',
        },
      },
      required: ['mode'],
    },
  },
  async execute(input) {
    try {
      const mode = input && input.mode;
      const built = buildArgv(input || {});
      if (!built.ok) {
        return { toolUseId: '', content: `Error: ${built.error}`, isError: true };
      }
      const args = built.argv.slice(1).join(' ');
      if (!existsSync(QUERY_SCRIPT)) {
        return {
          toolUseId: '',
          content: 'CodeGraph query script not found — tool unavailable in this environment.',
          isError: true,
        };
      }

      const projectRoot = process.cwd();
      const argv = built.argv.slice(1);
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
  buildArgv,
};
