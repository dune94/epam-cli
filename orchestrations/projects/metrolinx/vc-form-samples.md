EXAMPLES OF FORM (the angle-bracket words are placeholders — fill them from THIS story; never copy them literally):

REJECTED: "the <config object> passed to <the client> includes a <key> entry"
  — asserts INTERNAL STRUCTURE. A tester cannot see a config object.
ACCEPTED: "when <the request> carries <the marker>, <the surface> shows <the draft state> instead of <the published state>"

REJECTED: "when <internal function> is called with <argument>, the resulting <query> includes <field>"
  — asserts an INTERNAL CALL PATH. Verify the surface the ticket is about, not the path behind it.
ACCEPTED: "<the surface> shows <the value> that <the source of truth> currently holds"

REJECTED: "an author edits <entity> in <the external tool> and <the surface> updates"
  — begins OUTSIDE THE BOUNDARY this suite can drive. Nothing here can operate that tool.
ACCEPTED: "given <the client> is mocked to signal <the change>, <the surface> re-renders without a reload"

REJECTED: "<the value> matches what <the other place> shows"
  — a CROSS-COMPARISON presumes a shared derivation. Assert the required value on its own.
ACCEPTED: "<the surface> shows <the expected value> for <the stated condition>"

REJECTED: "<the feature> works correctly with no regression"
  — verifies nothing and cannot fail.
ACCEPTED: "when <the feature> is inactive, <the surface> shows <the prior behaviour> unchanged"
