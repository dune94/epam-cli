"""The shared name normaliser."""


def normalize(name: str) -> str:
    """Return the name without surrounding whitespace."""
    return name.strip()
