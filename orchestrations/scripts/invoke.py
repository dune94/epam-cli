#!/usr/bin/env python3
"""
invoke.py — Anthropic SDK invocation shim for EPAM CLI orchestration.

Replaces the 'claude CLI --print --output-format json' call when
EPAM_SDK_INVOKE=1 is set. Reads prompt from stdin, calls the Anthropic
API, writes a normalized JSON result file, and exits 0 (success) or 1 (fail).

Output schema (identical to claude CLI --output-format json):
{
  "result": "<text response>",
  "total_cost_usd": 0.0123,
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 800,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  },
  "num_turns": 1
}

Usage:
  echo "prompt text" | python3 invoke.py \\
      --output /path/to/result.json \\
      [--model claude-sonnet-4-6] \\
      [--max-tokens 8192] \\
      [--thinking-budget 5000] \\
      [--count-tokens-only]

Flags:
  --output FILE          Required. Path to write normalized JSON result.
  --model NAME           Model ID (default: claude-sonnet-4-6).
  --max-tokens N         Max output tokens (default: 8192).
  --thinking-budget N    Enable extended thinking with N budget tokens.
                         Only valid with claude-sonnet-4-5+ / opus-4+.
  --count-tokens-only    Run count_tokens() pre-check, print count to stdout,
                         and exit 0. Does not call the API. Useful for model
                         routing decisions in bash.
  --stream               Stream response to stderr for live visibility
                         (result JSON still written to --output on completion).
  --cache-system         Mark system prompt block with cache_control ephemeral.

Environment:
  ANTHROPIC_API_KEY      Required. Must be set before calling this script.
"""

import argparse
import json
import os
import sys


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="Anthropic SDK invocation shim")
    p.add_argument("--output", required=True, help="Path to write normalized JSON result")
    p.add_argument("--model", default="claude-sonnet-4-6", help="Model ID")
    p.add_argument("--max-tokens", type=int, default=8192, dest="max_tokens")
    p.add_argument("--thinking-budget", type=int, default=0, dest="thinking_budget",
                   help="Extended thinking token budget (0 = disabled)")
    p.add_argument("--count-tokens-only", action="store_true", dest="count_tokens_only",
                   help="Run token count pre-check only, print count, exit 0")
    p.add_argument("--stream", action="store_true",
                   help="Stream response text to stderr for live visibility")
    p.add_argument("--cache-system", action="store_true", dest="cache_system",
                   help="Apply prompt caching to system prompt block")
    return p.parse_args()


# ---------------------------------------------------------------------------
# SDK bootstrap — clear error if not installed
# ---------------------------------------------------------------------------

def import_sdk():
    try:
        import anthropic
        return anthropic
    except ImportError:
        print(
            "ERROR: 'anthropic' package not found.\n"
            "Run: pip install -r orchestrations/scripts/requirements.txt\n"
            "Or:  pip install anthropic",
            file=sys.stderr,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Build messages array from stdin prompt
# ---------------------------------------------------------------------------

def build_messages(prompt_text, cache_system):
    """
    Returns (system_block_or_None, messages_list).
    System block is used for static context that benefits from caching.
    For now all content goes into the user message.
    cache_system flag is reserved for future use when callers pass a
    separate system prompt via env var or stdin prefix convention.
    """
    messages = [{"role": "user", "content": prompt_text}]
    return None, messages


# ---------------------------------------------------------------------------
# Token counting pre-check
# ---------------------------------------------------------------------------

def count_tokens(client, model, system, messages):
    kwargs = {"model": model, "messages": messages}
    if system:
        kwargs["system"] = system
    response = client.messages.count_tokens(**kwargs)
    return response.input_tokens


# ---------------------------------------------------------------------------
# Main invocation — standard (non-streaming)
# ---------------------------------------------------------------------------

def invoke_standard(client, model, system, messages, max_tokens, thinking_budget):
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if system:
        kwargs["system"] = system
    if thinking_budget and thinking_budget > 0:
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}

    response = client.messages.create(**kwargs)
    return response


# ---------------------------------------------------------------------------
# Main invocation — streaming
# ---------------------------------------------------------------------------

def invoke_streaming(client, model, system, messages, max_tokens, thinking_budget):
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if system:
        kwargs["system"] = system
    if thinking_budget and thinking_budget > 0:
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}

    collected_text = []
    usage_data = {}

    with client.messages.stream(**kwargs) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True, file=sys.stderr)
            collected_text.append(text)
        # Final message has full usage stats
        final = stream.get_final_message()
        usage_data = final.usage
        stop_reason = final.stop_reason

    print("", file=sys.stderr)  # newline after streamed output
    return "".join(collected_text), usage_data, stop_reason


# ---------------------------------------------------------------------------
# Extract text result from response content blocks
# ---------------------------------------------------------------------------

def extract_result_text(content):
    """Extract plain text from response content blocks (skips thinking blocks)."""
    parts = []
    for block in content:
        if hasattr(block, "type") and block.type == "text":
            parts.append(block.text)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Build normalized output JSON (matches claude CLI --output-format json)
# ---------------------------------------------------------------------------

def build_output(result_text, usage, num_turns=1):
    return {
        "result": result_text,
        "total_cost_usd": 0,        # SDK does not expose cost directly; bash reads from usage
        "usage": {
            "input_tokens": getattr(usage, "input_tokens", 0),
            "output_tokens": getattr(usage, "output_tokens", 0),
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0),
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0),
        },
        "num_turns": num_turns,
    }


def build_output_from_streaming(result_text, usage_data, num_turns=1):
    return {
        "result": result_text,
        "total_cost_usd": 0,
        "usage": {
            "input_tokens": getattr(usage_data, "input_tokens", 0),
            "output_tokens": getattr(usage_data, "output_tokens", 0),
            "cache_creation_input_tokens": getattr(usage_data, "cache_creation_input_tokens", 0),
            "cache_read_input_tokens": getattr(usage_data, "cache_read_input_tokens", 0),
        },
        "num_turns": num_turns,
    }


# ---------------------------------------------------------------------------
# Write result JSON atomically
# ---------------------------------------------------------------------------

def write_result(output_path, data):
    tmp_path = output_path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, output_path)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    prompt_text = sys.stdin.read()
    if not prompt_text.strip():
        print("ERROR: Empty prompt received on stdin.", file=sys.stderr)
        sys.exit(1)

    anthropic = import_sdk()
    client = anthropic.Anthropic(api_key=api_key)

    system, messages = build_messages(prompt_text, args.cache_system)

    # ── Token count pre-check (no generation) ──────────────────────────────
    if args.count_tokens_only:
        try:
            count = count_tokens(client, args.model, system, messages)
            print(count)
            sys.exit(0)
        except Exception as e:
            print(f"ERROR: Token count failed: {e}", file=sys.stderr)
            sys.exit(1)

    # ── Main invocation ─────────────────────────────────────────────────────
    try:
        if args.stream:
            result_text, usage_data, _ = invoke_streaming(
                client, args.model, system, messages,
                args.max_tokens, args.thinking_budget
            )
            output = build_output_from_streaming(result_text, usage_data)
        else:
            response = invoke_standard(
                client, args.model, system, messages,
                args.max_tokens, args.thinking_budget
            )
            result_text = extract_result_text(response.content)
            output = build_output(result_text, response.usage)

        write_result(args.output, output)
        sys.exit(0)

    except anthropic.APIStatusError as e:
        print(f"ERROR: Anthropic API error {e.status_code}: {e.message}", file=sys.stderr)
        sys.exit(1)
    except anthropic.APIConnectionError as e:
        print(f"ERROR: Anthropic API connection error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: invoke.py unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
