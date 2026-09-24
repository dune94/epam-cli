from esc.greet import greet
from esc.registry import register


def test_a_greeting_registers_under_its_normalised_key():
    assert register(greet(" Bob ")) == "hello bob"
