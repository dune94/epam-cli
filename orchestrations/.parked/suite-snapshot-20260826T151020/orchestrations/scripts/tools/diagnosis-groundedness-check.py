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

    # THE JUDGE GOES THROUGH THE CENTRAL HANDLER, LIKE EVERY OTHER CALL.
    #
    # This constructed deepeval's OpenRouterModel from OPENROUTER_API_KEY and defaulted the
    # judge to the literal "openai/gpt-4o-mini" — a second channel with its own credential and
    # its own vendor, so a run on any other provider set still judged via OpenRouter. Worse,
    # the free-run scrub writes a placeholder key that is TRUTHY, so the `if not key: skip`
    # guard below passed and the vendor was called anyway.
    #
    # The handler resolves vendor, model and credential from the active provider set. This file
    # names none of them.
    judge_model = os.environ.get("DEEPEVAL_JUDGE_MODEL", "").strip() or os.environ.get("EPAM_MODEL", "").strip()
    if not judge_model:
        print(json.dumps({"skipped": True, "reason": "no judge model resolved from the seam ladder or DEEPEVAL_JUDGE_MODEL"}))
        return

    judge_provider = (os.environ.get("EPAM_ORCHESTRATION_PROVIDER", "")
                      or os.environ.get("AI_PROVIDER", "")).strip()
    if not judge_provider:
        print(json.dumps({"skipped": True, "reason": "no provider configured — the provider set supplies EPAM_ORCHESTRATION_PROVIDER"}))
        return

    try:
        from deepeval.metrics import GEval
        from deepeval.test_case import LLMTestCase, LLMTestCaseParams
        from deepeval.models import DeepEvalBaseLLM
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"deepeval not available: {e}"}))
        return

    import subprocess

    hub = os.environ.get("EPAM_LLM_HUB") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "llm-handler.sh")
    if not os.path.exists(hub):
        print(json.dumps({"skipped": True, "reason": f"llm handler not found at {hub}"}))
        return

    class _HubModel(DeepEvalBaseLLM):
        """deepeval talks to the pipeline's one handler, not to a vendor SDK."""

        def __init__(self, model_name, provider, hub_path):
            self._name = model_name
            self._provider = provider
            self._hub = hub_path
            super().__init__(model_name)

        def load_model(self):
            return None

        def generate(self, prompt: str, *args, **kwargs) -> str:
            timeout_s = int(os.environ.get("DIAGNOSIS_JUDGE_TIMEOUT_SECS", "120"))
            proc = subprocess.run(
                ["bash", self._hub, "--provider", self._provider, "--model", self._name],
                input=prompt, capture_output=True, text=True, timeout=timeout_s,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"llm handler exited {proc.returncode}: {(proc.stderr or '').strip()[:300]}")
            out = (proc.stdout or "").strip()
            # An empty answer is a FAILURE, never a quiet zero. A groundedness gate that scores
            # silence would pass exactly the diagnoses it exists to catch.
            if not out:
                raise RuntimeError("llm handler returned an empty response")
            return out

        async def a_generate(self, prompt: str, *args, **kwargs) -> str:
            return self.generate(prompt, *args, **kwargs)

        def get_model_name(self):
            return self._name

    try:
        resolved_model = _HubModel(judge_model, judge_provider, hub)
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"could not construct the judge model: {e}"}))
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
