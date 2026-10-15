/**
 * THE OBSERVABILITY STACK CARRIES NO CLICKHOUSE — LANGFUSE V2 NEVER NEEDED IT.
 *
 * Operator, 2026-10-15: ClickHouse memory spikes "cannot be tolerated". It arrived 2026-03-12 (3c9c9834e) as part of a
 * Langfuse v3-shaped stack (server + worker + ClickHouse) on the v2 image; the worker was removed 2026-07-24 (it had no
 * code in v2) and ClickHouse stayed — required at Langfuse's start, read by nothing. In the running image (2.95.11)
 * every read-from-ClickHouse switch defaults to false and CLICKHOUSE_URL is optional. Measured the same day: Langfuse
 * with no ClickHouse started in 10 s, ingested a trace (201), served it through its UI, trace API and daily metrics
 * API, logged only "CLICKHOUSE_URL not configured, skipping migration", and sat at ~280 MiB. On disk ClickHouse held
 * ~44 KB of Langfuse tables and ~450 MB of its own system logs (text_log, asynchronous_metric_log, metric_log).
 *
 * The artefact the stack runs from is each compose file: asserted on it, service by service.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'js-yaml';

const ROOT = join(__dirname, '../../..');
const FILES = ['docker-compose.observability.yml', 'docker-compose.epam-cli.yml'];

describe('the observability stack carries no ClickHouse', () => {
  for (const f of FILES) {
    const doc = YAML.load(readFileSync(join(ROOT, f), 'utf8')) as any;
    const services: Record<string, any> = doc.services || {};

    it(`${f}: Langfuse and its Postgres are still there (the stack is not empty)`, () => {
      const names = Object.keys(services);
      expect(names.some((n) => n.startsWith('langfuse'))).toBe(true);
      expect(names).toContain('postgres');
    });

    it(`${f}: no ClickHouse service and no ClickHouse volume`, () => {
      expect(Object.keys(services).filter((n) => /clickhouse/i.test(n))).toEqual([]);
      for (const [n, s] of Object.entries(services)) expect(String(s.image || ''), n).not.toMatch(/clickhouse/i);
      expect(Object.keys(doc.volumes || {}).filter((v) => /clickhouse/i.test(v))).toEqual([]);
    });

    it(`${f}: no service is configured for ClickHouse or waits for it`, () => {
      for (const [n, s] of Object.entries(services)) {
        const env = Array.isArray(s.environment) ? s.environment.map((e: string) => e.split('=')[0]) : Object.keys(s.environment || {});
        expect(env.filter((k: string) => /CLICKHOUSE/i.test(k)), `${n} env`).toEqual([]);
        const deps = Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on || {});
        expect(deps.filter((d: string) => /clickhouse/i.test(d)), `${n} depends_on`).toEqual([]);
      }
    });
  }
});
