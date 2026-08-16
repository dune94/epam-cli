import sys, re

# The spec-validator agent often emits JSON with unescaped newlines inside string
# values, making the output unparseable by json.loads regardless of extraction strategy.
# Use targeted line-level pattern matching instead — robust against malformed JSON.
try:
    text = open(sys.argv[1]).read()

    # Check the agent ran at all (must contain storyId references)
    if '"storyId"' not in text and '"stories"' not in text:
        print('no-json')
        sys.exit(0)

    if not re.search(r'"verdict"\s*:', text):
        print('no-data')
        sys.exit(0)

    # Grounding check (same principle already applied to fuzz-weaver/perf-sentinel):
    # a story's "fail" verdict is only trustworthy if the agent actually verified
    # SOMETHING about it. When every one of a story's criteria is self-reported
    # as "untestable" (the agent had no real evidence — e.g. it never actually
    # used its Read tool despite having access), that "fail" is a hallucinated
    # conclusion with nothing behind it, not a real finding. Slice the text by
    # story boundary (storyId occurrence) so each story's own verdict/criteria
    # are only matched against its OWN slice, not the whole document.
    story_starts = [m.start() for m in re.finditer(r'"storyId"\s*:\s*"[^"]*"', text)]
    grounded_failing = 0
    for i, start in enumerate(story_starts):
        end = story_starts[i + 1] if i + 1 < len(story_starts) else len(text)
        story_slice = text[start:end]
        if not re.search(r'"verdict"\s*:\s*"fail"', story_slice):
            continue
        statuses = re.findall(r'"status"\s*:\s*"(met|partial|unmet|untestable)"', story_slice)
        has_grounded_criterion = any(s != 'untestable' for s in statuses)
        if has_grounded_criterion:
            grounded_failing += 1
        # else: every criterion is untestable — ungrounded fail, don't count it

    # The overallVerdict line is a top-level field — distinct from per-story verdict
    overall_m = re.search(r'"overallVerdict"\s*:\s*"(\w+)"', text)
    overall = overall_m.group(1) if overall_m else None

    if grounded_failing > 0:
        print(grounded_failing)
    elif overall == 'warn':
        # Non-blocking partial — treat as 0 failures (warn path handled separately)
        print(0)
    else:
        print(0)
except Exception:
    print('error')
