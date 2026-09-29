"""THE HOST OF ONE CODEMIE PLUGIN — either toolkit, and ready when it says so.

    PLUGIN_KEY=<key> PLUGIN_ENGINE_URI=<nats uri> python plugin_host.py <ro|rw> <root_dir> <ready_file>
    python plugin_host.py --check      exit 0 when this interpreter can host both toolkits (pre-flight)

    ro  plugin_ro.py's tools (list, recursive list, read, search) — nothing that writes or runs
    rw  the codemie-plugins development toolkit's tools, built as `codemie-plugins development run`
        builds them (FileSystemAndCommandToolkit, labelled by the root's basename, its command timeout)

The caller (plugins.js) waits on a FILE, not on the library's console prose: <ready_file> is written
({"tools": n}) the moment the plugin engine's subjects are subscribed — the library's own success
point (NatsClient._subscribe) — and <ready_file>.failed ({"error": <exception type>}) when the host
fails before or instead of that. Started and stopped by plugins.js; never run by hand in a pipeline.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

import codemie.client as plugin_client
from codemie.nats_client import NatsClient


def _write(path: str, value: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def _signalling_client(ready_file: str):
    class SignallingNatsClient(NatsClient):
        async def _subscribe(self):
            await super()._subscribe()
            _write(ready_file, {"tools": len(self.tools)})
    return SignallingNatsClient


def _tools(mode: str, root: str) -> tuple:
    if mode == "ro":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from plugin_ro import ro_tools
        return ro_tools(root), None
    if mode == "rw":
        from toolkits.development.toolkit import FileSystemAndCommandToolkit
        os.environ["PLUGIN_LABEL"] = os.path.basename(root)
        return FileSystemAndCommandToolkit().get_tools(root), int(os.getenv("COMMAND_LINE_TOOL_TIMEOUT", "300"))
    raise ValueError(f"unknown plugin mode '{mode}'")


async def main(mode: str, root: str, ready_file: str) -> None:
    root = str(Path(root).resolve())
    # The signal is raised on the protocol the library uses by default; the legacy one has no
    # subscription point to signal from, so it is not the pipeline's to choose.
    os.environ.pop("LEGACY_PROTOCOL", None)
    plugin_client.NatsClient = _signalling_client(ready_file)
    tools, timeout = _tools(mode, root)
    client = plugin_client.PluginClient(tools=tools, **({"timeout": timeout} if timeout else {}))
    await client.connect()


def check() -> None:
    """Build both toolkits once, connecting nothing: what hosting needs, asked of this interpreter."""
    _signalling_client(os.devnull)
    for mode in ("ro", "rw"):
        _tools(mode, str(Path(__file__).resolve().parent))


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        check()
        sys.exit(0)
    if len(sys.argv) != 4 or not os.path.isdir(sys.argv[2]):
        sys.exit("usage: plugin_host.py <ro|rw> <root_dir> <ready_file>")
    _ready = sys.argv[3]
    try:
        asyncio.run(main(sys.argv[1], sys.argv[2], _ready))
    except KeyboardInterrupt:
        pass
    except BaseException as e:  # the caller is told the failure's type; its words stay in the log
        _write(f"{_ready}.failed", {"error": type(e).__name__})
        raise
