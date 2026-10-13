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

    # A STORY FAILS IF AND ONLY IF THE VALIDATOR FOUND A CRITERION UNMET. The free-form per-story verdict is not
    # read: on identical evidence it said "warn" for AMSD-2974's main line and "fail" for its 7.x back-port (both 0
    # unmet), and the "fail" halted the run. partial / untestable are the criteria only a person can confirm (screen
    # readers, zoom, devices, axe) — recorded for human follow-up, never a reason to stop the story (operator,
    # 2026-10-13: "human checks should not pause the completion of the user story"). The validator still judges every
    # criterion. Each story is matched only against its own slice (storyId boundary to the next).
    story_starts = [m.start() for m in re.finditer(r'"storyId"\s*:\s*"[^"]*"', text)]
    grounded_failing = 0
    for i, start in enumerate(story_starts):
        end = story_starts[i + 1] if i + 1 < len(story_starts) else len(text)
        statuses = re.findall(r'"status"\s*:\s*"(met|partial|unmet|untestable)"', text[start:end])
        if 'unmet' in statuses:
            grounded_failing += 1

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
