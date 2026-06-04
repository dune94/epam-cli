#!/usr/bin/env python3
"""
calibrate.py — Update calibration.json from phase-cost.jsonl actuals.

Reads completed story actuals, groups by effort:storyType, computes
exponentially-weighted running means, and writes calibration.json.
The CPA reads this file to replace hand-entered formula estimates with
empirically grounded baselines before calling Claude for inference.

Usage:
  python3 calibrate.py [--cost-log path] [--cal-file path] [--decay 0.85]

Options:
  --cost-log FILE    phase-cost.jsonl path (default: ../logs/phase-cost.jsonl)
  --cal-file FILE    calibration.json path (default: ../logs/calibration.json)
  --decay FLOAT      EMA decay factor 0–1; higher = older data weighted more
                     (default: 0.85)
  --min-n INT        Min samples required to emit a calibrated category (default: 3)
  --show             Print calibration table to stdout and exit (no writes)
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
LOG_DIR = SCRIPT_DIR.parent / "logs"

# ---------------------------------------------------------------------------
# Model pricing table (USD per 1K tokens, as of 2025)
# Used to compute cost when total_cost_usd is 0 (SDK path doesn't expose cost)
# ---------------------------------------------------------------------------
MODEL_PRICING = {
    # Haiku 4.5
    "claude-haiku-4-5":            {"in": 0.00025,  "out": 0.00125},
    "claude-haiku-4-5-20251001":   {"in": 0.00025,  "out": 0.00125},
    # Sonnet 4.5 / 4.6
    "claude-sonnet-4-5":           {"in": 0.003,    "out": 0.015},
    "claude-sonnet-4-5-20250929":  {"in": 0.003,    "out": 0.015},
    "claude-sonnet-4-6":           {"in": 0.003,    "out": 0.015},
    # Opus 4.6
    "claude-opus-4-6":             {"in": 0.015,    "out": 0.075},
}

def compute_cost(tokens_in: int, tokens_out: int, model: str) -> float:
    """Return estimated cost in USD from token counts and model pricing."""
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        # Fallback: sonnet pricing for unknown models
        pricing = {"in": 0.003, "out": 0.015}
    return (tokens_in / 1000) * pricing["in"] + (tokens_out / 1000) * pricing["out"]


def parse_args():
    p = argparse.ArgumentParser(description="Calibrate CPA estimates from actuals")
    p.add_argument("--cost-log", default=str(LOG_DIR / "phase-cost.jsonl"))
    p.add_argument("--cal-file", default=str(LOG_DIR / "calibration.json"))
    p.add_argument("--decay", type=float, default=0.85,
                   help="EMA decay; higher = trust older data more (default: 0.85)")
    p.add_argument("--min-n", type=int, default=3,
                   help="Min samples to emit calibrated category (default: 3)")
    p.add_argument("--show", action="store_true",
                   help="Print calibration table to stdout, no writes")
    return p.parse_args()


def load_jsonl_multiline(path):
    """Parse a file of concatenated JSON objects (single-line or pretty-printed)."""
    records = []
    try:
        with open(path) as f:
            content = f.read()
    except FileNotFoundError:
        return records

    # Try single-line JSONL first
    for line in content.splitlines():
        line = line.strip()
        if line and line.startswith("{"):
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    if records:
        return records

    # Fallback: concatenated multi-line JSON objects
    decoder = json.JSONDecoder()
    pos = 0
    content = content.strip()
    while pos < len(content):
        while pos < len(content) and content[pos] in " \t\n\r":
            pos += 1
        if pos >= len(content):
            break
        try:
            obj, end = decoder.raw_decode(content, pos)
            records.append(obj)
            pos = end
        except json.JSONDecodeError:
            break

    return records


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ---------------------------------------------------------------------------
# EMA accumulator
# ---------------------------------------------------------------------------

class EMACategory:
    """Exponentially weighted moving average for a single effort:storyType category."""

    def __init__(self, decay: float):
        self.decay = decay
        self.n = 0
        self.ema_minutes = 0.0
        self.ema_tokens = 0.0
        self.ema_cost = 0.0
        self.ema_turns = 0.0
        # Welford-style variance tracking (unweighted, for reporting)
        self._sum_minutes = 0.0
        self._sum_sq_minutes = 0.0
        self._sum_cost = 0.0
        self._sum_sq_cost = 0.0

    def update(self, minutes: float, tokens: int, cost: float, turns: int):
        self.n += 1
        if self.n == 1:
            self.ema_minutes = minutes
            self.ema_tokens = float(tokens)
            self.ema_cost = cost
            self.ema_turns = float(turns)
        else:
            d = self.decay
            self.ema_minutes = d * self.ema_minutes + (1 - d) * minutes
            self.ema_tokens  = d * self.ema_tokens  + (1 - d) * tokens
            self.ema_cost    = d * self.ema_cost    + (1 - d) * cost
            self.ema_turns   = d * self.ema_turns   + (1 - d) * turns

        self._sum_minutes += minutes
        self._sum_sq_minutes += minutes * minutes
        self._sum_cost += cost
        self._sum_sq_cost += cost * cost

    def variance_minutes(self):
        if self.n < 2:
            return 0.0
        mean = self._sum_minutes / self.n
        return max(0.0, self._sum_sq_minutes / self.n - mean * mean)

    def variance_cost(self):
        if self.n < 2:
            return 0.0
        mean = self._sum_cost / self.n
        return max(0.0, self._sum_sq_cost / self.n - mean * mean)

    def to_dict(self, updated_at: str):
        return {
            "n": self.n,
            "mean_minutes": self.ema_minutes,
            "mean_cost": self.ema_cost,
            "mean_tokens": self.ema_tokens,
            "mean_turns": self.ema_turns,
            "var_minutes": self.variance_minutes(),
            "var_cost": self.variance_cost(),
            "updatedAt": updated_at,
        }


# ---------------------------------------------------------------------------
# Main calibration logic
# ---------------------------------------------------------------------------

def compute_pipeline_overhead_ratio(records) -> float:
    """
    Compute the ratio of pipeline agent cost to story implementation cost.
    Returns 1.0 if insufficient data (safe default — no overhead added).
    pipeline_overhead_ratio = 1 + (pipeline_cost / story_cost)
    e.g. ratio=1.53 means total cost = story_cost * 1.53
    """
    story_cost = sum(
        float(r.get("task_cost_usd") or 0)
        for r in records
        if r.get("status") == "completed" and not r.get("agent_type") and float(r.get("task_cost_usd") or 0) > 0
    )
    pipeline_cost = sum(
        float(r.get("task_cost_usd") or 0)
        for r in records
        if r.get("agent_type") and float(r.get("task_cost_usd") or 0) > 0
    )
    if story_cost <= 0:
        return 1.0
    return 1.0 + (pipeline_cost / story_cost)


def build_calibration(records, decay, min_n):
    categories: dict[str, EMACategory] = {}

    for r in records:
        if r.get("status") != "completed":
            continue
        if r.get("agent_type"):
            continue  # skip pipeline records — they don't belong in story calibration buckets

        effort = r.get("effort") or "medium"
        stype = r.get("storyType") or "implementation"
        # invokeMode added in calibration improvement pass; infer for older records
        invoke_mode = r.get("invokeMode")
        if not invoke_mode:
            # Heuristic: SDK runs are single-turn with low token counts
            turns = int(r.get("task_turns") or 0)
            tokens = int(r.get("task_tokens_in") or 0) + int(r.get("task_tokens_out") or 0)
            invoke_mode = "sdk" if (turns <= 1 and tokens < 10_000) else "cli"
        # Model alias — short canonical name used as 4th key segment so that
        # Haiku and Sonnet calibrations never share a bucket.
        model = r.get("resolvedModel") or ""
        if "haiku" in model:
            model_alias = "haiku"
        elif "opus" in model:
            model_alias = "opus"
        elif "sonnet" in model:
            model_alias = "sonnet"
        else:
            model_alias = "sonnet"  # safe default for unknown models

        # 4-part key: effort:storyType:invokeMode:modelAlias
        key = f"{effort}:{stype}:{invoke_mode}:{model_alias}"

        minutes = float(r.get("elapsed_minutes") or 0)
        tokens_in = int(r.get("task_tokens_in") or 0)
        tokens_out = int(r.get("task_tokens_out") or 0)
        tokens = tokens_in + tokens_out
        cost = float(r.get("task_cost_usd") or 0)
        # SDK path reports cost=0; derive from token counts + model pricing
        if cost == 0 and tokens > 0:
            cost = compute_cost(tokens_in, tokens_out, r.get("resolvedModel") or "")
        turns = int(r.get("task_turns") or 0)

        # Skip obviously broken records
        if minutes <= 0 and tokens == 0:
            continue

        if key not in categories:
            categories[key] = EMACategory(decay)
        categories[key].update(minutes, tokens, cost, turns)

    now = datetime.now(timezone.utc).isoformat()
    return {
        key: cat.to_dict(now)
        for key, cat in categories.items()
        if cat.n >= min_n
    }


def merge_with_existing(new_cats, existing):
    """
    Merge new EMA categories with existing calibration.json.
    For categories in new_cats, overwrite. Keep old categories not in new_cats.
    """
    merged = dict(existing.get("categories", {}))
    merged.update(new_cats)
    return merged


def print_table(categories):
    if not categories:
        print("No calibrated categories (need >= min-n completed stories per category).")
        return

    header = f"{'Category':<36} {'n':>4}  {'Min (EMA)':>10}  {'Tokens (EMA)':>14}  {'Cost (EMA)':>12}  {'Turns':>6}"
    print(header)
    print("-" * len(header))
    for key, c in sorted(categories.items()):
        print(f"{key:<36} {c['n']:>4}  {c['mean_minutes']:>10.2f}  "
              f"{c['mean_tokens']:>14,.0f}  ${c['mean_cost']:>11.4f}  {c['mean_turns']:>6.1f}")


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def main():
    args = parse_args()

    records = load_jsonl_multiline(args.cost_log)
    if not records:
        print(f"calibrate.py: no records found in {args.cost_log}", file=sys.stderr)
        sys.exit(0)

    completed = [r for r in records if r.get("status") == "completed"]
    print(f"calibrate.py: {len(completed)} completed records across {len(records)} total", file=sys.stderr)

    new_cats = build_calibration(records, args.decay, args.min_n)

    if args.show:
        print_table(new_cats)
        return

    existing = load_json(args.cal_file)
    merged = merge_with_existing(new_cats, existing)

    pipeline_ratio = compute_pipeline_overhead_ratio(records)
    # EMA blend with existing ratio (or use computed if no prior)
    existing_ratio = existing.get("pipeline_overhead_ratio", 1.0)
    if existing_ratio == 1.0:
        blended_ratio = pipeline_ratio  # first measurement
    else:
        blended_ratio = args.decay * existing_ratio + (1 - args.decay) * pipeline_ratio

    print(f"calibrate.py: pipeline overhead ratio = {pipeline_ratio:.3f} (blended: {blended_ratio:.3f})", file=sys.stderr)

    output = {
        "version": existing.get("version", 1),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "decay": args.decay,
        "pipeline_overhead_ratio": round(blended_ratio, 4),
        "categories": merged,
    }

    write_atomic(args.cal_file, output)
    print(f"calibrate.py: wrote {len(merged)} categories to {args.cal_file}", file=sys.stderr)
    print_table(new_cats)


if __name__ == "__main__":
    main()
