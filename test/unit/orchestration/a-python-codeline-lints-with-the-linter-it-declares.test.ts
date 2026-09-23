/**
 * A CODELINE IS LINTED WITH THE LINTER IT DECLARES.
 *
 * Live, regintel 2026-09-23: seven warnings in a single story run, one per attempt —
 *
 *   [repo-lint] REGI-009a: no pre-commit hook in <codeline> — lint was NOT run;
 *               nothing here proves the change is clean
 *
 * The repo-lint path runs only where a pre-commit hook ENFORCES lint, and the declared-lint path
 * beside it runs whatever the codeline declares in .epam/verification.json. The requirements.txt
 * ecosystem declared a typecheck and a test command and NO lint command at all, so a python
 * codeline could never be linted however it was set up — package.json codelines have had this
 * since the ecosystems were written.
 *
 * Derived, never guessed: the linter is whichever one the project lists in its own
 * requirements.txt, exactly as the test command is `pytest` only because pytest is listed. A
 * project that lists none declares no linter, and the honest answer is '' — "cannot prove",
 * never a guess at a tool the project never asked for.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const eco = require(join(ROOT, 'orchestrations/ecosystems/requirements-txt.js'));

const lint = (requirements: string) => (eco.verification && typeof eco.verification.lint === 'function'
  ? eco.verification.lint(requirements) : null);

describe('a python codeline lints with the linter it declares', () => {
  it('declares a lint command when the project lists ruff', () => {
    const got = lint('fastapi\nruff\npytest\n');
    expect(got, 'a project that lists ruff still gets no lint command').toBeTruthy();
    expect(got.command).toContain('ruff');
    expect(got.detected, 'the declaration does not say where it came from').toMatch(/requirements/i);
  });

  it('uses flake8 when that is what the project lists', () => {
    expect(lint('flake8\npytest\n').command).toContain('flake8');
  });

  it('uses pylint when that is what the project lists', () => {
    expect(lint('pylint\n').command).toContain('pylint');
  });

  it('says nothing — never guesses a tool — when the project lists no linter', () => {
    // regintel's own requirements.txt: fastapi, uvicorn, openai, python-dotenv, pytest, httpx
    expect(lint('fastapi\nuvicorn[standard]\nopenai\npython-dotenv\npytest\nhttpx\n')).toBeFalsy();
  });

  it('names a stable failure identity, so a lint baseline can be subtracted', () => {
    const got = lint('ruff\n');
    expect(got.failurePattern, 'without a pattern every pre-existing lint finding lands on the next story').toBeTruthy();
    expect(got.failureIdentity).toBeTruthy();
  });
});
