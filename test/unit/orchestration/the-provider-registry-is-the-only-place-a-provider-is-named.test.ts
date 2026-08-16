/**
 * Preflight rejects a story assigned to a provider the engine does not know. That check used to
 * carry its own set of vendor names, written as a Python set literal inside an embedded program —
 * a list no other check could read, and one nobody would think to update when a provider was
 * added.
 *
 * These tests hold the registry as the single point of maintenance: the handler must decide from
 * config/providers.json and from nothing else. The proof is a MUTATION — a provider that does not
 * exist is accepted once the registry declares it, and a real one is rejected once the registry
 * drops it. A handler carrying its own copy cannot do either.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/prd-story-assignment-check.py');
const REGISTRY = join(ROOT, 'orchestrations/config/providers.json');

let work: string;
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'provider-registry-')); });

const writeJson = (name: string, value: unknown) => {
  const p = join(work, name);
  writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
};

const check = (prd: string, registry: string) =>
  spawnSync('python3', [HANDLER, prd, registry], { encoding: 'utf8' });

const prdWith = (aiProvider: string) =>
  writeJson(`prd-${aiProvider.replace(/\W/g, '_')}.json`,
    { stories: [{ id: 'S-1', aiProvider, status: 'pending', effort: 'medium' }] });

describe('the provider registry is the only place a provider is named', () => {
  it('rejects a story assigned to a provider the registry does not declare', () => {
    // The live incident: prd-model-coordinator assigned a model on no declared ladder, and the
    // structural reviewer never checked membership.
    const r = check(prdWith('gpt-5-codex'), REGISTRY);
    expect(r.status, `handler said: ${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toContain("aiProvider='gpt-5-codex' is not a known provider");
  });

  it('accepts a story whose provider the registry declares', () => {
    const known = JSON.parse(readFileSync(REGISTRY, 'utf8')).known as string[];
    expect(known.length, 'the shipped registry declares no providers').toBeGreaterThan(0);
    const r = check(prdWith(known[0]), REGISTRY);
    expect(r.status, `handler said: ${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('valid aiProvider/model/status');
  });

  it('accepts an invented provider once the registry declares it', () => {
    // MUTATION. If the handler kept its own list this fails, because the invented name is on no
    // list it carries.
    const registry = writeJson('registry-added.json', {
      known: ['a-provider-that-does-not-exist'],
      effortBadged: [],
      storyStatuses: ['pending'],
    });
    const r = check(prdWith('a-provider-that-does-not-exist'), registry);
    expect(r.status, `handler said: ${r.stdout}${r.stderr}`).toBe(0);
  });

  it('rejects a real provider once the registry stops declaring it', () => {
    // The other direction of the same mutation, which catches a handler that consults the registry
    // AND falls back to a built-in list when the name is missing from it.
    const known = JSON.parse(readFileSync(REGISTRY, 'utf8')).known as string[];
    const registry = writeJson('registry-removed.json', {
      known: known.filter((p) => p !== known[0]),
      effortBadged: [],
      storyStatuses: ['pending'],
    });
    const r = check(prdWith(known[0]), registry);
    expect(r.status, `${known[0]} was accepted by a registry that does not list it`).toBe(1);
  });

  it('refuses to pass anything when the registry is empty', () => {
    // An empty registry declares no providers, so every story would read as valid — the failure
    // that turns the one check meant to catch a misrouted PRD into a rubber stamp.
    const registry = writeJson('registry-empty.json', { known: [], storyStatuses: [] });
    const r = check(prdWith('openai'), registry);
    expect(r.status, 'an empty registry passed a story').not.toBe(0);
    expect(r.stderr).toMatch(/declares no providers/);
  });

  it('names no provider anywhere in the handler', () => {
    const src = readFileSync(HANDLER, 'utf8');
    const body = src.split('"""').slice(2).join('"""');   // past the module docstring
    const known = JSON.parse(readFileSync(REGISTRY, 'utf8')).known as string[];
    for (const provider of known) {
      expect(body, `the handler names ${provider} in its own code`)
        .not.toMatch(new RegExp(`['"]${provider}['"]`));
    }
  });
});
