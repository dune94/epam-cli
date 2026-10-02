"""READ-ONLY CodeMie plugin toolkit — list, read, recursive list, search. Nothing that writes or runs.

The stock `development` toolkit always exposes write, diff-update, git and run-command; an agent the
pipeline grants read-only must not receive those. Built on the codemie-plugins framework (its core
file tools, confined to root_dir by get_validated_relative_path).

Hosted by plugin_host.py (`ro` mode), which plugins.js (this directory) starts and stops; never run by
hand in a pipeline.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional, Type

from codemie.toolkit import RemoteInput, RemoteTool


def plugin_label(root: str) -> str:
    """The label a plugin answers to: its root folder's name, made safe for CodeMie's addressing.

    CodeMie sends a tool request to "<key>.<session>.<label>.<tool>" and splits it on dots, so a label
    with a dot is never matched — every tool call to such a codeline's plugin was refused
    "Invalid label" (AMSD-2974, 2026-10-01). Anything but letters, digits, "_" and "-" becomes "-".
    """
    return re.sub(r"[^A-Za-z0-9_-]", "-", os.path.basename(os.path.normpath(root))) or "root"
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


def _rel(p: Path, root: Path) -> str:
    """`p` relative to the root BY ITS OWN NAME — a link is not followed (a codeline's virtualenv
    links its interpreter out of the root, and resolving it named a path outside)."""
    return str(Path(os.path.abspath(p)).relative_to(root))


def _inside(p: Path, root: Path) -> bool:
    """Whether what `p` really is lies under the root — a read never follows a link out of it."""
    try:
        p.resolve().relative_to(root)
        return True
    except ValueError:
        return False


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
            if not p.is_file() or not _inside(p, root) or _is_binary(p):
                continue
            try:
                for n, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
                    if rx.search(line):
                        if self.max_matches and len(out) >= self.max_matches:
                            more += 1
                        else:
                            out.append(f"{_rel(p, root)}:{n}: {line}")
            except OSError:
                continue
        if more:
            out.append(f"… {more} more match(es) not shown — narrow the pattern or the directory")
        return "\n".join(out) or "no matches"


class GitFileList(RecursiveFileRetrieval):
    """The library's recursive listing (its name, description and input), answered with the files a
    search reads: what git shows. The library walks every file and logs the whole list — over an
    estate of codelines that is every node_modules and .git: the plugin grew past the run's memory
    bound and the kernel killed the run (live AMSD-2974, 2026-09-30)."""

    def _run(self, dir_path: str = ".", *args, **kwargs) -> str:
        try:
            base = Path(get_relative_path(self.root_dir, dir_path))
        except Exception:
            return f"Invalid dir_path: {dir_path}"
        root = Path(self.root_dir).resolve()
        files = [_rel(p, root) for p in searchable_files(base) if p.is_file() or p.is_symlink()]
        return "\n".join(files) or f"No files found in directory {dir_path}"


# ── THE PIPELINE'S OWN TOOLS, hosted here ───────────────────────────────────────────────────────
# A ToolPlugin module (orchestrations/plugins/*.js) is the one implementation of a pipeline tool. The
# runner declares which ones this plugin hosts (hostedToolPlugins) and passes their paths in
# EPAM_CODEMIE_HOSTED_TOOLS; each tool keeps its own name, description and input schema, and every
# call is executed by its own `execute`, from this plugin's root. Nothing about a tool is written here.

_LIST_JS = """const p = require(process.argv[1]);
process.stdout.write(JSON.stringify((p.tools || []).map((t) => ({ name: t.name, description: t.description || (t.definition && t.definition.description) || '', permission: t.permission,
  schema: (t.definition && t.definition.inputSchema) || t.inputSchema || { type: 'object', properties: {} } }))));"""
_EXEC_JS = """const p = require(process.argv[1]); const t = (p.tools || []).find((x) => x.name === process.argv[2]);
Promise.resolve(t.execute(JSON.parse(process.argv[3]))).then((r) => process.stdout.write(JSON.stringify(r || {})),
  (e) => process.stdout.write(JSON.stringify({ content: String(e && e.message || e), isError: true })));"""
_JSON_TYPES = {"string": str, "integer": int, "number": float, "boolean": bool}


def _node() -> str:
    return os.environ.get("NODE_BIN") or "node"


def _hosted_tool(module: str, spec: dict, root: str):
    from pydantic import create_model
    props = (spec.get("schema") or {}).get("properties") or {}
    required = set((spec.get("schema") or {}).get("required") or [])
    fields = {}
    for key, p in props.items():
        typ = _JSON_TYPES.get(p.get("type"), str)
        desc = p.get("description", "")
        fields[key] = (typ, Field(..., description=desc)) if key in required else (Optional[typ], Field(None, description=desc))
    args_model = create_model(f"{spec['name']}_Input", __base__=RemoteInput, **fields)

    def _run(self, *args, **kwargs) -> str:
        payload = {k: v for k, v in kwargs.items() if v is not None and k in props}
        r = subprocess.run([_node(), "-e", _EXEC_JS, module, spec["name"], json.dumps(payload)],
                           cwd=root, capture_output=True, text=True, check=False)
        try:
            res = json.loads(r.stdout or "{}")
        except ValueError:
            return f"Error: {spec['name']} produced no result ({(r.stderr or '').strip()[:300]})"
        text = str(res.get("content", ""))
        return f"Error: {text}" if res.get("isError") and not text.startswith("Error") else text

    cls = type(f"Hosted_{spec['name']}", (RemoteTool,), {
        "__module__": __name__,
        "__annotations__": {"name": str, "description": str, "args_schema": Type[RemoteInput]},
        "name": spec["name"], "description": spec.get("description", ""), "args_schema": args_model, "_run": _run,
    })
    return cls()


def hosted_tools(root: str) -> list:
    """Every tool of every ToolPlugin module the runner declared for this plugin to host — in a
    read-only plugin (EPAM_CODEMIE_HOSTED_SAFE_ONLY), only those whose own permission is 'safe'."""
    modules = json.loads(os.environ.get("EPAM_CODEMIE_HOSTED_TOOLS") or "[]")
    safe_only = os.environ.get("EPAM_CODEMIE_HOSTED_SAFE_ONLY") == "1"
    out = []
    for module in modules:
        listed = subprocess.run([_node(), "-e", _LIST_JS, module], capture_output=True, text=True, check=True)
        for spec in json.loads(listed.stdout or "[]"):
            if safe_only and spec.get("permission") != "safe":
                continue
            out.append(_hosted_tool(module, spec, root))
    return out


def ro_tools(root: str) -> list:
    """The read-only toolkit rooted at `root` (plugin_host.py runs it)."""
    root = str(Path(root).resolve())
    return [ListDirectoryTool(root_dir=root), GitFileList(root_dir=root), ReadFileTool(root_dir=root), SearchFilesTool(root_dir=root)]
