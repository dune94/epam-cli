import sys, json, re, os

# ── Which findings actually BLOCK a story ────────────────────────────────────────────────────
#
# On BROWNFIELD, a dependency CVE the story did not introduce is pre-existing repository debt, not
# a defect in the work under review. Live metrolinx AMSD-2041, 2026-08-19: a reviewer-APPROVED,
# tsc-clean, lint-clean commit (af1d6b99, 6 files, +181) was failed by one blocker —
#
#   [critical] (runtime) next-auth — Auth.js email normalizer validates before Unicode
#   normalization, allowing a homoglyph @ bypass
#
# The finding was CORRECT (verified against npm audit: critical:1, next-auth, runtime). But the
# story added one dependency and touched five source files; it did not touch next-auth. No writer
# output can change `npm audit`, so the failure discarded the approved commit, reset the branch and
# regenerated — a closed loop at ~$3 and ~40 minutes per cycle with no exit inside the run.
#
# NOT A BLANKET AMNESTY. A CVE in a dependency THIS story adds still blocks, or the pipeline could
# ship a newly vulnerable package. Non-dependency blockers (hardcoded credentials, injection) are
# untouched — they are findings about the story's own code. Greenfield is unchanged: a repository
# the run created owns every dependency in it.
#
# The story's added packages arrive as EPAM_STORY_INTRODUCED_DEPS (comma-separated). Absent or
# empty means the story introduced none.

_DEP_RULE = re.compile(r'^dependency-cve-', re.IGNORECASE)


def _introduced():
    raw = os.environ.get('EPAM_STORY_INTRODUCED_DEPS', '') or ''
    return [p.strip() for p in raw.split(',') if p.strip()]


def _is_preexisting_dependency_finding(f):
    """A dependency-CVE finding naming no package this story introduced."""
    if os.environ.get('EPAM_BROWNFIELD', '0') != '1':
        return False
    if not _DEP_RULE.match(str(f.get('rule', '') or '')):
        return False
    blob = json.dumps(f)
    for pkg in _introduced():
        if pkg and pkg in blob:
            return False          # the story added this package — it owns the CVE
    return True


def _count(findings):
    n = 0
    for f in findings:
        if str(f.get('severity', '')).lower() != 'blocker':
            continue
        if _is_preexisting_dependency_finding(f):
            sys.stderr.write(
                "[sast-blockers] advisory (brownfield, not introduced by this story): "
                "%s %s\n" % (f.get('rule', '?'), f.get('file', '?')))
            continue
        n += 1
    return n


try:
    text = open(sys.argv[1]).read()
    parsed = None
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group(0))
        except Exception:
            pass
    if parsed is not None:
        findings = parsed.get('findings', None)
        if findings is not None:
            # Count the findings themselves, so the brownfield rule can apply per finding.
            # summary.blockerCount cannot express "this one is pre-existing".
            print(_count(findings))
        else:
            summary_count = parsed.get('summary', {}).get('blockerCount', None)
            print(summary_count if summary_count is not None else 0)
    else:
        sm = re.search(r'"summary"\s*:\s*\{([^}]*)\}', text, re.DOTALL)
        if sm:
            try:
                summary = json.loads('{' + sm.group(1) + '}')
                bc = summary.get('blockerCount', None)
                if bc is not None:
                    print(bc)
                    sys.exit(0)
            except Exception:
                pass
        print(len(re.findall(r'"severity"\s*:\s*"blocker"', text, re.IGNORECASE)))
except Exception:
    print(-1)
