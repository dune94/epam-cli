import sys
import json, os, sys

effort      = sys.argv[6]
base_cost   = float(sys.argv[4] or 0)
mean_tokens = int(float(sys.argv[1] or 0))
base_model  = sys.argv[2]

# ── Escalation rate priors (from calibration.json) ───────────────────────────
try:
    cal = json.load(open(sys.argv[5]))
    r = cal.get("escalationRates", {}).get(effort, {})
except Exception:
    r = {}

p_r2       = r.get("p_rung2",  0.10)
p_r3       = r.get("p_rung3",  0.030)
p_k3       = r.get("p_k3",     0.005)
self_heal_p= r.get("selfHealP",0.25)

# ── Ladder models, read from the DECLARED chain ───────────────────────────────
# No model name appears here. Every rung is whatever the chain declares, walked in order, and an
# undeclared chain yields no rungs rather than invented ones.
#
# What stood here named four models outright and read the HIGH chain regardless of the tier the
# story's agent declares. This block PRICES escalation, and its output feeds the cost-variance
# gate — so a fabricated rung produced a confident forecast for models the run would never use,
# and the gate then judged real spend against it.
rung2_model = os.environ.get("ESCALATION_MODEL", "")
rung3_model = os.environ.get("ESCALATION_MODEL_HIGH", "")
gate_model  = os.environ.get("ORCH_GATE_MODEL", "")

# The chain for THIS story's tier; falls back to the run's chain, never to a named tier.
_chain = os.environ.get("EPAM_MODEL_LADDER", "")
_tier  = (os.environ.get("EPAM_STORY_LADDER_TIER", "") or "").upper()
if _tier:
    _chain = os.environ.get("EPAM_MODEL_LADDER_" + _tier, _chain)

_hops = {}
for pair in _chain.split("|"):
    if "=" in pair:
        _from, _to = pair.split("=", 1)
        _hops[_from.strip()] = _to.strip()

# Walk from the rung below to find the one above it. Absent stays absent.
if not rung2_model:
    rung2_model = _hops.get(gate_model, "")
if not rung3_model:
    rung3_model = _hops.get(rung2_model, "")
k3_model = _hops.get(rung3_model, "")

# ── Model pricing ─────────────────────────────────────────────────────────────
try:
    pricing = json.load(open(sys.argv[3] + "/model-pricing.json"))
except Exception:
    pricing = {}

def get_price(model):
    # AN UNPRICED MODEL IS FREE, NOT A CRASH.
    #
    # Two ways this aborted the whole cost profile. An unresolved rung arrives as "", and
    # `"" in anything` is True, so the fuzzy pass matched the FIRST key in the file. And the
    # pricing map carries "_comment"-style documentation keys whose values are strings, so
    # that match then called .get() on a str and raised AttributeError. The traceback went to
    # stderr, the caller read empty stdout, and every story was contextualized with no model
    # profile at all — silently, because a missing profile looks the same as a cheap one.
    if not model:
        return 0.0, 0.0
    priced = {k: v for k, v in pricing.items() if isinstance(v, dict)}
    p = priced.get(model)
    if not p:
        ml = model.lower()
        for k, v in priced.items():
            if k.lower() == ml or k.lower() in ml or ml in k.lower():
                p = v; break
    if not isinstance(p, dict):
        return 0.0, 0.0
    return float(p.get("input", 0)), float(p.get("output", 0))

def rung_cost(model, tok_in, tok_out):
    inp, out = get_price(model)
    return (tok_in * inp + tok_out * out) / 1_000_000

# Token estimate: assume 80/20 in/out split
tok_in  = int(mean_tokens * 0.80) if mean_tokens > 0 else 40_000
tok_out = int(mean_tokens * 0.20) if mean_tokens > 0 else 10_000

cost_r2_attempt  = rung_cost(rung2_model, tok_in, tok_out)
cost_r3_attempt  = rung_cost(rung3_model, tok_in, tok_out)
cost_k3_attempt  = rung_cost(k3_model,    tok_in, tok_out)

# Analyst/self-heal: gate model on ~150K in / 5K out (typical failure analysis)
cost_per_heal = rung_cost(gate_model, 150_000, 5_000)

# Expected attempts per rung before escalating (empirical: ~1.5 at each mid-rung)
avg_r2 = 1.5; avg_r3 = 1.5; avg_k3 = 2.0

exp_r2_cost   = p_r2 * avg_r2 * cost_r2_attempt
exp_r3_cost   = p_r3 * avg_r3 * cost_r3_attempt
exp_k3_cost   = p_k3 * avg_k3 * cost_k3_attempt
exp_heal_cost = self_heal_p * cost_per_heal
esc_cost      = exp_r2_cost + exp_r3_cost + exp_k3_cost
exp_retries   = p_r2 * avg_r2 + p_r3 * avg_r3 + p_k3 * avg_k3

out = {
    "modelProfile": {
        "rung1": {"model": base_model,  "p_resolves": round(1 - p_r2, 3),
                  "expectedCost": round(base_cost, 4)},
        "rung2": {"model": rung2_model, "p_reached": round(p_r2, 3),
                  "costPerAttempt": round(cost_r2_attempt, 4),
                  "expectedCost":   round(exp_r2_cost, 4)},
        "rung3": {"model": rung3_model, "p_reached": round(p_r3, 3),
                  "costPerAttempt": round(cost_r3_attempt, 4),
                  "expectedCost":   round(exp_r3_cost, 4)},
        "k3":    {"model": k3_model,    "p_reached": round(p_k3, 3),
                  "costPerAttempt": round(cost_k3_attempt, 4),
                  "expectedCost":   round(exp_k3_cost, 4)}
    },
    "expectedRetries":  round(exp_retries,   2),
    "selfHealP":        round(self_heal_p,   2),
    "selfHealCost":     round(exp_heal_cost, 4),
    "escalationCost":   round(esc_cost,      4),
    "totalStoryCost":   round(base_cost + esc_cost + exp_heal_cost, 4)
}
print(json.dumps(out))
