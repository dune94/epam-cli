// "WHICH DEPENDENCIES DID THIS STORY ADD" WAS ANSWERED TWICE, AND ONCE IN NODE-ONLY GREP.
//
// The brownfield-CVE fix (665f1a5) needed the answer and computed it inline in
// run-agent-orchestration.sh: `git diff <ref> -- package.json | grep '^+' | grep -oE '"[^"]+" *:'`.
// That names package.json and assumes a JSON manifest, so on a Cargo, Go or Gemfile codeline it
// returns nothing — and returning nothing means "this story introduced no dependency", which
// silently converts every finding into pre-existing debt and disarms the gate.
//
// The lockfile-sync gate needs the same answer, so it moves to one handler that asks
// lib/ecosystems.js — the one table — rather than to a second copy of the regex.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/introduced-deps.js');
const NODE = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A repo whose manifest gains `after` on top of committed `before`. */
function repoWithChange(manifest: string, before: string, after: string) {
  const repo = mkdtempSync(join(tmpdir(), 'intro-deps-'));
  made.push(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 't']);
  writeFileSync(join(repo, manifest), before);
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  const ref = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(repo, manifest), after);
  return { repo, ref };
}

function introduced(repo: string, ref: string): string[] {
  const r = spawnSync(NODE, [HANDLER, repo, ref], { encoding: 'utf8' });
  // WITHOUT THIS, every `toEqual([])` below passes when the handler does not exist at all —
  // an absent handler prints nothing, and nothing parses to no dependencies. The empty
  // expectations are the majority here, so the vacuous case would be the quiet one.
  if (r.status !== 0) throw new Error(`handler exited ${r.status}: ${r.stderr || 'not runnable'}`);
  return (r.stdout || '').trim().split(',').map((s) => s.trim()).filter(Boolean);
}

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'f', dependencies: deps }, null, 2);

describe('a Node codeline', () => {
  it('reports only what the change ADDED', () => {
    const { repo, ref } = repoWithChange('package.json',
      pkg({ react: '^18.0.0' }), pkg({ react: '^18.0.0', '@scope/new': '^1.0.0' }));
    expect(introduced(repo, ref)).toEqual(['@scope/new']);
  });

  it('reports nothing when the change only bumps an existing version', () => {
    const { repo, ref } = repoWithChange('package.json', pkg({ react: '^18.0.0' }), pkg({ react: '^19.0.0' }));
    expect(introduced(repo, ref)).toEqual([]);
  });

  it('does not report a dependency the change REMOVED', () => {
    const { repo, ref } = repoWithChange('package.json',
      pkg({ react: '^18.0.0', old: '^1.0.0' }), pkg({ react: '^18.0.0' }));
    expect(introduced(repo, ref)).toEqual([]);
  });
});

describe('a codeline that is not Node', () => {
  it('answers for Cargo, which the inline grep could not', () => {
    const { repo, ref } = repoWithChange('Cargo.toml',
      '[package]\nname = "f"\n\n[dependencies]\nserde = "1.0"\n',
      '[package]\nname = "f"\n\n[dependencies]\nserde = "1.0"\nregex = "1.10"\n');
    expect(introduced(repo, ref)).toEqual(['regex']);
  });

  it('answers for a Gemfile', () => {
    const { repo, ref } = repoWithChange('Gemfile',
      "source 'https://rubygems.org'\ngem 'rails'\n",
      "source 'https://rubygems.org'\ngem 'rails'\ngem 'nokogiri'\n");
    expect(introduced(repo, ref)).toContain('nokogiri');
  });
});

describe('the cases where it must claim nothing', () => {
  it('a manifest the change never touched yields nothing', () => {
    const { repo, ref } = repoWithChange('package.json', pkg({ react: '^18.0.0' }), pkg({ react: '^18.0.0' }));
    expect(introduced(repo, ref)).toEqual([]);
  });

  it('an unreadable baseline ref exits non-zero rather than reporting "none"', () => {
    const { repo } = repoWithChange('package.json', pkg({ a: '1' }), pkg({ a: '1', b: '2' }));
    const r = spawnSync(NODE, [HANDLER, repo, 'deadbeefdeadbeef'], { encoding: 'utf8' });
    expect(r.status, 'a broken ref reported "no dependencies introduced", disarming both gates')
      .not.toBe(0);
  });
});

describe('the old inline regex is gone', () => {
  it('run-agent-orchestration.sh no longer names package.json to answer this', () => {
    const sh = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    const block = sh.split('\n').filter((l) => /_introduced_deps=/.test(l)).join('\n');
    expect(block).not.toMatch(/package\.json/);
    expect(block).not.toMatch(/grep -oE/);
  });
});
