/**
 * THE SPOOL — the only channel between a container and the host.
 *
 * The backend runs in a container; the pipeline runs on the host. A container cannot exec a host
 * process, so the backend writes a REQUEST and a host-side runner picks it up. The trust boundary
 * is one directory: the container never receives host privileges, no docker socket, no ssh key.
 *
 * Everything asserted here is about what lands ON DISK, because that file is the entire contract
 * between the two sides. A test that checked the function returned something would prove nothing
 * about what the runner will find.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as spool from '../src/spool.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-')); });

describe('the spool', () => {
  test('creates its directories rather than assuming a mount is pre-populated', () => {
    spool.init(dir);
    assert.ok(fs.existsSync(path.join(dir, 'requests')), 'requests/ missing');
    assert.ok(fs.existsSync(path.join(dir, 'status')), 'status/ missing');
  });

  test('a request lands as a complete, parseable file the runner can act on', () => {
    spool.init(dir);
    spool.writeRequest(dir, { id: 'r1', ticket: 'AMSD-1919', requestedBy: 'alice', providerSet: 'claude' });
    const p = path.join(dir, 'requests', 'r1.json');
    assert.ok(fs.existsSync(p), 'no request file written');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(j.id, 'r1');
    assert.equal(j.ticket, 'AMSD-1919');
    assert.equal(j.requestedBy, 'alice');
    assert.equal(j.providerSet, 'claude', 'the runner needs to know which set to launch');
    assert.ok(j.requestedAt, 'the runner needs to know how old a request is');
  });

  test('refuses a request with no providerSet — the runner must never guess a vendor', () => {
    spool.init(dir);
    assert.throws(
      () => spool.writeRequest(dir, { id: 'r1', ticket: 'AMSD-1919', requestedBy: 'alice' }),
      /provider/i,
    );
    assert.ok(!fs.existsSync(path.join(dir, 'requests', 'r1.json')),
      'a rejected request must not be written');
  });

  test('writes ATOMICALLY — a runner must never read a half-written request', () => {
    // The runner POLLS. Without tmp+rename it can observe a truncated file and either crash or,
    // worse, launch with a partial ticket id.
    //
    // "no stray files remain" does NOT prove this — a direct writeFileSync leaves none either, so
    // that assertion passes whether or not the write is atomic (verified: mutating rename away left
    // it green). The observable that DOES distinguish them is the inode: rename REPLACES the file,
    // so the inode changes; a direct write truncates in place and keeps it.
    spool.init(dir);
    const target = path.join(dir, 'requests', 'r1.json');

    spool.writeRequest(dir, { id: 'r1', ticket: 'AMSD-1919', requestedBy: 'alice', providerSet: 'claude' });
    const firstInode = fs.statSync(target).ino;

    spool.writeRequest(dir, { id: 'r1', ticket: 'AMSD-1920', requestedBy: 'alice', providerSet: 'claude' });
    const secondInode = fs.statSync(target).ino;

    assert.notEqual(secondInode, firstInode,
      'the request was written in place, so a polling runner can observe it half-written');

    const stray = fs.readdirSync(path.join(dir, 'requests')).filter((f) => !f.endsWith('.json'));
    assert.deepEqual(stray, [], `partial files left in the spool: ${stray.join(', ')}`);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).ticket, 'AMSD-1920');
  });

  test('refuses an id that would escape the spool directory', () => {
    // The id reaches this from an HTTP request. A path-traversing id must never write outside the
    // mount — that is the whole value of the boundary being one directory.
    spool.init(dir);
    for (const bad of ['../escape', 'a/b', '..', '']) {
      assert.throws(() => spool.writeRequest(dir, { id: bad, ticket: 'T-1', requestedBy: 'x' }),
        /id/i, `accepted a dangerous id: ${JSON.stringify(bad)}`);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'escape.json')));
  });

  test('reads back a status the runner wrote', () => {
    spool.init(dir);
    fs.writeFileSync(path.join(dir, 'status', 'r1.json'),
      JSON.stringify({ id: 'r1', status: 'running', stage: 'external verification', runId: '2026X' }));
    const s = spool.readStatus(dir, 'r1');
    assert.equal(s.status, 'running');
    assert.equal(s.stage, 'external verification');
  });

  test('returns null for an unknown status rather than inventing one', () => {
    spool.init(dir);
    assert.equal(spool.readStatus(dir, 'nope'), null);
  });

  test('a malformed status file is null, never a crash and never a guess', () => {
    // The runner writes these. If it dies mid-write, the API must degrade to "no status yet"
    // rather than 500 — and must NOT report a run as finished because it could not read it.
    spool.init(dir);
    fs.writeFileSync(path.join(dir, 'status', 'r1.json'), '{ this is not json');
    assert.equal(spool.readStatus(dir, 'r1'), null);
  });

  test('a stop request is a file too, so the runner owns the killing', () => {
    spool.init(dir);
    spool.writeStop(dir, 'r1');
    assert.ok(fs.existsSync(path.join(dir, 'requests', 'r1.stop')), 'no stop marker written');
  });
});
