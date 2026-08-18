#!/usr/bin/env node
/**
 * EXTRACT THE STORY-ARTIFACT OBJECT FROM A WRITER RESPONSE.
 *
 * Prints the literal null when the response held no object, which the caller reads as 'the writer
 * recorded no artifact' — distinct from an empty one.
 *
 * Lifted out of claude.sh on 2026-08-16, where it was an inline `-c`/`-e` program whose text the
 * shell interpolated its inputs into. Generic: every input is an argument or stdin, and the rule
 * holds for any project and any stack.
 *
 *     stdin   the writer's raw response
 *     stdout  the artifact object, or null
 */
const chunks = []; process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', () => {
    const text = chunks.join('');
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) { try { JSON.parse(m[0]); process.stdout.write(m[0]); } catch { process.stdout.write('null'); } }
    else process.stdout.write('null');
});
