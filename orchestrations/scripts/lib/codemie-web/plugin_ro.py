"""READ-ONLY CodeMie plugin toolkit — list, read, recursive list, search. Nothing that writes or runs.

The stock `development` toolkit always exposes write, diff-update, git and run-command; an agent the
pipeline grants read-only must not receive those. Built on the codemie-plugins framework (its core
file tools, confined to root_dir by get_validated_relative_path).

    PLUGIN_KEY=<key> PLUGIN_ENGINE_URI=<nats uri> python plugin_ro.py <root_dir>

Started and stopped by lib/codemie-web/plugins.js; never run by hand in a pipeline.
"""
import asyncio
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional, Type

from codemie.client import PluginClient
from codemie.toolkit import RemoteInput, RemoteTool
from pydantic import Field
from toolkits.core.file_system_tools import ListDirectoryTool, ReadFileTool, RecursiveFileRetrieval
from toolkits.core.utils import get_relative_path


class SearchInput(RemoteInput):
    pattern: str = Field(description="Regular expression to search for in file contents")
    dir_path: str = Field(default=".", description="Directory (relative to the root) to search in")


def _git_files(repo: Path, under: Path) -> list:
    """The files git would show for `under` inside `repo`: tracked plus untracked, minus what the
    repository ignores (git's own rules — nothing named here)."""
    out = subprocess.run(["git", "-C", str(under), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                         capture_output=True, check=False)
    return [under / f for f in out.stdout.decode("utf-8", "replace").split("\0") if f]


def _in_work_tree(d: Path) -> bool:
    r = subprocess.run(["git", "-C", str(d), "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True, check=False)
    return r.returncode == 0 and r.stdout.strip() == "true"


def searchable_files(base: Path) -> list:
    """Every file a search should read under `base`. Inside a repository, what git shows; above one
    (an estate of codelines), each repository found is asked the same way."""
    if _in_work_tree(base):
        return sorted(_git_files(base, base))
    files = []
    for entry in sorted(base.iterdir()):
        if entry.is_dir():
            files.extend(searchable_files(entry))
        elif entry.is_file():
            files.append(entry)
    return files


def _is_binary(p: Path) -> bool:
    """A NUL byte in the first 8000 bytes — the test git itself applies."""
    try:
        with open(p, "rb") as fh:
            return b"\0" in fh.read(8000)
    except OSError:
        return True


class SearchFilesTool(RemoteTool):
    """Search file contents under the root for a regular expression; returns path:line: text matches."""

    name: str = "search_files"
    description: str = "Search file contents (regular expression) under a directory of the repository, as git sees it (ignored and binary files are not read). Read-only."
    args_schema: Type[RemoteInput] = SearchInput
    root_dir: Optional[str] = "."
    max_matches: int = int(os.environ.get("EPAM_CODEMIE_SEARCH_MAX_MATCHES", "0") or 0)

    def _run(self, pattern: str, dir_path: str = ".", *args, **kwargs) -> str:
        base = Path(get_relative_path(self.root_dir, dir_path))
        root = Path(self.root_dir).resolve()
        rx = re.compile(pattern)
        out, more = [], 0
        for p in searchable_files(base):
            if not p.is_file() or _is_binary(p):
                continue
            try:
                for n, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
                    if rx.search(line):
                        if self.max_matches and len(out) >= self.max_matches:
                            more += 1
                        else:
                            out.append(f"{p.resolve().relative_to(root)}:{n}: {line}")
            except OSError:
                continue
        if more:
            out.append(f"… {more} more match(es) not shown — narrow the pattern or the directory")
        return "\n".join(out) or "no matches"


async def main(root: str):
    root = str(Path(root).resolve())
    tools = [ListDirectoryTool(root_dir=root), RecursiveFileRetrieval(root_dir=root), ReadFileTool(root_dir=root), SearchFilesTool(root_dir=root)]
    await PluginClient(tools=tools).connect()


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit("usage: plugin_ro.py <root_dir>")
    asyncio.run(main(sys.argv[1]))
