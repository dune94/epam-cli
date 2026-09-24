from esc.greet import greet
from esc.registry import register


# The registry keys a greeting exactly as greet() produced it.
def test_a_greeting_registers_under_its_normalised_key():
    assert register(greet(" Bob ")) == "hello bob"
