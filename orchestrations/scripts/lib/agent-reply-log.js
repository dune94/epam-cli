/**
 * EVERY AGENT REPLY IS KEPT, BY DEFAULT, WITHOUT ANYONE REMEMBERING TO ASK.
 *
 * On 2026-08-29 metrolinx AMSD-1919 halted because the mint's reply "had no proposedAgents array"
 * when the excerpt plainly showed one. The shape could not be established, because every capture
 * path was empty at once:
 *
 *   - the run log excerpts at 2000 characters; the reply was 3885
 *   - the rejection persister no-oped, because its caller passed no logDir
 *   - Langfuse holds no agent-mint trace at all
 *   - and for the agents it DOES trace, every observation reads in=4ch out=4ch — the string
 *     "null". Token counts and cost are recorded; prompts and completions are not.
 *
 * So the pipeline kept no record of what any agent said, and the only way to see a content-shaped
 * failure was to pay for another run. Diagnosis by live run is not a diagnostic strategy.
 *
 * This is deliberately the dumbest thing that cannot fail: raw text, one file per reply, written
 * before anything tries to interpret it. It is ON by default — an operator can point it somewhere
 * else, but not have to switch it on — and it never throws, because logging must never be the
 * reason a run dies.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Where replies are kept: the run's output dir when there is one, else a stable temp home. */
function replyLogDir() {
  const explicit = process.env.EPAM_AGENT_REPLY_LOG_DIR;
  if (explicit) return explicit;
  // NOT OUTPUT_DIR, AND NOT /tmp. Teardown does `rm -rf OUTPUT_DIR` and recreates it, so evidence
  // filed there is deleted by the next run — the very run someone would compare it against. And a
  // WSL restart has already wiped work parked in /tmp twice. This sits beside the pipeline, in the
  // repository, where neither reaches it.
  const repo = path.resolve(__dirname, '..', '..');           // orchestrations/
  if (repo) return path.join(repo, 'agent-replies');
  return path.join(os.tmpdir(), 'epam-agent-replies');
}

/**
 * Keep one agent reply verbatim. Returns the file written, or '' when there was nothing to keep.
 * NEVER throws: a failure to log is not a failure of the run.
 *
 * @param {string} tag   the seam's output tag, e.g. PROJECT_AGENTS — names the file
 * @param {string} text  the reply exactly as the model produced it, untruncated
 */
function recordAgentReply(tag, text) {
  if (typeof text !== 'string' || text === '') return '';
  try {
    const dir = replyLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const slug = String(tag || 'untagged').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untagged';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // A counter keeps two replies in the same millisecond from colliding — retries are fast.
    let file = path.join(dir, `${slug}-${stamp}.txt`);
    let n = 1;
    while (fs.existsSync(file)) { file = path.join(dir, `${slug}-${stamp}-${n}.txt`); n += 1; }
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return '';
  }
}


/**
 * The environment variable naming the prompt of the call in flight. The cost seam is a different
 * function — on the shell edge, a different PROCESS — so the path travels in the environment,
 * which is the one channel both edges already share.
 */
const PROMPT_FILE_ENV = 'EPAM_CURRENT_PROMPT_FILE';

/**
 * KEEP THE PROMPT WHERE THE COST SEAM CAN REACH IT.
 *
 * Traces recorded in=4ch for every agent, and passing the prompt per-caller could not fix it: of
 * the emitters, only spec-mode-runner and cpa-inference hold a prompt at all — codeline-discovery,
 * ac-gate and the shell edge never see one. Wiring the single site that had it moved nothing.
 *
 * The invoker always has the prompt, because it is about to send it. So it writes the prompt down
 * and names the file in the environment; the cost seam reads it there, on both edges, and no
 * caller has to remember anything. Same contract as recordAgentReply: never throws.
 *
 * @returns {string} the file written, or '' when there was nothing to keep
 */
function recordAgentPrompt(tag, text) {
  const file = recordAgentReply(`${tag || 'untagged'}-prompt`, text);
  if (!file) return '';
  // THE ENVIRONMENT DOES NOT CROSS A PROCESS BOUNDARY, AND THE EMITTER IS A DIFFERENT PROCESS.
  //
  // Naming the file in the environment was the first design and it failed silently: the prompts
  // were written correctly, and every trace still read in=4ch, because the shell edge emits from a
  // sibling process that never saw the variable. A pointer FILE, keyed by the seam's own tag,
  // crosses that boundary — and keying it by tag rather than using one shared pointer keeps two
  // lanes running in parallel from claiming each other's prompt.
  process.env[PROMPT_FILE_ENV] = file;
  try {
    const slug = String(tag || 'untagged').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    fs.writeFileSync(path.join(replyLogDir(), `.prompt-${slug}`), file);
  } catch { /* a pointer that cannot be written costs a trace field, never the run */ }
  return file;
}

/** The prompt most recently recorded for a seam's tag, or '' when there is none. Never throws. */
function promptFileForTag(tag) {
  try {
    const slug = String(tag || 'untagged').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return fs.readFileSync(path.join(replyLogDir(), `.prompt-${slug}`), 'utf8').trim();
  } catch {
    return '';
  }
}

module.exports = {
  recordAgentReply, recordAgentPrompt, promptFileForTag, replyLogDir, PROMPT_FILE_ENV,
};
