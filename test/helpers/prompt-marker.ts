/**
 * The completion marker's CONTENT since 2026-09-21: a digest of everything the project's prompts
 * are built from (templates, registry, builder). An empty marker used to be the claim; it let a
 * template change go unapplied for a week and cost a paid rebuild. Fixtures that stand up a
 * "completed" codeline write what the builder writes — asked of the builder, never retyped.
 */
import { join } from 'node:path';

const BUILDER = join(__dirname, '../../orchestrations/scripts/lib/project-prompt-builder.js');

export function currentPromptDigest(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { promptInputsDigest } = require(BUILDER);
  const d = promptInputsDigest();
  if (typeof d !== 'string' || d.length < 32) throw new Error('promptInputsDigest returned no digest — a fixture built on it would prove nothing');
  return d;
}
