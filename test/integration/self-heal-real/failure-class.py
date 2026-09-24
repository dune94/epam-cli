#!/usr/bin/env python3
"""The class the pipeline recorded for this story's last failed attempt.

argv[1]  story-failures.jsonl   argv[2]  story id
stdout   the failureClass, or nothing when no failure was recorded

The harness reads the class rather than naming one: a class named in advance pins the test to the
run that was live when it was written, and the harness then certifies nothing once the engine
changes (output_cap stopped occurring when the writer's budget became the model's own maximum).
A record carrying no story field is taken as this story's — the single-story harness runs one.
"""
import json, sys

cls = ''
try:
    with open(sys.argv[1], encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue                       # one bad line must not hide the history
            if not isinstance(rec, dict):
                continue
            who = str(rec.get('story', rec.get('storyId', '')) or '')
            if who in ('', sys.argv[2]):
                cls = str(rec.get('failureClass', '') or cls)
except OSError:
    pass
print(cls)
