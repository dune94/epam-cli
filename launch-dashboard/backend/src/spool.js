/**
 * spool.js — the ONLY channel between the container and the host.
 *
 * The backend runs in a container; the pipeline runs on the host. A container cannot exec a host
 * process. Rather than hand the container a docker socket (root-equivalent) or an ssh key (a
 * credential to manage), the backend WRITES A REQUEST and a host-side runner picks it up.
 *
 * The trust boundary is ONE DIRECTORY. The container gets no host privileges, and the runner — not
 * the API — owns the lock, so "reject while busy" is enforced where the truth is.
 *
 * Everything here is about what lands ON DISK, because that file is the entire contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REQUESTS = 'requests';
const STATUS = 'status';

/**
 * An id reaches this from an HTTP request, so it decides a filename. A traversing id must never
 * write outside the mount — that is the whole value of the boundary being one directory.
 */
function safeId(id) {
  const s = String(id ?? '');
  if (!s || s.includes('/') || s.includes('\\') || s.includes('\0') || s === '.' || s === '..'
      || s.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`unsafe id for a spool filename: ${JSON.stringify(s)}`);
  }
  return s;
}

/** Create the directories rather than assuming the mount arrives populated. */
function init(dir) {
  fs.mkdirSync(path.join(dir, REQUESTS), { recursive: true });
  fs.mkdirSync(path.join(dir, STATUS), { recursive: true });
  return dir;
}

/**
 * ATOMIC by tmp+rename. The runner POLLS: without this it can observe a truncated file and either
 * crash or, worse, launch with a partial ticket id. The temp name is unique so two writers cannot
 * collide, and it carries no `.json` suffix so a polling runner never sees it as a request.
 */
function writeAtomic(target, data) {
  const tmp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

/**
 * Everything the runner needs to launch, and nothing it must infer.
 *
 * The pause flags and resumeRunId are carried explicitly: a resume launched WITHOUT
 * EPAM_RESUME_RUN starts a FRESH run, and on a brownfield defect a fresh run resets the codeline
 * and discards committed work. That happened live on 2026-09-02.
 */
function writeRequest(dir, { id, ticket, requestedBy, pauseAfterMint = false,
                             pauseBeforeWriter = false, resumeRunId = null, codeLevel = null,
                             providerSet = null }) {
  const safe = safeId(id);
  if (!ticket || !String(ticket).trim()) throw new Error('a request needs a ticket');
  // NO VENDOR DEFAULT, EVER — matching runs-store.js/config.js. The runner has nothing else to go
  // on but this file, so a missing providerSet here would force it to guess.
  if (!providerSet || !String(providerSet).trim()) {
    throw new Error('a request needs a provider set — refusing to guess a vendor');
  }
  const body = {
    id: safe,
    ticket: String(ticket).trim(),
    requestedBy: String(requestedBy ?? '').trim(),
    pauseAfterMint: !!pauseAfterMint,
    pauseBeforeWriter: !!pauseBeforeWriter,
    resumeRunId,
    codeLevel,
    providerSet: String(providerSet).trim(),
    requestedAt: new Date().toISOString(),
  };
  writeAtomic(path.join(dir, REQUESTS, `${safe}.json`), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

/** A stop is a file too, so the runner owns the killing — the API never touches a process. */
function writeStop(dir, id) {
  const safe = safeId(id);
  writeAtomic(path.join(dir, REQUESTS, `${safe}.stop`), `${new Date().toISOString()}\n`);
  return true;
}

/**
 * null means "no status yet" — never a guess.
 *
 * A malformed file must degrade to null rather than throwing: the runner writes these, and if it
 * dies mid-write the API must not 500, and must NOT report a run as finished because it could not
 * read the file. Absent and unreadable are the same answer: I do not know.
 */
function readStatus(dir, id) {
  let safe;
  try { safe = safeId(id); } catch { return null; }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATUS, `${safe}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export { init, writeRequest, writeStop, readStatus, safeId };
