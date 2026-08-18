#!/usr/bin/env node
/**
 * RECORD ONE STORY'S DIFF VIEW IN THE MANIFEST.
 *
 * The manifest indexes every generated diff page. This replaces the story's existing entry rather
 * than adding a second one, and puts it first so the newest is at the top.
 *
 * Lifted out of generate-diff-view.sh on 2026-08-16, where it was a `node -e "..."` string with SIX
 * shell values interpolated into its own source — a branch name or a repo name containing a quote
 * was a syntax error in a language the author was not writing.
 *
 * Generic: every input is an argument. Nothing here is project- or stack-specific.
 *
 *   argv[2]  the manifest, read and written in place
 *   argv[3]  the story id
 *   argv[4]  the repo name
 *   argv[5]  the branch
 *   argv[6]  the baseline ref the diff is against
 *   argv[7]  the generated page, relative to the manifest
 *
 * A manifest that does not exist or does not parse starts empty — the same as before, because a
 * lost index is recoverable and a refused write loses the page that was just generated.
 */
'use strict';

const fs = require('fs');

const [, , manifestPath, storyId, repo, branch, baselineRef, file] = process.argv;
if (!manifestPath || !storyId || !file) {
  process.stderr.write('[diff-view-manifest-record] usage: <manifest> <story-id> <repo> <branch> <baseline-ref> <file>\n');
  process.exit(1);
}

let entries = [];
try { entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { entries = []; }
if (!Array.isArray(entries)) entries = [];

entries = entries.filter((e) => e.storyId !== storyId);
entries.unshift({
  storyId,
  repo,
  branch,
  baselineRef,
  file,
  generatedAt: new Date().toISOString(),
});

fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
