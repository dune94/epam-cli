/**
 * ac-classification — is the ticket's criteria enough, and which codeline(s) does its work live in.
 *
 * As a diligent model reads the request: the codelines it offers are the ones discovery grounded
 * (each listed with why), so a ticket offered more than one codeline spans them and is answered
 * "both", with its criteria split per codeline under the keys the request names. A criterion that
 * names something the library implements stays where that thing is implemented — here, every
 * offered codeline carries the criteria, because every one of them implements what the ticket names.
 * The verdict is "sufficient" for criteria that are present and checkable. Nothing about any project
 * is known here; every name is read from the request.
 */
export function acClassification(prompt: string): string {
  // THE CODELINE-ONLY QUESTION (ac-gate-codeline-assignment: a brownfield story with no criteria) asks for one key, in
  // the shape its own answer line shows. Its offered values are the quoted names it lists; the one whose reason says
  // the work spans codelines is the split value. Same rule as below: several offered, the split value; one, that one.
  const only = /Answer:\s*\n\s*\{"codeline":/.exec(prompt);
  if (only) {
    const listed = [...prompt.slice(0, only.index).matchAll(/^\s*-\s*"([^"]+)"\s+—([^\n]*)$/gm)];
    const split = listed.find((m) => /spans multiple codelines/.test(m[2]))?.[1];
    const named = listed.map((m) => m[1]).filter((c) => c !== split);
    return JSON.stringify({ codeline: named.length > 1 && split ? split : named[0] });
  }
  const section = prompt.slice(prompt.indexOf('CODELINE CLASSIFICATION'));
  const offered = [...section.split(/When codeline is/)[0].matchAll(/^\s*-\s*"([^"]+)"\s+—/gm)].map((m) => m[1]);
  const spanning = offered.find((o) => /spans multiple codelines/.test((section.match(new RegExp(`"${o}"\\s+—([^\\n]*)`)) || [])[1] || ''));
  const codelines = offered.filter((o) => o !== spanning);
  const acs = (/ACCEPTANCE CRITERIA:\n([\s\S]*?)\n\n/.exec(prompt) || [, ''])[1]
    .split('\n').map((l) => l.replace(/^\s*\d+\.\s*/, '').trim()).filter(Boolean);
  const perKey = [...section.matchAll(/^\s*-\s*"([A-Za-z0-9]+Acs)":\s*ACs that belong/gm)].map((m) => m[1]);
  const many = codelines.length > 1 && !!spanning;
  const out: Record<string, unknown> = {
    verdict: 'sufficient',
    reason: 'The criteria state the exact observable value and how the defect is reproduced.',
    codeline: many ? spanning : codelines[0],
    gaps: [],
    enrichedAcs: [],
  };
  for (const k of new Set(perKey)) out[k] = many ? acs : [];
  return JSON.stringify(out, null, 2);
}
