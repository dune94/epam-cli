/**
 * RETEST OF f600939 AND b65ebd7 — two lane/render fixes shipped with no test.
 *
 *   f600939 — AGENT_PROFILES_FILE is READ in three places in run-agent-orchestration.sh and was
 *             ASSIGNED in none. Empty, profiles_backup became the bare string '.original', the
 *             canonical roster looked missing, and the recreation ran `cp "" .original`. The
 *             operator saw a message about a missing canonical roster; the cause was an unset
 *             variable. Invisible until a lane ran.
 *
 *   b65ebd7 — codelineScopeBlock() returns '' in three deliberate branches (no lanes, a story in
 *             one codeline, no other lane), and spec-coordinator-review never declared
 *             __CODELINE_SCOPE__ as mayBeEmpty. The renderer refuses an empty UNDECLARED
 *             placeholder, so it killed the spec pass AFTER the work was done — mock3 had already
 *             persisted 6 verification criteria for one story and 3 for the other, then lost the
 *             pass to a note it had no reason to write. One story per codeline is the ordinary
 *             case, not an edge one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');

describe('a declared variable has one answer', () => {
  it('AGENT_PROFILES_FILE is assigned, not only read', () => {
    // f600939. Three readers and no writer is not a default, it is an empty string that every
    // reader then builds a path out of.
    const src = readFileSync(ORCH, 'utf8');
    const reads = (src.match(/\$\{?AGENT_PROFILES_FILE/g) || []).length;
    const assigns = (src.match(/^\s*(export\s+)?AGENT_PROFILES_FILE=/gm) || []).length;
    expect(reads, 'nothing reads it — this test is guarding nothing').toBeGreaterThan(0);
    expect(assigns, `AGENT_PROFILES_FILE is read ${reads} time(s) and assigned ${assigns} time(s)`)
      .toBeGreaterThan(0);
  });

  it('and it is EXPORTED, so a lane subprocess gets the same answer', () => {
    // The defect was specifically invisible until a lane ran: an unexported value is empty in the
    // child, which is where the three readers actually live.
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'assigned but not exported: a lane still reads empty')
      .toMatch(/^\s*export\s+AGENT_PROFILES_FILE\b/m);
  });

  it('the value it defaults to actually exists', () => {
    // A variable that resolves to a path nobody shipped fails exactly like an empty one.
    const m = /AGENT_PROFILES_FILE="\$\{AGENT_PROFILES_FILE:-([^"]+)\}"/.exec(readFileSync(ORCH, 'utf8'));
    expect(m, 'the default is not in the expected shape').toBeTruthy();
    const resolved = (m as RegExpExecArray)[1].replace('$EPAM_AGENTS_DIR', join(SCRIPTS, '../agents'));
    expect(existsSync(resolved), `AGENT_PROFILES_FILE defaults to ${resolved}, which does not exist`)
      .toBe(true);
  });

  it('__CODELINE_SCOPE__ is declared mayBeEmpty by the template that renders it', () => {
    // b65ebd7. The renderer refuses an empty UNDECLARED placeholder, and this one is empty in the
    // ORDINARY case — one story, one codeline. Undeclared, it kills the pass after the work.
    // orchestrations/prompts/templates — found by looking, after I guessed agents/prompts and the
    // test failed for the wrong reason. A path I assume is a path that can pass while proving
    // nothing about the file that actually renders.
    const templates = join(SCRIPTS, '../prompts/templates');
    const candidates = ['spec-coordinator-review.json']
      .map((f) => join(templates, f)).filter((f) => existsSync(f));
    expect(candidates.length, 'the spec-coordinator-review template was not found where expected')
      .toBeGreaterThan(0);
    const raw = readFileSync(candidates[0], 'utf8');
    expect(raw, 'the template does not use the placeholder at all').toContain('__CODELINE_SCOPE__');

    // MEMBERSHIP, NOT PROXIMITY. My first version matched `mayBeEmpty` within 400 characters of the
    // placeholder, and a template carries several of both — so removing __CODELINE_SCOPE__ from the
    // list left the test green. A neighbouring word is not a declaration.
    const tpl = JSON.parse(raw);
    const declared = Object.entries(tpl)
      .filter(([k, v]) => /mayBeEmpty/i.test(k) && Array.isArray(v))
      .flatMap(([, v]) => v as string[]);
    expect(declared.length, 'the template declares no mayBeEmpty list at all').toBeGreaterThan(0);
    expect(declared, '__CODELINE_SCOPE__ is not declared mayBeEmpty, so the ordinary case — one '
      + 'story in one codeline — kills the spec pass after it has done its work')
      .toContain('__CODELINE_SCOPE__');
  });
});
