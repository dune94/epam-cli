# Total spec output in a PRD: verification criteria plus fix sites, across all stories.
[.stories[]? | ((.verificationCriteria // []) | length) + ((.fixSiteAnalysis // []) | length)] | add // 0
