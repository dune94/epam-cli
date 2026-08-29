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

module.exports = { recordAgentReply, replyLogDir };
