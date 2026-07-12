#!/usr/bin/env python3
"""Advisory groundedness check on the FailureAnalyst's own diagnosis, using
DeepEval's GEval metric as an LLM judge.

Augments self-healing (2026-07-12): the failure-analyst produces a one-
sentence diagnosis of why a story's test run failed, which then drives real
actions (PRD/TC patches, skill notes, KB writes, model-tier escalation via
SyntaxClassEscalation). A live incident already on record for this pipeline
(see claude.sh's dependency-contract-injection comment, ~line 3680) showed
the analyst confidently asserting a root cause that was flatly wrong ("default
vs named export mismatch" for what was actually a casing typo) -- every
retry then "fixed" the wrong thing because the diagnosis guiding it was
false. This script gives that diagnosis a second, independent LLM-judge pass
BEFORE it's trusted: is every claim in the diagnosis actually supported by
concrete evidence (an error message, stack trace line, file/line reference)
in the real failure log, or did the model state a plausible-sounding but
ungrounded root cause?

Scope (intentionally narrow, per 2026-07-12 design decision): advisory/
logged only for now -- this does NOT gate or change control flow. It exists
to measure how often the failure-analyst's diagnoses are actually grounded,
so a future decision to make this blocking is backed by real data, not
guesswork. The broader "prompt-tooling effectiveness" evaluation (G-Eval/
DeepEval/Arize Phoenix across the whole pipeline) remains a separate,
larger backlog item -- this script only covers the single highest-value
narrow case: the failure-analyst's diagnosis.

Usage:
    echo '{"diagnosis": "...", "log_excerpt": "...", "story_id": "SKY-004"}' \
        | .venv-deepeval/bin/python diagnosis-groundedness-check.py

Output (always valid JSON on stdout, always exit 0 -- this is advisory
tooling and must never be able to break the calling pipeline):
    {"skipped": true, "reason": "..."}                              -- on any
        setup problem (missing API key, deepeval import failure, etc.)
    {"skipped": false, "score": 0.0-1.0, "verdict": "grounded"|
        "ungrounded", "reason": "<judge's explanation>"}             -- on a
        real, completed evaluation
"""
import json
import sys


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"could not parse input JSON: {e}"}))
        return

    diagnosis = (payload.get("diagnosis") or "").strip()
    log_excerpt = (payload.get("log_excerpt") or "").strip()

    if not diagnosis or not log_excerpt:
        print(json.dumps({"skipped": True, "reason": "diagnosis or log_excerpt missing/empty"}))
        return

    import os

    # OpenRouter only, by design: this pipeline already routes its own gate/
    # QA agents through OpenRouter-backed models (qwen/z-ai) rather than
    # OpenAI or Anthropic directly (see .env: "Orchestration gate agents: use
    # Qwen for all pipeline/QA agents (no Anthropic/OpenAI key needed)") --
    # this judge should follow the same provider policy rather than
    # introducing a second, independent API-key dependency.
    judge_model = os.environ.get("DEEPEVAL_JUDGE_MODEL", "").strip() or "openai/gpt-4o-mini"

    try:
        from deepeval.metrics import GEval
        from deepeval.test_case import LLMTestCase, LLMTestCaseParams
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"deepeval not available: {e}"}))
        return

    openrouter_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("EPAM_API_KEY_OPENROUTER")
    if not openrouter_key:
        print(json.dumps({"skipped": True, "reason": "no OPENROUTER_API_KEY available for the judge model"}))
        return

    try:
        from deepeval.models import OpenRouterModel

        resolved_model = OpenRouterModel(model=judge_model, api_key=openrouter_key)
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"could not construct OpenRouter judge model: {e}"}))
        return

    try:
        metric = GEval(
            name="DiagnosisGroundedness",
            criteria=(
                "Determine whether every factual claim in 'actual_output' (a "
                "root-cause diagnosis of a test failure) is explicitly "
                "supported by concrete evidence -- a specific error message, "
                "stack trace line, or file/line reference -- present in "
                "'context' (the real failure log). A diagnosis that asserts "
                "a root cause, mechanism, or file not evidenced anywhere in "
                "the context should score low, even if it sounds plausible."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT, LLMTestCaseParams.CONTEXT],
            model=resolved_model,
            threshold=0.5,
        )
        test_case = LLMTestCase(
            input="Diagnose the root cause of this test failure.",
            actual_output=diagnosis,
            context=[log_excerpt[:6000]],
        )
        metric.measure(test_case)
        print(
            json.dumps(
                {
                    "skipped": False,
                    "score": metric.score,
                    "verdict": "grounded" if metric.score >= metric.threshold else "ungrounded",
                    "reason": metric.reason,
                }
            )
        )
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"deepeval evaluation failed: {e}"}))


if __name__ == "__main__":
    main()
