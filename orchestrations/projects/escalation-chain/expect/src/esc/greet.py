"""Greetings."""
from esc.normalize import normalize


def greet(name: str) -> str:
    """Return the greeting for a name, normalised by the shared normaliser."""
    return "hello " + normalize(name)
