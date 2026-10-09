#!/usr/bin/env python3
"""
WHETHER TWO SELF-HEAL DIAGNOSES NAME THE SAME ROOT CAUSE — one definition, two readers.

check_healing_effectiveness (lib/failure-healing.sh) asks how many of the latest diagnoses repeat the current one
(HEALING_BROKEN at 2+); the retry-extension coordinator's evidence (lib/retry-extension.sh) asks how many distinct root
causes a story has had. They counted differently — paraphrase overlap here, exact strings there — so three wordings of
one bug were "3 distinct" to the coordinator and a repeat to the healing check (found 2026-10-08). Both now read this.
Lifted verbatim from check_healing_effectiveness.

    repeats  <healing-events.jsonl> <story_id> <current_diagnosis>  -> consecutive latest events with its root cause
    distinct <healing-events.jsonl> <story_id>                      -> number of distinct root causes among its events
"""
import json, re, sys


STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    # min(3, ...) scales the absolute-overlap floor down for short diagnoses — a
    # diagnosis with only 2 significant words (e.g. "exact repeats") could never
    # reach a flat floor of 3 even when identical to itself.
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4


def story_events(heal_log, story):
    events = []
    try:
        with open(heal_log) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                        events.append(obj.get('diagnosis', ''))
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return events

mode = sys.argv[1]
if mode == 'repeats':
    heal_log, story, current = sys.argv[2], sys.argv[3], sys.argv[4]
    count = 0
    for d in reversed(story_events(heal_log, story)):
        if same_root_cause(d, current):
            count += 1
        else:
            break
    print(count)
elif mode == 'distinct':
    heal_log, story = sys.argv[2], sys.argv[3]
    causes = []
    for d in story_events(heal_log, story):
        if not any(same_root_cause(d, c) for c in causes):
            causes.append(d)
    print(len(causes))
else:
    sys.exit('usage: healing-root-causes.py repeats|distinct ...')
