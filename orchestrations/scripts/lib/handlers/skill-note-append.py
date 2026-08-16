#!/usr/bin/env python3
"""
APPEND A SELF-HEAL SKILL NOTE TO A ROLE'S PROFILE.

The note is what a run learned; the profile is where a future run reads it. Written through a
temporary file and os.replace, so a profile is never left half-written.

Lifted out of lib/story-guards.sh on 2026-08-16, where it was an UNQUOTED heredoc: the profile path
and the role name were substituted into the program's own source, and the note came in as an
argument. All three are arguments now.

Generic: nothing here is project- or stack-specific — the role is whatever the roster minted.

    argv[1]  the note text, without its prefix
    argv[2]  the profiles file, read and written in place
    argv[3]  the role to append to
    stdout   a line saying it was persisted
    stderr   a line saying it was NOT, when the role is absent

An unknown ROLE is reported and not fatal — the caller logs it. An unreadable PROFILES file is
fatal: the note is the run's only record of what it learned, and silently dropping it is how a
lesson gets lost between runs.
"""
import json
import os
import sys

if len(sys.argv) < 4:
    sys.stderr.write("[skill-note-append] usage: <note> <profiles.json> <role>\n")
    sys.exit(1)

note_text, profiles_path, role = sys.argv[1], sys.argv[2], sys.argv[3]
note = '[Self-Heal] ' + note_text

try:
    with open(profiles_path) as f:
        profiles = json.load(f)
except (OSError, ValueError) as e:
    sys.stderr.write(f"[skill-note-append] cannot read {profiles_path}: {e}\n")
    sys.exit(1)

if role in profiles:
    existing = profiles[role]
    sep = '\n\n' if existing else ''
    profiles[role] = existing + sep + note
    tmp = profiles_path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(profiles, f, indent=2)
    os.replace(tmp, profiles_path)
    print(f'Skill note appended to [{role}] profile — persisted for future runs')
else:
    print(f'Profile role [{role}] not found in profiles.json — skill note NOT persisted', file=sys.stderr)
