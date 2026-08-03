"""Story file-manifest schema — the single source of truth for which files a story
touches, per codeline.

Distinct from lib/manifest_schema.py, which describes a codeline's DEPENDENCY manifest
(package.json and friends) for run_dependency_check(). This one describes the story's
FILE manifest: fix sites, candidates and deliverables.

The recurring pipeline failure is ASSERTION WITHOUT VERIFICATION: a path asserted to
exist, a ranked search hit asserted to be a deliverable, one file list asserted to be
correct for every codeline. A test catches those after they are written; a schema makes
them unconstructible.

PROVENANCE IN THE TYPE is the load-bearing idea. `ResolvedPath` cannot be built without
`verified_against` — the value carries the evidence of its own derivation. Consequently:

    FixSite.path   : ResolvedPath    a prescribed fix site CANNOT hold an unresolved path
    Candidate.path : PathRef         a ranked guess MAY be unresolved — it is a guess
    deliverables   : [ResolvedPath]  review grades only verified paths

Because FixSite and Candidate are different TYPES, a search hit can never be fed into
the "you must actually write to them" retry prompt. That separation is structural, not
a convention someone has to remember.

Live failure this closes (2026-08-03): the detective's root-cause file was declared once
for three codelines whose real filenames differ — `ContentstackContext.tsx`,
`ContentstackContext.ts`, `contentstackContext.tsx`. Two of three writers were handed a
path that does not exist, and a reviewer then blocked a writer for not editing it.

NOTHING here names a project, client, codeline, vendor or stack. Codeline names arrive
as data from the story. `resolve_path` assumes NO naming convention — it reads the real
checkout and reports what is actually there, so it works on the next unknown repo. This
is why there is no camelCase rule: the repository is the authority, not a convention.

Runtime note: Python is DEV-TIME only. `json_schema()` generates
orchestrations/config/manifest.schema.json, which is committed and validated in-process
by ajv at the JS seam — so no runtime Python dependency is introduced.

Regenerate:
    orchestrations/scripts/.venv/bin/python orchestrations/scripts/lib/story_manifest_schema.py \
        > orchestrations/config/manifest.schema.json
"""

from __future__ import annotations

import json
import os
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ResolvedPath(BaseModel):
    """A path PROVEN to exist in a specific checkout.

    `verified_against` is required and has no default: an instance cannot exist without
    recording the checkout it was proven against.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["resolved"] = "resolved"
    declared: str = Field(description="The path as originally requested (detective/search).")
    actual: str = Field(description="The path that genuinely exists in this codeline.")
    match: Literal["exact", "case_variant", "extension_variant"]
    verified_against: str = Field(description="Codeline root the path was resolved in.")


class UnresolvedPath(BaseModel):
    """A path that could NOT be proven. Never silently downgraded to a pass."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["unresolved"] = "unresolved"
    declared: str
    candidates_checked: list[str] = Field(description="What was actually looked at, as evidence.")
    reason: str


PathRef = Annotated[Union[ResolvedPath, UnresolvedPath], Field(discriminator="kind")]


class FixSite(BaseModel):
    """A prescribed change location. Its path MUST resolve — enforced by the type."""

    model_config = ConfigDict(extra="forbid")

    path: ResolvedPath
    reason: str
    function: Optional[str] = None
    broken_line: Optional[str] = None


class Candidate(BaseModel):
    """A ranked search hit. Allowed to be unresolved; never a deliverable."""

    model_config = ConfigDict(extra="forbid")

    path: PathRef
    source: Literal["codegraph", "semble", "deterministic", "detective"]
    rank: int = 0


class CodelineManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    codeline: str
    fix_sites: list[FixSite] = Field(default_factory=list)
    candidates: list[Candidate] = Field(default_factory=list)
    deliverables: list[ResolvedPath] = Field(default_factory=list)


class StoryManifest(BaseModel):
    """Per-codeline by construction — a single shared file list is not expressible."""

    model_config = ConfigDict(extra="forbid")

    story_id: str
    codelines: list[str]
    per_codeline: dict[str, CodelineManifest]

    @model_validator(mode="after")
    def _keys_cover_codelines(self) -> "StoryManifest":
        declared = set(self.codelines)
        present = set(self.per_codeline)
        if declared != present:
            missing = sorted(declared - present)
            extra = sorted(present - declared)
            raise ValueError(
                "per_codeline keys must exactly cover the story's codelines; "
                f"missing={missing} unexpected={extra}"
            )
        for name, entry in self.per_codeline.items():
            if entry.codeline != name:
                raise ValueError(
                    f"per_codeline['{name}'] declares codeline='{entry.codeline}'"
                )
        return self


def resolve_path(declared: str, codeline_root: str) -> Union[ResolvedPath, UnresolvedPath]:
    """Resolve a declared path against a REAL checkout. Assumes no naming convention.

    Order: exact, then case variant, then same-stem/different-extension. Anything else is
    unresolved WITH the candidates inspected, so the caller sees evidence rather than a
    bare failure. A convention is never imposed — the repository is the authority.
    """
    root = os.path.abspath(codeline_root)
    checked: list[str] = [declared]

    if os.path.isfile(os.path.join(root, declared)):
        return ResolvedPath(
            declared=declared, actual=declared, match="exact", verified_against=root
        )

    rel_dir = os.path.dirname(declared)
    base = os.path.basename(declared)
    stem, ext = os.path.splitext(base)
    abs_dir = os.path.join(root, rel_dir) if rel_dir else root

    def join_rel(entry: str) -> str:
        return os.path.join(rel_dir, entry) if rel_dir else entry

    if not os.path.isdir(abs_dir):
        return UnresolvedPath(
            declared=declared,
            candidates_checked=checked,
            reason=f"directory '{rel_dir or '.'}' does not exist in this codeline",
        )

    entries = sorted(os.listdir(abs_dir))

    for entry in entries:
        if entry != base and entry.lower() == base.lower():
            return ResolvedPath(
                declared=declared,
                actual=join_rel(entry),
                match="case_variant",
                verified_against=root,
            )

    for entry in entries:
        entry_stem, entry_ext = os.path.splitext(entry)
        if entry_stem.lower() == stem.lower() and entry_ext != ext:
            return ResolvedPath(
                declared=declared,
                actual=join_rel(entry),
                match="extension_variant",
                verified_against=root,
            )

    checked.extend(join_rel(e) for e in entries)
    return UnresolvedPath(
        declared=declared,
        candidates_checked=checked,
        reason="no exact, case-variant or extension-variant match exists in this codeline",
    )


def json_schema() -> dict:
    """The wire contract for JS/bash consumers. Generated — never hand-edited."""
    return StoryManifest.model_json_schema()


if __name__ == "__main__":
    print(json.dumps(json_schema(), indent=2, sort_keys=True))
