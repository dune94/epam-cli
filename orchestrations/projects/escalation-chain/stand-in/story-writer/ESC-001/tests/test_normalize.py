from esc.normalize import normalize


def test_normalize_strips_surrounding_whitespace():
    assert normalize("  Bob  ").strip() == normalize("  Bob  ")
