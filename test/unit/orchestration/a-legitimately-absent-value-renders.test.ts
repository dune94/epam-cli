/**
 * A LEGITIMATELY ABSENT VALUE RENDERS; A MISSING ONE STILL REFUSES.
 *
 * The blank-payload guard (v1.5) refuses a present-but-empty placeholder, because three agents had
 * been handed a section header with nothing under it and answered truthfully about silence. But
 * some values are legitimately empty, and for those the guard becomes the bug: it fires on a
 * correct state and blocks the run.
 *
 * That already happened once — `__PREVIOUS_REFUSAL__` on attempt 1 killed the first AMSD-1919 run.
 * These are the remaining placeholders whose SUPPLIER can legitimately return '':
 *
 *   spec-brownfield-mode.__UNREACHABLE_EXTERNALS__  unreachableExternalsConstraint() returns ''
 *                                                   whenever EPAM_MOCK_EXTERNAL_CMS_APIS !== '1',
 *                                                   which is the normal case
 *   spec-brownfield-mode.__VC_FORM_SAMPLES__        `vcFormSamples(env) ? ... : ''`
 *   ac-gate-codeline-assignment.__DESCRIPTION__     a ticket can genuinely have no description
 *
 * The judgement is per placeholder, not blanket. Empty means something different in each case, and
 * declaring one that ISN'T legitimately empty would re-open the hole the guard exists to close —
 * so the cases that indicate an upstream failure are asserted to STILL refuse.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderEngineTemplate } = require(join(LIB, 'engine-prompt.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));

describe('the supplier really can return empty — the premise', () => {
  it('unreachableExternalsConstraint returns empty when CMS mocking is off', () => {
    // Not exported; assert the branch from the source instead. The behavioural half — that the
    // template renders with '' — is what the next describe actually proves.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    expect(src).toMatch(/function unreachableExternalsConstraint[\s\S]{0,200}EPAM_MOCK_EXTERNAL_CMS_APIS !== '1'\) return '';/);
  });
});

describe('a legitimately absent value renders', () => {
  const brownfield = (over: Record<string, string> = {}) => renderEngineTemplate(
    'spec-brownfield-mode',
    {
      __VC_RULES__: 'the rules', __VC_SOURCE_VALUES_QUOTED__: '"a", "b"',
      __VC_FORM_SAMPLES__: '', __UNREACHABLE_EXTERNALS__: '',
      __AC_PREAMBLE__: 'the preamble', __SOURCES__: 'the sources', ...over,
    },
  );

  it('spec-brownfield-mode renders with no form samples and no unreachable externals', () => {
    const out = brownfield();
    expect(out.length, 'the prompt rendered empty').toBeGreaterThan(100);
    expect(out, 'a placeholder survived').not.toMatch(/__[A-Z0-9_]+__/);
  });

  it('and still carries them when they ARE supplied', () => {
    const out = brownfield({ __UNREACHABLE_EXTERNALS__: 'HOSTS-ARE-UNREACHABLE' });
    expect(out).toContain('HOSTS-ARE-UNREACHABLE');
  });

  it('ac-gate-codeline-assignment renders for a ticket with no description', () => {
    const out = renderEngineTemplate('ac-gate-codeline-assignment', {
      __JIRA_KEY__: 'X-1', __TITLE__: 'a title', __DESCRIPTION__: '',
      __CODELINE_LIST__: 'a, b', __SPLIT_VALUE__: 'split',
    });
    expect(out).toContain('X-1');
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
  });
});

describe('a value whose emptiness means something FAILED still refuses', () => {
  it('estate-survey refuses an empty codeline block — surveying nothing is not a survey', () => {
    expect(() => renderEngineTemplate('estate-survey', {
      __TICKET_BLOCK__: 't', __CODELINE_BLOCK__: '', __DOC_SECTION__: '', __DEP_SECTION__: '',
    })).toThrow(/__CODELINE_BLOCK__/);
  });

  it('project-roster-review refuses an empty roster path — the caller failed to supply it', () => {
    expect(() => renderEngineTemplate('project-roster-review', {
      __ROSTER_PATH__: '', __CANONICAL_PATH__: '/tmp/c.json',
      __CODELINE_CONTEXT__: '- cl', __PAIR_BLOCK__: '--- AGENT: a\nCANONICAL:\nc\nDERIVED:\nd',
    })).toThrow(/__ROSTER_PATH__/);
  });

  it('ac-gate still refuses an empty TITLE — a tracker always supplies a summary', () => {
    expect(() => renderEngineTemplate('ac-gate-codeline-assignment', {
      __JIRA_KEY__: 'X-1', __TITLE__: '', __DESCRIPTION__: 'd',
      __CODELINE_LIST__: 'a', __SPLIT_VALUE__: 'split',
    })).toThrow(/__TITLE__/);
  });
});
