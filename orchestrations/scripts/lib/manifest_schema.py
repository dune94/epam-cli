#!/usr/bin/env python3
"""Schema and reviewer for the per-codeline dependency manifest.

The manifest tells run_dependency_check() how THIS codeline declares its
dependencies: which file is the manifest, which keys hold deps, which file
extensions to scan, how to recognise an import, how to install, what is vendor.
Nothing in the engine knows what a package.json is — the manifest says so.

WHY THIS FILE EXISTS. The manifest was hand-written, and it showed: metrolinx's
`ignorePackages` carries "src" and "tests" among the Node builtins — someone
listing internal directory names one at a time, who never reached
components/api/interface. On 2026-07-29 that omission had three lanes trying to
npm-install their own source directories (346/553/506 attempts) until the story
budget was gone. Nothing generated the file; every other reference to
dependency-check.json is a test.

So a detector agent emits it per codeline and a reviewer validates it here.

TWO DESIGN RULES, both bought with real failures:

  min_length on every list. A schema that permits saying nothing is not a
  contract: openspec is already tool-bound with acceptanceCriteria required and
  still returned [] repeatedly — structurally valid, useless. An empty
  scanFileExtensions would silently disable scanning; empty manifestKeys would
  make every dependency look undeclared.

  The reviewer checks the manifest against the REAL codeline, not against
  itself. A manifest can be perfectly well-formed and still describe a
  different project — an importPattern that compiles but matches nothing would
  report a codeline with zero dependencies and nobody would notice.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import List

from pydantic import BaseModel, Field


class DependencyManifest(BaseModel):
    """What run_dependency_check needs to scan one codeline."""

    model_config = {"extra": "forbid"}  # a mistyped field must fail, not vanish

    manifestFile: str = Field(
        min_length=1,
        description="File declaring this project's dependencies, relative to the "
                    "codeline root (e.g. the packaging manifest for this stack)",
    )
    manifestKeys: List[str] = Field(
        min_length=1,
        description="Top-level keys in manifestFile whose values map dependency "
                    "name -> version",
    )
    scanFileExtensions: List[str] = Field(
        min_length=1,
        description="Source file extensions to scan for imports, including the dot",
    )
    importPattern: str = Field(
        min_length=1,
        description="Regex with one capturing group per alternative, matching the "
                    "MODULE NAME in this language's import syntax. Must not match "
                    "relative imports.",
    )
    installCommand: str = Field(
        min_length=1,
        description="Command to install one package; must contain the literal "
                    "{package} placeholder",
    )
    vendorDirs: List[str] = Field(
        min_length=1,
        description="Directories holding installed third-party code, excluded from "
                    "source scanning",
    )
    ignorePackages: List[str] = Field(
        default_factory=list,
        description="Module names that are part of the language/runtime itself and "
                    "are never installed",
    )
    requiredDevDependencies: List[str] = Field(
        default_factory=list,
        description="Tooling packages invoked as a binary and therefore never "
                    "imported, so import scanning cannot detect them",
    )
    commentPatterns: List[str] = Field(
        default_factory=list,
        description="Regexes matching this language's comment syntax, stripped "
                    "from a file's text before import scanning. importPattern has "
                    "no concept of a comment or string literal, so 'from \"X\" to "
                    "\"Y\"' inside a doc comment matches identically to a real "
                    "import (live 2026-07-30: a JSDoc comment reading 'Convert "
                    "time from \"11:30\" to \"11-30\" format' was scanned as an "
                    "import of a package named 11:30). Optional: an empty list "
                    "keeps today's behaviour unchanged.",
    )


def json_schema() -> dict:
    """The provider-bound schema. Name matches the agent role."""
    return {"name": "dependency_manifest", "schema": DependencyManifest.model_json_schema()}


def _sample_source_files(repo: str, exts: List[str], vendor: List[str], limit: int = 200) -> List[str]:
    """Source files in the codeline, skipping vendor and dot directories."""
    out: List[str] = []
    vendor_set = set(vendor)
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in vendor_set]
        for f in files:
            if any(f.endswith(e) for e in exts):
                out.append(os.path.join(root, f))
                if len(out) >= limit:
                    return out
    return out


def validate(manifest: dict, repo: str) -> dict:
    """Mechanical review of a manifest against the codeline it describes.

    Every check is a fact about the repository — nothing here is an opinion, so
    the verdict is reproducible and needs no model.
    """
    issues: List[str] = []

    try:
        m = DependencyManifest(**manifest)
    except Exception as exc:  # schema violation is itself a reviewable failure
        return {"verdict": "fail", "issues": [f"schema: {exc}"]}

    if not os.path.isfile(os.path.join(repo, m.manifestFile)):
        issues.append(
            f"manifestFile '{m.manifestFile}' does not exist in the codeline — "
            f"the scanner would find no declared dependencies at all"
        )

    try:
        pattern = re.compile(m.importPattern)
    except re.error as exc:
        pattern = None
        issues.append(f"importPattern does not compile: {exc}")

    for cp in m.commentPatterns:
        try:
            re.compile(cp)
        except re.error as exc:
            issues.append(f"commentPatterns entry '{cp}' does not compile: {exc}")

    if "{package}" not in m.installCommand:
        issues.append("installCommand has no {package} placeholder — nothing to substitute")

    for d in m.vendorDirs:
        if not os.path.isdir(os.path.join(repo, d)):
            issues.append(f"vendorDirs entry '{d}' is not a directory in this codeline")

    files = _sample_source_files(repo, m.scanFileExtensions, m.vendorDirs)
    if not files:
        issues.append(
            f"scanFileExtensions {m.scanFileExtensions} match no files in this codeline — "
            f"the scanner would read nothing"
        )
    elif pattern is not None:
        matched = 0
        for path in files:
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                    if pattern.search(fh.read()):
                        matched += 1
                        break
            except OSError:
                continue
        if matched == 0:
            issues.append(
                "importPattern compiled but matched no imports in any sampled source file — "
                "the codeline would report zero dependencies"
            )

    # A failing verdict MUST carry something actionable, or the regenerate loop
    # has nothing to correct and the rejection is irreversible. Same rule
    # prd-change-reviewer already states for its own verdicts.
    if issues:
        return {"verdict": "fail", "issues": issues}
    return {"verdict": "pass", "issues": []}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--print-schema", action="store_true")
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--repo", default="")
    args = ap.parse_args()

    if args.print_schema:
        print(json.dumps(json_schema()))
        return 0

    if args.validate:
        if not args.repo:
            print(json.dumps({"verdict": "fail", "issues": ["--repo is required"]}))
            return 0
        try:
            manifest = json.load(sys.stdin)
        except Exception as exc:
            print(json.dumps({"verdict": "fail", "issues": [f"unparseable manifest: {exc}"]}))
            return 0
        print(json.dumps(validate(manifest, args.repo)))
        return 0

    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
