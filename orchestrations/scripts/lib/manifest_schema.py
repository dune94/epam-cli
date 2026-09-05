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
from typing import List, Optional

from pydantic import BaseModel, Field, StrictBool


class LocalDependencyOverride(BaseModel):
    """Re-provision one package from a local source instead of its registry.

    Exists for the case a registry is genuinely unreachable (private-registry
    auth unavailable, e.g. GitHub Packages with no token) but the real
    package source is already cloned locally as another codeline. Applied by
    brownfield-preflight-reset.sh, entirely inside node_modules (npm install
    --no-save) — never edits package.json/package-lock.json, so there is
    nothing to commit and nothing a client-repo git reset can undo.
    """

    model_config = {"extra": "forbid"}

    codeline: str = Field(
        min_length=1,
        description="Basename of the codeline directory this override applies to "
                    "(e.g. 'next.upexpress.com') — matched against basename(PROJECT_ROOT)",
    )
    package: str = Field(
        min_length=1,
        description="The npm package name to override (e.g. '@metrolinx/cx-shared')",
    )
    localSourcePath: str = Field(
        min_length=1,
        description="Path to a local directory or tarball npm can install via the "
                    "file: protocol. RELATIVE paths resolve against the codeline root "
                    "this install declares (JIRA_CODELINE_ROOT), which is how a project "
                    "avoids naming one machine tree; absolute paths are still accepted "
                    "for sources that legitimately live outside that root.",
    )


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
    localDependencyOverrides: List[LocalDependencyOverride] = Field(
        default_factory=list,
        description="Packages to re-provision from a local source instead of their "
                    "registry, per codeline. Optional: empty list keeps today's "
                    "behaviour (real registry install) unchanged.",
    )
    # ── FIELDS THE ENGINE ALREADY READS ──────────────────────────────────────────────────────
    #
    # These nine were live in project manifests and absent from this model, so `extra: forbid`
    # rejected real configuration: metrolinx's manifest failed with 8 extra_forbidden errors and
    # skyscanner's with one. Validation aborts on a schema error, so it never reached the semantic
    # checks below — the importPattern compile, the manifestFile existence check, and the
    # localSourcePath check that keeps an override out of the wrong codeline tree. The reviewer
    # this module's docstring describes was INERT for every project that declared any of them.
    #
    # extra: forbid stays. "A mistyped field must fail, not vanish" is exactly why this drift was
    # visible at all; the repair is to declare what is real, not to stop checking.
    #
    # ALL OPTIONAL. mock3 and skyscanner declare far fewer fields than metrolinx, and making any
    # of these required would break every project that has not opted in.
    buildArtifactDirs: List[str] = Field(
        default_factory=list,
        description="Directories holding build output, excluded from source scanning like "
                    "vendorDirs. Read by plugins/dependency-scan-plugin.js.",
    )
    indexFileNames: List[str] = Field(
        default_factory=list,
        description="Basenames that make a file its directory's barrel (e.g. 'index'), so a "
                    "directory import resolves to it. Read by plugins/dependency-scan-plugin.js.",
    )
    moduleConfigGlob: Optional[str] = Field(
        default=None,
        description="Glob matching the file that declares module path aliases "
                    "(e.g. 'tsconfig*.json'). Read by plugins/dependency-scan-plugin.js.",
    )
    moduleAliasPath: Optional[str] = Field(
        default=None,
        description="Dotted path to the alias map inside moduleConfigGlob's file "
                    "(e.g. 'compilerOptions.paths'). Read by plugins/dependency-scan-plugin.js.",
    )
    moduleRoots: List[str] = Field(
        default_factory=list,
        description="Directory prefixes a non-relative import may resolve against before it "
                    "counts as an external package — '' means the codeline root. Read by "
                    "scripts/claude.sh and lib/eslint-baseline-gate.sh.",
    )
    # STRICT. Plain `bool` coerces: pydantic accepts the STRING 'yes' — and, worse, the
    # string 'false', which is truthy as a string and would read as enabled. A setting that
    # decides whether the pipeline installs packages onto a client codeline must be the
    # boolean it looks like, or be refused.
    autoInstall: StrictBool = Field(
        default=False,
        description="Whether a missing dependency may be installed automatically. Read by "
                    "scripts/claude.sh. Defaults false: installing on a client codeline is an "
                    "opt-in, never a surprise.",
    )
    dependencySensitiveConfigFiles: List[str] = Field(
        default_factory=list,
        description="Config files whose behaviour depends on installed dependencies (e.g. "
                    "'jest.config.js'), so a change to one invalidates prior analysis. Read by "
                    "detective-rerun-step.js and lib/plan-fidelity-gate.sh.",
    )
    coupledFilePairs: List[List[str]] = Field(
        default_factory=list,
        description="Files that must change together (e.g. package.json with its lockfile). Read "
                    "by scripts/claude.sh and lib/coupled-pair-gate.sh.",
    )
    vendorCacheExcludePatterns: List[str] = Field(
        default_factory=list,
        description="Globs inside vendorDirs that are build caches rather than installed code "
                    "(e.g. '.vite/*'), excluded from vendor scanning.",
    )
    testFailurePattern: Optional[str] = Field(
        default=None,
        description="Regex with one capturing group identifying a FAILING test's "
                    "identity from this project's test-runner output (e.g. the file "
                    "path in a Jest 'FAIL <path>' summary line). Optional: RG-DELTA "
                    "(the regression guard's before/after failing-set comparison) is "
                    "inert without it, and the guard falls back to today's "
                    "all-or-nothing baseline check. Absence never breaks anything "
                    "already relying on this manifest.",
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

    # SELF-DOCUMENTING KEYS ARE DOCUMENTATION, NOT CONFIGURATION.
    #
    # This repository writes the reason for a setting beside it, in the same file: `_what`,
    # `_shape`, `$why`, `$comment`. Every project manifest opens with one, and `extra: forbid`
    # rejected it — mock3's ONLY validation error was its own `_what` string. So a file that is
    # entirely correct failed, and because validation aborts on a schema error, none of the
    # semantic checks below ever ran for it.
    #
    # Dropped rather than declared: adding a `_what` field would invite `_why`, `_note` and the
    # rest, each needing its own declaration. The convention is a PREFIX, so the prefix is what is
    # honoured. Everything without one still meets extra: forbid, so a mistyped real field fails
    # exactly as before.
    _config = {k: v for k, v in manifest.items()
               if not (k.startswith("_") or k.startswith("$"))}

    try:
        m = DependencyManifest(**_config)
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

    # AN OVERRIDE FOLLOWS THE CODELINE ROOT THIS INSTALL DECLARES.
    #
    # This accepted only absolute paths, and checked them with os.path.exists — which asks whether
    # the path is real, never whether it is real in the RIGHT TREE. Found 2026-09-05 on a fresh
    # test install: metrolinx declared
    #     "localSourcePath": "/home/bradleyjerome/projects/metrolinx/cx-shared"
    # while that install's JIRA_CODELINE_ROOT was .../projects/tests/codelines. Both roots hold a
    # cx-shared, so it validated cleanly while pointing npm at the REAL working copies — silently,
    # and against a standing rule that the test project never addresses them.
    #
    # A relative path is resolved against the root the install already declares once, so the value
    # cannot be right on one machine and wrong on every other. Absolute paths keep working: a
    # project may legitimately point outside the root, and this field already ships absolute values.
    for override in m.localDependencyOverrides:
        _src = override.localSourcePath
        if not os.path.isabs(_src):
            _root = (os.environ.get("JIRA_CODELINE_ROOT") or "").strip()
            if not _root:
                # NEVER FALL BACK TO THE CWD. That resolves to whatever directory the validator
                # happened to run in — passing on one machine and pointing elsewhere on the next,
                # which is precisely the "real path, wrong tree" failure above.
                issues.append(
                    f"localDependencyOverrides entry for '{override.package}' "
                    f"(codeline '{override.codeline}'): localSourcePath '{_src}' is relative but "
                    f"no codeline root is declared — set JIRA_CODELINE_ROOT (the project's "
                    f"config.env declares it) or give an absolute path"
                )
                continue
            _src = os.path.join(_root, _src)
        if not os.path.exists(_src):
            issues.append(
                f"localDependencyOverrides entry for '{override.package}' "
                f"(codeline '{override.codeline}'): localSourcePath "
                f"'{_src}' does not exist — npm install would fail"
            )

    if m.testFailurePattern is not None:
        try:
            re.compile(m.testFailurePattern)
        except re.error as exc:
            issues.append(f"testFailurePattern does not compile: {exc}")

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
