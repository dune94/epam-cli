from esc.greet import greet


def test_greet_prefixes_hello():
    assert greet("bob") == "hello bob"
