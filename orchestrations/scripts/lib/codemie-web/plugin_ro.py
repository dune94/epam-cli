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


class SearchFilesTool(RemoteTool):
    """Search file contents under the root for a regular expression; returns path:line: text matches."""

    name: str = "search_files"
    description: str = "Search file contents (regular expression) under a directory of the repository. Read-only."
    args_schema: Type[RemoteInput] = SearchInput
    root_dir: Optional[str] = "."
    max_matches: int = 200

    def _run(self, pattern: str, dir_path: str = ".", *args, **kwargs) -> str:
        base = get_relative_path(self.root_dir, dir_path)
        rx = re.compile(pattern)
        out = []
        for p in sorted(Path(base).rglob("*")):
            if len(out) >= self.max_matches:
                break
            if not p.is_file() or any(part in {".git", "node_modules"} for part in p.parts):
                continue
            try:
                for n, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
                    if rx.search(line):
                        out.append(f"{p.relative_to(Path(self.root_dir).resolve())}:{n}: {line[:300]}")
                        if len(out) >= self.max_matches:
                            break
            except OSError:
                continue
        return "\n".join(out) or "no matches"


async def main(root: str):
    root = str(Path(root).resolve())
    tools = [ListDirectoryTool(root_dir=root), RecursiveFileRetrieval(root_dir=root), ReadFileTool(root_dir=root), SearchFilesTool(root_dir=root)]
    await PluginClient(tools=tools).connect()


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit("usage: plugin_ro.py <root_dir>")
    asyncio.run(main(sys.argv[1]))
