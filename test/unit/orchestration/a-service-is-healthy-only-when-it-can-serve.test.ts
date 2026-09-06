/**
 * A DEPENDENCY IS "HEALTHY" ONLY WHEN IT CAN ACTUALLY SERVE THE DEPENDANT.
 *
 * langfuse-server declares `depends_on: postgres: condition: service_healthy`, which is the right
 * shape — and postgres declared its health as `pg_isready -U epam`. pg_isready answers a question
 * about the SERVER, not about the DATABASE: it succeeds as soon as a postmaster accepts
 * connections, which during first-boot initialisation happens BEFORE initdb has created
 * POSTGRES_DB. So the gate opened early, langfuse ran its Prisma migration against a database that
 * did not exist yet, and exited:
 *
 *     Error: P1001: Can't reach database server at `postgres:5432`
 *     Applying database migrations failed ... Exiting...
 *     FATAL:  database "epam" does not exist        (postgres' own log, same moment)
 *
 * Live twice: pipeline-tests-28 and again on a completely clean pipeline-tests-29, so it is the
 * installer's behaviour and not a damaged volume. The first time it was "fixed" by hand —
 * CREATE DATABASE and a docker restart — which produced a false green and taught the next install
 * nothing. The installer must produce a working stack unaided.
 *
 * THE HEALTHCHECK MUST NAME THE DATABASE. `pg_isready -U <user> -d <db>` fails while the database
 * is absent, so service_healthy means what its dependants assume it means.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPOSE = join(__dirname, '../../../docker-compose.observability.yml');
const src = readFileSync(COMPOSE, 'utf8');

/** The block of one top-level service, by name. */
function service(name: string): string {
  const at = src.indexOf(`\n  ${name}:`);
  expect(at, `service ${name} not found in the compose file`).toBeGreaterThan(-1);
  const rest = src.slice(at + 1);
  const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the observability stack starts in an order that works', () => {
  it('GUARD: langfuse waits on postgres being healthy — otherwise nothing below matters', () => {
    const lf = service('langfuse-server');
    expect(lf).toMatch(/depends_on:/);
    expect(lf, 'langfuse does not wait for a healthy postgres at all').toMatch(/condition:\s*service_healthy/);
  });

  it('POSTGRES IS HEALTHY ONLY WHEN THE DATABASE EXISTS, not when the server answers', () => {
    /**
     * `pg_isready -U epam` passes against the temporary postmaster that runs during initdb, so
     * the dependant is released before POSTGRES_DB has been created. Naming the database is what
     * makes the check mean what depends_on assumes.
     */
    const pg = service('postgres');
    const health = /healthcheck:[\s\S]*?test:\s*(\[[^\]]*\]|.*)/.exec(pg);
    expect(health, 'postgres declares no healthcheck, so service_healthy is meaningless')
      .toBeTruthy();
    const test = health![1];
    expect(test, `the healthcheck does not name a database, so it passes during initdb while `
      + `POSTGRES_DB does not yet exist: ${test}`).toMatch(/-d\s|--dbname/);
  });

  it('the database it checks is the one it is configured to create', () => {
    // A check naming a DIFFERENT database would be green while the real one is missing.
    const pg = service('postgres');
    const db = /POSTGRES_DB:\s*([A-Za-z0-9_${}:-]+)/.exec(pg);
    expect(db, 'postgres declares no POSTGRES_DB').toBeTruthy();
    const name = db![1].replace(/\$\{([A-Za-z0-9_]+)(:-([^}]*))?\}/, '$3') || db![1];
    const health = /healthcheck:[\s\S]*?test:\s*(\[[^\]]*\]|.*)/.exec(pg)![1];
    expect(health, `the healthcheck must probe ${name}, the database this service creates`)
      .toContain(name);
  });
});
