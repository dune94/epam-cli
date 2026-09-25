/**
 * estate-survey and survey-review — answered the way a diligent model answers them.
 *
 * The survey opens every codeline in scope and reports what it saw; on a greenfield codeline that
 * is an empty (or scaffold-only) repository the work plainly reaches. The review checks the
 * survey's claims against the repositories and, when the survey only reported what is on disk,
 * finds nothing false.
 */
import type { Filler } from '../answer';
import type { World } from '../world';

export function estateSurvey(world: World, prompt: string): Filler {
  const scope = world.codelinesIn(prompt);
  return (f, path) => {
    if (path === 'codelines') {
      return scope.map((c) => {
        const files = world.files(c, 5);
        return {
          codeline: c.name,
          state: 'in_scope',
          evidence: files.length ? `listed ${c.name}: ${files.length}+ files, e.g. ${files.slice(0, 3).join(', ')}` : `listed ${c.name}: the repository is empty — the ticket builds it from nothing`,
          surfaces: world.surfaces(c),
          filesRead: files.slice(0, 3),
        };
      });
    }
    if (path === 'recommendedInvestigators') return [];
    if (path === 'recommendedWriters') return scope.map((c) => ({ codeline: c.name, focus: `the ${world.domain()} implementation the stories describe`, why: `the stories declare their files in ${c.name}` }));
    return undefined;
  };
}
