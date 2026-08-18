# Union two checkpoint PRDs by story id. A story present in both keeps the copy carrying more
# spec output, so a lane that never reached the spec pass cannot blank another lane's story.
def spec: ((.verificationCriteria // []) | length) + ((.fixSiteAnalysis // []) | length);
((.[0].stories // []) + (.[1].stories // []) | group_by(.id) | map(sort_by(spec) | last)) as $stories
| .[0] | .stories = $stories
